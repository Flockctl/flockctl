// ─── /wakeups route tests ───
//
// The audit flagged `src/routes/wakeups.ts` at 8% line coverage despite
// being a critical user-facing surface. This file pins the route-layer
// contract:
//
//   • GET /wakeups         — filter by chat_id / task_id / status / limit;
//                            validates each param and rejects malformed
//                            input with 422 (regression for the silent
//                            `WHERE col = NaN` shape we just fixed in
//                            `chats/crud.ts`).
//   • GET /wakeups/:id     — single read; 404 on miss; 422 on missing
//                            segment.
//   • POST /wakeups/from-hook — body validation: requires exactly one of
//                            chat_id / task_id; non-empty
//                            claude_session_id and prompt; non-negative
//                            delay_seconds; optional reason. Returns 201
//                            with the inserted row.
//   • POST /wakeups/:id/fire   — only pending → fired transitions;
//                            422 on terminal status.
//   • POST /wakeups/:id/cancel — idempotent on non-pending status (no
//                            422 on double-cancel; just returns the
//                            row). Pending → cancelled.
//
// Mocks ws-manager so broadcast() doesn't need a live WebSocket fan-out.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";

vi.mock("../../services/ws-manager.js", () => ({
  wsManager: {
    broadcastWakeupStatus: vi.fn(),
  },
}));

import { wakeupRoutes } from "../../routes/wakeups.js";
import { AppError } from "../../lib/errors.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let app: Hono;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  // Mount the router at root and wire the global error handler so
  // ValidationError / NotFoundError surface as 422 / 404 instead of 500.
  app = new Hono();
  app.route("/wakeups", wakeupRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      // Mirror production `server.ts::onError` shape so tests assert
      // against the same payload format the real client sees.
      return c.json({ error: err.message, details: err.details }, err.statusCode as any);
    }
    return c.json({ error: "internal" }, 500);
  });
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  // Wipe between cases so list/filter expectations don't bleed.
  sqlite.exec(`DELETE FROM scheduled_wakeups; DELETE FROM chats;`);
});

/** Seed a chat row so wakeups.chat_id FK resolves. */
function seedChat(sessionId = `cs-${Date.now()}-${Math.random()}`): number {
  const res = sqlite
    .prepare(`INSERT INTO chats (claude_session_id) VALUES (?)`)
    .run(sessionId);
  return Number(res.lastInsertRowid);
}

describe("POST /wakeups/from-hook — body validation", () => {
  it("creates a pending wakeup row and returns 201", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "cs-1",
        delay_seconds: 60,
        prompt: "wake up and continue",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; chatId: number; prompt: string };
    expect(body.status).toBe("pending");
    expect(body.chatId).toBe(chatId);
    expect(body.prompt).toBe("wake up and continue");
  });

  it("rejects body that isn't a JSON object", async () => {
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '"not an object"',
    });
    expect(res.status).toBe(422);
  });

  it("rejects when neither chat_id nor task_id is provided", async () => {
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claude_session_id: "cs-1",
        delay_seconds: 1,
        prompt: "x",
      }),
    });
    expect(res.status).toBe(422);
    // Zod refinement attaches the cross-field error to `chat_id` (the
    // first field in the XOR). Asserting against the details payload
    // is more brittle than the old "match against the error string"
    // shape, but it's also more honest — the API contract is the
    // structured details object, not the human-readable summary.
    const body = (await res.json()) as { error: string; details?: Record<string, string[]> };
    expect(body.error).toBe("invalid body");
    expect(JSON.stringify(body.details)).toMatch(/chat_id \/ task_id/);
  });

  it("rejects when both chat_id and task_id are set", async () => {
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: 1,
        task_id: 1,
        claude_session_id: "cs-1",
        delay_seconds: 1,
        prompt: "x",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details?: Record<string, string[]> };
    expect(body.error).toBe("invalid body");
    expect(JSON.stringify(body.details)).toMatch(/exactly one/);
  });

  it("rejects negative delay_seconds", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "cs-1",
        delay_seconds: -1,
        prompt: "x",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details?: Record<string, string[]> };
    expect(body.error).toBe("invalid body");
    expect(JSON.stringify(body.details)).toMatch(/delay_seconds/);
  });

  it("rejects empty claude_session_id", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "",
        delay_seconds: 1,
        prompt: "x",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects empty prompt", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "cs-1",
        delay_seconds: 1,
        prompt: "",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("accepts optional reason as null", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "cs-1",
        delay_seconds: 1,
        prompt: "x",
        reason: null,
      }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects non-string reason", async () => {
    const chatId = seedChat();
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: "cs-1",
        delay_seconds: 1,
        prompt: "x",
        reason: 42,
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe("GET /wakeups — list + filter", () => {
  async function record(chatId: number, prompt = "p"): Promise<string> {
    const res = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        claude_session_id: `cs-${prompt}`,
        delay_seconds: 0,
        prompt,
      }),
    });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("returns 200 with empty items when no rows exist", async () => {
    const res = await app.request("/wakeups");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("filters by chat_id", async () => {
    const chatA = seedChat();
    const chatB = seedChat();
    await record(chatA, "a1");
    await record(chatA, "a2");
    await record(chatB, "b1");

    const res = await app.request(`/wakeups?chat_id=${chatA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ chatId: number }> };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((r) => r.chatId === chatA)).toBe(true);
  });

  it("rejects malformed chat_id with 422", async () => {
    const res = await app.request("/wakeups?chat_id=abc");
    expect(res.status).toBe(422);
  });

  it("rejects negative chat_id with 422", async () => {
    const res = await app.request("/wakeups?chat_id=-3");
    expect(res.status).toBe(422);
  });

  it("rejects unknown status value with 422", async () => {
    const res = await app.request("/wakeups?status=zombie");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status must be one of/);
  });

  it("filters by status=pending", async () => {
    const chat = seedChat();
    await record(chat);
    const res = await app.request("/wakeups?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ status: string }> };
    expect(body.items.every((r) => r.status === "pending")).toBe(true);
  });

  it("rejects malformed limit with 422", async () => {
    const res = await app.request("/wakeups?limit=0");
    expect(res.status).toBe(422);
  });
});

describe("GET /wakeups/:id", () => {
  it("returns 404 for unknown id", async () => {
    const res = await app.request("/wakeups/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns the row when present", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-x",
        delay_seconds: 0,
        prompt: "test",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/wakeups/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe("pending");
  });
});

describe("POST /wakeups/:id/fire", () => {
  it("returns 404 when wakeup does not exist", async () => {
    const res = await app.request("/wakeups/does-not-exist/fire", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("transitions a pending row to fired", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-fire",
        delay_seconds: 0,
        prompt: "p",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const fireRes = await app.request(`/wakeups/${id}/fire`, { method: "POST" });
    expect(fireRes.status).toBe(200);
    const fired = (await fireRes.json()) as { status: string };
    expect(fired.status).toBe("fired");
  });

  it("rejects double-fire (422 because already non-pending)", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-double",
        delay_seconds: 0,
        prompt: "p",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    await app.request(`/wakeups/${id}/fire`, { method: "POST" });
    const second = await app.request(`/wakeups/${id}/fire`, { method: "POST" });
    expect(second.status).toBe(422);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/cannot fire wakeup in status=fired/);
  });
});

describe("POST /wakeups/:id/cancel", () => {
  it("returns 404 when wakeup does not exist", async () => {
    const res = await app.request("/wakeups/does-not-exist/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("transitions a pending row to cancelled", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-cancel",
        delay_seconds: 0,
        prompt: "p",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(`/wakeups/${id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });

  /*
   * Idempotency contract: cancel of a non-pending row returns the row
   * unchanged with 200 (NOT 422), because operator double-clicks on a
   * row that the worker just fired shouldn't surface a confusing error.
   */
  it("is idempotent on already-fired rows (returns 200, not 422)", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-idem",
        delay_seconds: 0,
        prompt: "p",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    await app.request(`/wakeups/${id}/fire`, { method: "POST" });
    const cancelRes = await app.request(`/wakeups/${id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    const body = (await cancelRes.json()) as { status: string };
    expect(body.status).toBe("fired"); // unchanged from fire transition
  });

  it("is idempotent on already-cancelled rows", async () => {
    const chat = seedChat();
    const created = await app.request("/wakeups/from-hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        claude_session_id: "cs-cdup",
        delay_seconds: 0,
        prompt: "p",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    await app.request(`/wakeups/${id}/cancel`, { method: "POST" });
    const second = await app.request(`/wakeups/${id}/cancel`, { method: "POST" });
    expect(second.status).toBe(200);
  });
});
