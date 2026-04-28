/**
 * Route tests for POST /chats/:id/question/:requestId/answer.
 *
 * Mirrors the structure of `tasks-questions-extra.test.ts` (the M05 task
 * variant of the same endpoint) and exercises the chat-side answer route end
 * to end:
 *   - request validation (path + body)
 *   - DB lookup gating (chat, agent_question, status)
 *   - chat-executor delegation (mocked: chats have no on-disk session in
 *     unit-test space, so we replicate the real DB transition + WS
 *     broadcast inside the spy)
 *   - WS attention_changed broadcast
 *   - remote-auth gating (401 path)
 *
 * The 403_cross_owner_idor case is intentionally `it.skip`'d: the chats
 * schema currently has no `owner_id` column and bearer tokens grant
 * un-scoped access, so the IDOR contract has no implementation to gate.
 * The placeholder is left in so the next pass of M05 can wire it up
 * without re-discovering the gap.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats as chatsTable, agentQuestions } from "../../db/schema.js";
import { wsManager } from "../../services/ws-manager.js";
import * as config from "../../config/index.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";

// AgentRegistry is consulted on chat reads/updates (cost estimation, session
// rename). Stub it out so tests don't reach into the real Anthropic stack.
vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

describe("POST /chats/:id/question/:requestId/answer", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let chatA: number;
  let chatB: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    testDb.db.delete(agentQuestions).run();
    testDb.db.delete(chatsTable).run();
    _resetRateLimiter();

    // Two chats so cross-chat / IDOR-shaped lookups have somewhere to land.
    chatA = testDb.db
      .insert(chatsTable)
      .values({ title: "ownerA-chat" })
      .returning()
      .get()!.id;
    chatB = testDb.db
      .insert(chatsTable)
      .values({ title: "ownerB-chat" })
      .returning()
      .get()!.id;

    testDb.db
      .insert(agentQuestions)
      .values({
        requestId: "req-1",
        chatId: chatA,
        toolUseId: "tu-req-1",
        question: "what color do you want?",
        status: "pending",
      })
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── helpers ────────────────────────────────────────────────────────────
  async function postAnswer(
    chatId: number | string,
    requestId: string,
    body: unknown,
    init: { headers?: Record<string, string>; remoteIp?: string } = {},
  ): Promise<Response> {
    const reqInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    if (init.remoteIp) {
      return app.request(
        `/chats/${chatId}/question/${requestId}/answer`,
        reqInit,
        { incoming: { socket: { remoteAddress: init.remoteIp } } },
      );
    }
    return app.request(`/chats/${chatId}/question/${requestId}/answer`, reqInit);
  }

  /**
   * Replace `chatExecutor.answerQuestion` with a stub that performs the same
   * observable side-effects as the real implementation: flips the
   * agent_questions row to status='answered', stamps `answer` + `answered_at`,
   * and broadcasts the attention_changed WS event. Returning `true` makes the
   * route's success branch fire.
   */
  async function spyAnswerSucceeds(): Promise<void> {
    const { chatExecutor } = await import("../../services/chat-executor.js");
    vi.spyOn(chatExecutor, "answerQuestion").mockImplementation(
      (cId: number, rId: string, ans: string): boolean => {
        const row = testDb.db
          .select()
          .from(agentQuestions)
          .where(eq(agentQuestions.requestId, rId))
          .get();
        if (!row || row.chatId !== cId || row.status !== "pending") return false;
        testDb.db
          .update(agentQuestions)
          .set({
            answer: ans,
            status: "answered",
            answeredAt: new Date().toISOString(),
          })
          .where(eq(agentQuestions.id, row.id))
          .run();
        wsManager.broadcastAll({ type: "attention_changed", payload: {} });
        return true;
      },
    );
  }

  // ─── tests ──────────────────────────────────────────────────────────────

  it("happy", async () => {
    await spyAnswerSucceeds();

    const res = await postAnswer(chatA, "req-1", { answer: "blue" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; chatStatus: unknown };
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("chatStatus"); // null until requiresApproval flips it

    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.status).toBe("answered");
    expect(row?.answer).toBe("blue");
  });

  it("emits_attention_changed", async () => {
    await spyAnswerSucceeds();

    const received: Array<Record<string, unknown>> = [];
    const ws = {
      send: (msg: string) => received.push(JSON.parse(msg)),
      readyState: 1,
    };
    wsManager.addGlobalChatClient(ws as never);

    try {
      const res = await postAnswer(chatA, "req-1", { answer: "blue" });
      expect(res.status).toBe(200);

      const types = received.map((m) => m.type);
      expect(types).toContain("attention_changed");
    } finally {
      wsManager.removeClient(ws as never);
    }
  });

  it("404_unknown_chat", async () => {
    const res = await postAnswer(999_999, "req-1", { answer: "blue" });
    expect(res.status).toBe(404);
  });

  it("404_unknown_request_id", async () => {
    const res = await postAnswer(chatA, "bogus-req-id", { answer: "blue" });
    expect(res.status).toBe(404);
  });

  it("409_already_answered", async () => {
    await spyAnswerSucceeds();

    const r1 = await postAnswer(chatA, "req-1", { answer: "blue" });
    expect(r1.status).toBe(200);

    const r2 = await postAnswer(chatA, "req-1", { answer: "red" });
    expect(r2.status).toBe(409);

    // Original answer was preserved.
    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.answer).toBe("blue");
  });

  it("400_missing_answer_field", async () => {
    const res = await postAnswer(chatA, "req-1", {});
    expect(res.status).toBe(400);
  });

  it("400_answer_too_long", async () => {
    // The route schema caps `answer` at max(8000), so 10001 chars is
    // unambiguously over the limit and the body validator returns 400.
    const res = await postAnswer(chatA, "req-1", { answer: "x".repeat(10_001) });
    expect(res.status).toBe(400);
  });

  it("401_no_token", async () => {
    // Force remote-auth on, simulate a non-localhost client, omit the
    // Authorization header → middleware returns 401 before the route runs.
    vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
    vi.spyOn(config, "findMatchingToken").mockReturnValue(null);

    const res = await postAnswer(
      chatA,
      "req-1",
      { answer: "blue" },
      { remoteIp: "203.0.113.7" },
    );
    expect(res.status).toBe(401);

    // Pending row was not touched.
    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.status).toBe("pending");
    expect(row?.answer).toBeNull();
  });

  // The chats table has no `owner_id` column — bearer tokens are not scoped
  // to a per-chat owner, so the cross-owner IDOR contract has no
  // implementation to gate against. Skipped (not deleted) so M05 follow-up
  // work has a parking spot for the test once chat-level ACLs land.
  it.skip("403_cross_owner_idor", async () => {
    // Future shape:
    //   1. Seed ownerA + ownerB tokens in remote-auth config.
    //   2. POST to ownerA's chat with ownerB's bearer → expect 403.
    //   3. Re-read agent_questions row → status still 'pending', answer null.
    expect(true).toBe(true);
  });

  it("no_sql_injection", async () => {
    await spyAnswerSucceeds();

    const before = testDb.db
      .select({ c: sql<number>`count(*)` })
      .from(chatsTable)
      .get();

    const evil = "'); DROP TABLE chats; --";
    const res = await postAnswer(chatA, "req-1", { answer: evil });
    expect(res.status).toBe(200);

    // chats table still exists with the same row count.
    const after = testDb.db
      .select({ c: sql<number>`count(*)` })
      .from(chatsTable)
      .get();
    expect(after?.c).toBe(before?.c);

    // Literal payload landed in the answer column verbatim.
    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.answer).toBe(evil);
  });

  it("single_space", async () => {
    await spyAnswerSucceeds();

    // Schema is z.string().min(1).max(8000) — a single space has length 1
    // and is intentionally accepted (the /answer route does NOT trim, unlike
    // the short-form variant).
    const res = await postAnswer(chatA, "req-1", { answer: " " });
    expect(res.status).toBe(200);

    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.answer).toBe(" ");
  });

  it("unicode/emoji/newlines", async () => {
    await spyAnswerSucceeds();

    const txt = "line1\nline2 🦆 こんにちは";
    const res = await postAnswer(chatA, "req-1", { answer: txt });
    expect(res.status).toBe(200);

    const row = testDb.db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1"))
      .get();
    expect(row?.answer).toBe(txt);
  });

  // Sanity: the second chat we seed for the IDOR placeholder is referenced so
  // TypeScript doesn't flag it as unused, and so that any future cross-chat
  // assertion has a known target chat id.
  it("seeds two distinct chats", () => {
    expect(chatA).not.toBe(chatB);
    const rows = testDb.db.select().from(chatsTable).all();
    expect(rows.length).toBe(2);
  });
});
