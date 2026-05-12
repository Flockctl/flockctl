import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, chats as chatsTable } from "../../db/schema.js";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";

// Mock key selection — only `selectKeyForTask` matters for the chat send
// path. `resolveAllowedKeyIds` stays REAL so the workspace-only branch we
// just added is exercised end-to-end against the real DB.
vi.mock("../../services/ai/key-selection", async () => {
  const actual = await vi.importActual<any>("../../services/ai/key-selection");
  return {
    ...actual,
    selectKeyForTask: vi.fn().mockResolvedValue({
      id: 1,
      provider: "anthropic",
      keyValue: "sk-test",
      providerType: "api-key",
    }),
  };
});

let db: FlockctlDb;
let sqlite: Database.Database;
let allowedKeyId: number;
let outsiderKeyId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  // One key the workspace permits, one it doesn't — the rejection test
  // wants to prove the whitelist actually filters, not just that it
  // exists. Both seeded once and reused across describe blocks.
  allowedKeyId = seedActiveKey(sqlite, { label: "ws-allowed", priority: 1 });
  outsiderKeyId = seedActiveKey(sqlite, { label: "ws-outsider", priority: 2 });
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM chats; DELETE FROM workspaces;`);
});

/**
 * Integration test for the workspace-only chat creation path.
 *
 * Before the fix: `POST /chats { workspaceId }` always persisted with
 * `aiProviderKeyId: NULL`, regardless of whether the workspace had a strict
 * whitelist configured. The whitelist was also not enforced when the
 * caller passed an explicit `aiProviderKeyId` in the body.
 *
 * After the fix: workspace-only chats get the same auto-fill + whitelist
 * enforcement that project-scoped chats have always gotten.
 */
describe("POST /chats — workspace-only chat key resolution", () => {
  it("auto-fills aiProviderKeyId from the workspace whitelist when none is passed", async () => {
    // Mint a workspace via direct DB insert (the route requires a real
    // path on disk; this test pins behaviour at the chat layer, not the
    // workspace layer).
    const ws = db
      .insert(workspaces)
      .values({
        name: "ws-allowed-only",
        path: "/tmp/ws-allowed-only-" + Date.now(),
        allowedKeyIds: JSON.stringify([allowedKeyId]),
      } as any)
      .returning()
      .get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: ws.id,
        title: `Workspace: ${ws.name}`,
      }),
    });

    expect(res.status).toBe(201);
    const chat = await res.json();
    // The pre-fix bug surface: aiProviderKeyId was NULL even when the
    // workspace had a whitelist with exactly one obvious choice.
    expect(chat.aiProviderKeyId).toBe(allowedKeyId);
    expect(chat.workspaceId).toBe(ws.id);
    expect(chat.projectId).toBeNull();
  });

  it("still persists aiProviderKeyId=NULL when workspace has no whitelist", async () => {
    // Unrestricted scope — keep the legacy "NULL on create" contract so
    // downstream code that uses NULL as a "resolve-at-send-time" sentinel
    // continues to work and existing clients/tests don't break.
    const ws = db
      .insert(workspaces)
      .values({
        name: "ws-open",
        path: "/tmp/ws-open-" + Date.now(),
      } as any)
      .returning()
      .get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: ws.id }),
    });

    expect(res.status).toBe(201);
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBeNull();
  });

  it("rejects an explicit aiProviderKeyId outside the workspace whitelist", async () => {
    const ws = db
      .insert(workspaces)
      .values({
        name: "ws-strict",
        path: "/tmp/ws-strict-" + Date.now(),
        allowedKeyIds: JSON.stringify([allowedKeyId]),
      } as any)
      .returning()
      .get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: ws.id,
        aiProviderKeyId: outsiderKeyId,
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    // Error must scope to "workspace" (not "project") and point at the
    // workspace PATCH endpoint — otherwise the hint sends the user to
    // the wrong screen.
    expect(body.error).toMatch(/this chat's workspace/);
    expect(body.error).toMatch(/PATCH \/workspaces/);
    // Sanity: nothing was inserted.
    const chatCount = db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(eq(chatsTable.workspaceId, ws.id))
      .all().length;
    expect(chatCount).toBe(0);
  });

  it("accepts an explicit aiProviderKeyId that is in the workspace whitelist", async () => {
    const ws = db
      .insert(workspaces)
      .values({
        name: "ws-strict-ok",
        path: "/tmp/ws-strict-ok-" + Date.now(),
        allowedKeyIds: JSON.stringify([allowedKeyId]),
      } as any)
      .returning()
      .get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: ws.id,
        aiProviderKeyId: allowedKeyId,
      }),
    });

    expect(res.status).toBe(201);
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBe(allowedKeyId);
  });
});

/**
 * Mirror of `GET /projects/:id/allowed-keys`. Without this endpoint the UI
 * can't filter the chat key picker for workspace-only chats, so the bug
 * would resurface at the dropdown level even after the backend was fixed.
 */
describe("GET /workspaces/:id/allowed-keys", () => {
  it("returns { allowedKeyIds: null, source: 'none' } when not configured", async () => {
    const ws = db
      .insert(workspaces)
      .values({
        name: "open",
        path: "/tmp/open-" + Date.now(),
      } as any)
      .returning()
      .get()!;
    const res = await app.request(`/workspaces/${ws.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("none");
    expect(body.allowedKeyIds).toBeNull();
  });

  it("returns the parsed array with source='workspace' when configured", async () => {
    const ws = db
      .insert(workspaces)
      .values({
        name: "strict",
        path: "/tmp/strict-" + Date.now(),
        allowedKeyIds: JSON.stringify([allowedKeyId, 9000]),
      } as any)
      .returning()
      .get()!;
    const res = await app.request(`/workspaces/${ws.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The route emits camelCase JSON directly (no snake_case conversion
    // at the server layer). apiFetch on the UI side handles that mapping
    // — mirror the assertion shape used by the project endpoint tests.
    expect(body.source).toBe("workspace");
    expect(body.allowedKeyIds).toEqual([allowedKeyId, 9000]);
  });

  it("returns 404 for an unknown workspace id", async () => {
    const res = await app.request("/workspaces/999999/allowed-keys");
    expect(res.status).toBe(404);
  });
});
