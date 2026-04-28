// Additional route tests for chat-question endpoints other than /answer.
//
// The peer file `chats-questions.test.ts` covers POST /chats/:id/question/
// :requestId/answer end-to-end. This file fills in the *other* three
// routes registered by `registerChatQuestions`:
//
//   • GET  /chats/:id/pending-questions
//   • POST /chats/:id/question/:requestId       (short-form non-/answer variant)
//   • GET  /chats/:id/questions
//
// Without these, src/routes/chats/questions.ts sits at 46% branches —
// dragging the global threshold below 95%.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats as chatsTable, agentQuestions } from "../../db/schema.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

describe("chat questions — auxiliary routes", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let chatA: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    testDb.db.delete(agentQuestions).run();
    testDb.db.delete(chatsTable).run();
    _resetRateLimiter();
    chatA = testDb.db
      .insert(chatsTable)
      .values({ title: "test-chat" })
      .returning()
      .get()!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── GET /chats/:id/pending-questions ─────────────────────────────────
  describe("GET /chats/:id/pending-questions", () => {
    it("returns the chatExecutor.pendingQuestions list", async () => {
      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      const stub = vi
        .spyOn(chatExecutor, "pendingQuestions")
        .mockReturnValue([
          { requestId: "req-x", question: "color?", askedAt: 0 } as never,
        ]);

      const res = await app.request(`/chats/${chatA}/pending-questions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
      expect(stub).toHaveBeenCalledWith(chatA);
    });

    it("404 when the chat is unknown", async () => {
      const res = await app.request(`/chats/999999/pending-questions`);
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /chats/:id/question/:requestId (short-form, non-/answer) ────
  describe("POST /chats/:id/question/:requestId", () => {
    it("422 when answer field is missing (ValidationError)", async () => {
      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("422 when answer is whitespace-only (trim → empty)", async () => {
      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "   " }),
      });
      expect(res.status).toBe(422);
    });

    it("422 when answer exceeds 10_000 chars (ValidationError)", async () => {
      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "x".repeat(10_001) }),
      });
      expect(res.status).toBe(422);
    });

    it("404 when chat is unknown", async () => {
      const res = await app.request(`/chats/999999/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "ok" }),
      });
      expect(res.status).toBe(404);
    });

    it("422 (ValidationError) when chat session is not running", async () => {
      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "isRunning").mockReturnValue(false);

      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "ok" }),
      });
      expect(res.status).toBe(422);
    });

    it("404 when answerQuestion returns false (unknown requestId)", async () => {
      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "isRunning").mockReturnValue(true);
      vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(false);

      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "ok" }),
      });
      expect(res.status).toBe(404);
    });

    it("200 ok=true when answerQuestion returns true", async () => {
      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "isRunning").mockReturnValue(true);
      vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(true);

      const res = await app.request(`/chats/${chatA}/question/req-1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "ok" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ─── GET /chats/:id/questions ─────────────────────────────────────────
  describe("GET /chats/:id/questions", () => {
    it("400 when path id is invalid", async () => {
      const res = await app.request(`/chats/not-a-number/questions`);
      expect(res.status).toBe(400);
    });

    it("404 when chat does not exist", async () => {
      const res = await app.request(`/chats/999999/questions`);
      expect(res.status).toBe(404);
    });

    it("200 returns chatExecutor.pendingQuestions", async () => {
      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "pendingQuestions").mockReturnValue([
        { requestId: "abc", question: "?", askedAt: 0 } as never,
      ]);

      const res = await app.request(`/chats/${chatA}/questions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });

  // ─── POST .../answer — exercise some additional branches ──────────────
  describe("POST /chats/:id/question/:requestId/answer — branch fillers", () => {
    it("400 when path :id is non-numeric (zod safeParse fails)", async () => {
      const res = await app.request(
        `/chats/abc/question/req-1/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "ok" }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("400 when body is not valid JSON (collected zod error details)", async () => {
      // The route catches the JSON parse error and feeds {} into safeParse,
      // which fails with a missing-field issue. Exercises the
      // `details` aggregation branch.
      const res = await app.request(`/chats/${chatA}/question/req-1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("404 when answerQuestion returns false AND row recheck is missing", async () => {
      // Seed a pending question, then have answerQuestion return false
      // AFTER deleting the row — so the recheck branch hits "row missing".
      testDb.db
        .insert(agentQuestions)
        .values({
          requestId: "race-1",
          chatId: chatA,
          toolUseId: "tu-race-1",
          question: "race?",
          status: "pending",
        })
        .run();

      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "answerQuestion").mockImplementation(
        (cId: number, rId: string): boolean => {
          // Delete the row to simulate a race: another path removed it
          // between the route's lookup and the executor's flip.
          testDb.db
            .delete(agentQuestions)
            .where(eq(agentQuestions.requestId, rId))
            .run();
          void cId;
          return false;
        },
      );

      const res = await app.request(
        `/chats/${chatA}/question/race-1/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "ok" }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("409 when answerQuestion returns false but the row still exists", async () => {
      testDb.db
        .insert(agentQuestions)
        .values({
          requestId: "race-2",
          chatId: chatA,
          toolUseId: "tu-race-2",
          question: "race?",
          status: "pending",
        })
        .run();

      const { chatExecutor } = await import(
        "../../services/chat-executor.js"
      );
      vi.spyOn(chatExecutor, "answerQuestion").mockReturnValue(false);

      const res = await app.request(
        `/chats/${chatA}/question/race-2/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "ok" }),
        },
      );
      expect(res.status).toBe(409);
    });
  });
});
