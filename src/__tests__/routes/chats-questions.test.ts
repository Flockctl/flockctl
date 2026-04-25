/**
 * Covers the three chats-questions endpoints that the main chats.test.ts
 * suite doesn't exercise:
 *   - GET  /chats/:id/pending-questions
 *   - POST /chats/:id/question/:requestId (the short form w/o /answer)
 *   - POST /chats/:id/question/:requestId/answer — race branch where
 *     chatExecutor.answerQuestion returns false but the row still exists
 *     (409), and where the row disappeared between checks (404).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats as chatsTable, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

describe("Chats — question endpoints (extra coverage)", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    testDb.db.delete(agentQuestions).run();
    testDb.db.delete(chatsTable).run();
  });

  function insertChat(title = "q-chat"): number {
    const row = testDb.db.insert(chatsTable).values({ title }).returning().get();
    return row!.id;
  }

  function insertQuestion(chatId: number, requestId: string, status: "pending" | "answered" | "cancelled" = "pending"): void {
    testDb.db.insert(agentQuestions).values({
      requestId,
      chatId,
      toolUseId: `tu-${requestId}`,
      question: "please clarify",
      status,
      answer: status === "answered" ? "x" : null,
      answeredAt: status === "answered" ? new Date().toISOString() : null,
    }).run();
  }

  describe("GET /chats/:id/pending-questions", () => {
    it("returns pending questions for an existing chat", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-pend-1");
      insertQuestion(chatId, "cq-done-1", "answered");

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const spy = vi
        .spyOn(chatExecutor, "pendingQuestions")
        .mockReturnValue([
          {
            id: 1,
            requestId: "cq-pend-1",
            question: "please clarify",
            toolUseId: "tu-cq-pend-1",
            createdAt: null,
          },
        ]);
      try {
        const res = await app.request(`/chats/${chatId}/pending-questions`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0].requestId).toBe("cq-pend-1");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 for a missing chat", async () => {
      const res = await app.request("/chats/999999/pending-questions");
      expect(res.status).toBe(404);
    });

    it("returns 422 for an invalid :id", async () => {
      const res = await app.request("/chats/not-a-number/pending-questions");
      expect(res.status).toBe(422);
    });
  });

  describe("POST /chats/:id/question/:requestId (short form)", () => {
    async function hit(chatId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/chats/${chatId}/question/${requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 422 when answer is missing / not a string", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-sf-1");
      expect((await hit(chatId, "cq-sf-1", {})).status).toBe(422);
      expect((await hit(chatId, "cq-sf-1", { answer: 42 })).status).toBe(422);
      expect((await hit(chatId, "cq-sf-1", { answer: "   " })).status).toBe(422);
    });

    it("returns 422 for an oversize answer (> 10000 chars)", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-sf-big");
      const res = await hit(chatId, "cq-sf-big", { answer: "x".repeat(10_001) });
      expect(res.status).toBe(422);
    });

    it("returns 422 if the body isn't valid JSON", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-sf-bad");
      const res = await app.request(`/chats/${chatId}/question/cq-sf-bad`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      // JSON.parse failure ⇒ defaults to {} ⇒ answer missing ⇒ 422
      expect(res.status).toBe(422);
    });

    it("returns 404 when the chat does not exist", async () => {
      const res = await hit(999999, "anything", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 422 when the chat exists but no session is running", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-sf-norun");

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const spy = vi.spyOn(chatExecutor, "isRunning").mockReturnValue(false);
      try {
        const res = await hit(chatId, "cq-sf-norun", { answer: "hello" });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error).toMatch(/not running/i);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the session is running but the question is unknown", async () => {
      const chatId = insertChat();

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const runSpy = vi.spyOn(chatExecutor, "isRunning").mockReturnValue(true);
      const ansSpy = vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(false);
      try {
        const res = await hit(chatId, "cq-sf-missing", { answer: "hello" });
        expect(res.status).toBe(404);
      } finally {
        runSpy.mockRestore();
        ansSpy.mockRestore();
      }
    });

    it("returns 200 on successful answer", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-sf-ok");

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const runSpy = vi.spyOn(chatExecutor, "isRunning").mockReturnValue(true);
      const ansSpy = vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(true);
      try {
        const res = await hit(chatId, "cq-sf-ok", { answer: "hello" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(ansSpy).toHaveBeenCalledWith(chatId, "cq-sf-ok", "hello");
      } finally {
        runSpy.mockRestore();
        ansSpy.mockRestore();
      }
    });
  });

  describe("POST /chats/:id/question/:requestId/answer — recheck race branch", () => {
    async function hit(chatId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/chats/${chatId}/question/${requestId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 409 when chatExecutor.answerQuestion=false but row still exists (race: turned into answered)", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-race-409");

      const { chatExecutor } = await import("../../services/chat-executor.js");
      // Simulate race: executor returns false, but the row stays in DB (still
      // pending when we loaded it, but the executor's own recheck would find
      // it already answered / no session). The route re-reads the row and
      // returns 409.
      const spy = vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(false);
      try {
        const res = await hit(chatId, "cq-race-409", { answer: "hi" });
        expect(res.status).toBe(409);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when chatExecutor.answerQuestion=false and the row vanished during the call", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-race-404");

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const spy = vi
        .spyOn(chatExecutor, "answerQuestion")
        .mockImplementation(() => {
          // simulate the row disappearing (e.g. concurrent delete)
          testDb.db
            .delete(agentQuestions)
            .where(eq(agentQuestions.requestId, "cq-race-404"))
            .run();
          return false;
        });
      try {
        const res = await hit(chatId, "cq-race-404", { answer: "hi" });
        expect(res.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 400 for invalid path params (non-numeric id caught by schema)", async () => {
      const res = await app.request("/chats/abc/question/xx/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "hi" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid request body (missing answer)", async () => {
      const chatId = insertChat();
      insertQuestion(chatId, "cq-bad-body");

      const res = await app.request(`/chats/${chatId}/question/cq-bad-body/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});
