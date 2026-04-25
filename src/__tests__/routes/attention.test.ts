import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import * as config from "../../config/index.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";
import type { AttentionItem } from "../../services/attention.js";

function isAttentionItem(x: unknown): x is AttentionItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.since !== "string") return false;
  if (o.kind === "task_approval")
    return typeof o.taskId === "number" && typeof o.projectId === "number" && typeof o.title === "string";
  if (o.kind === "task_permission")
    return (
      typeof o.taskId === "number" &&
      typeof o.projectId === "number" &&
      typeof o.requestId === "string" &&
      typeof o.tool === "string"
    );
  if (o.kind === "chat_permission")
    return typeof o.chatId === "number" && typeof o.requestId === "string" && typeof o.tool === "string";
  return false;
}

describe("GET /attention", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    _resetRateLimiter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
  });

  it("returns 200 with an items array and total count", async () => {
    testDb.db.insert(projects).values({ name: "p" }).run();
    testDb.db
      .insert(tasks)
      .values({ projectId: 1, prompt: "halt me", status: "pending_approval", label: "Review" })
      .run();
    const res = await app.request("/attention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBe(body.items.length);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every(isAttentionItem)).toBe(true);
    expect(body.items[0]).toMatchObject({ kind: "task_approval", projectId: 1, title: "Review" });
  });

  it("returns 401 in remote mode when no bearer token is supplied", async () => {
    vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
    vi.spyOn(config, "findMatchingToken").mockReturnValue(null);
    const res = await app.request(
      "/attention",
      {},
      { incoming: { socket: { remoteAddress: "203.0.113.7" } } },
    );
    expect(res.status).toBe(401);
  });
});
