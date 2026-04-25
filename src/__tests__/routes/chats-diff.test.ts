import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats } from "../../db/schema.js";

/**
 * `GET /chats/:id/diff` mirrors `GET /tasks/:id/diff` — both synthesize a
 * unified diff from the `file_edits` journal column rather than running
 * `git diff`. These tests lock down the response shape and the empty-journal
 * behaviour so the React Query hook (`useChatDiff`) can rely on both.
 */
describe("GET /chats/:id/diff", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => testDb.sqlite.close());

  beforeEach(() => {
    testDb.sqlite.exec("DELETE FROM chats;");
  });

  it("returns 404 when the chat does not exist", async () => {
    const res = await app.request("/chats/9999/diff");
    expect(res.status).toBe(404);
  });

  it("returns an empty payload when the chat has no file_edits journal", async () => {
    const c = testDb.db.insert(chats).values({ title: "empty" }).returning().get()!;
    const res = await app.request(`/chats/${c.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      summary: null,
      diff: "",
      truncated: false,
      total_files: 0,
      total_entries: 0,
    });
  });

  it("synthesizes a unified diff from the journal and reports totals", async () => {
    const journal = {
      version: 1 as const,
      entries: [
        { filePath: "/tmp/a.ts", original: "a\nb\nc", current: "a\nB\nc" },
        { filePath: "/tmp/b.ts", original: "", current: "hello" },
      ],
    };
    const c = testDb.db.insert(chats).values({
      title: "with-edits",
      fileEdits: JSON.stringify(journal),
    } as any).returning().get()!;

    const res = await app.request(`/chats/${c.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total_entries).toBe(2);
    expect(body.total_files).toBe(2);
    expect(body.summary).toMatch(/2 files changed/);
    expect(body.diff).toContain("/tmp/a.ts");
    expect(body.diff).toContain("/tmp/b.ts");
    expect(body.diff).toContain("-b");
    expect(body.diff).toContain("+B");
    expect(body.diff).toContain("+hello");
    expect(body.truncated).toBe(false);
  });

  it("truncates the diff when it exceeds maxLines", async () => {
    // Build a long edit so the synthesized diff has >> maxLines lines.
    const oldLines = Array.from({ length: 50 }, (_, i) => `old-${i}`).join("\n");
    const newLines = Array.from({ length: 50 }, (_, i) => `new-${i}`).join("\n");
    const journal = {
      entries: [{ filePath: "/x.ts", original: oldLines, current: newLines }],
    };
    const c = testDb.db.insert(chats).values({
      title: "big",
      fileEdits: JSON.stringify(journal),
    } as any).returning().get()!;

    const res = await app.request(`/chats/${c.id}/diff?maxLines=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    // Truncated output has exactly `maxLines` lines (joined by \n)
    expect(body.diff.split("\n").length).toBe(10);
    // total_lines reflects the UN-truncated diff length
    expect(body.total_lines).toBeGreaterThan(10);
  });
});
