/**
 * Covers the task-permissions routes not hit by tasks.test.ts or
 * tasks-extra.test.ts:
 *   - GET  /tasks/:id/pending-questions (including 404 for missing task)
 *   - POST /tasks/:id/question/:requestId (the short form)
 *   - POST /tasks/:id/question/:requestId/answer — race branch where
 *     answerQuestion returns false and the row vanished (404)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mock task-executor before importing the server so the route picks up the
// mocked module.
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(),
    cancel: vi.fn(),
    getMetrics: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    resolvePermission: vi.fn(() => true),
    pendingPermissions: vi.fn(() => []),
    pendingQuestions: vi.fn(() => []),
    answerQuestion: vi.fn(() => true),
  },
}));

import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { tasks, projects, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";

describe("Tasks — question endpoints (extra coverage)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    const p = testDb.db.insert(projects).values({ name: "Q Proj" }).returning().get();
    projectId = p!.id;
  });

  afterAll(() => testDb.sqlite.close());

  beforeEach(() => {
    testDb.db.delete(agentQuestions).run();
    testDb.db.delete(tasks).run();
  });

  function insertTask(): number {
    const row = testDb.db
      .insert(tasks)
      .values({ projectId, prompt: "t", status: "waiting_for_input" })
      .returning()
      .get();
    return row!.id;
  }

  function insertQuestion(taskId: number, requestId: string, status: "pending" | "answered" | "cancelled" = "pending"): void {
    testDb.db.insert(agentQuestions).values({
      requestId,
      taskId,
      toolUseId: `tu-${requestId}`,
      question: "please clarify",
      status,
      answer: status === "answered" ? "ok" : null,
      answeredAt: status === "answered" ? new Date().toISOString() : null,
    }).run();
  }

  describe("GET /tasks/:id/pending-questions", () => {
    it("returns 404 for a missing task", async () => {
      const res = await app.request("/tasks/999999/pending-questions");
      expect(res.status).toBe(404);
    });

    it("returns the list from taskExecutor.pendingQuestions", async () => {
      const id = insertTask();
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.pendingQuestions as any).mockReturnValue([
        {
          id: 1,
          requestId: "q-1",
          question: "clarify",
          toolUseId: "tu-1",
          createdAt: null,
        },
      ]);
      const res = await app.request(`/tasks/${id}/pending-questions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].requestId).toBe("q-1");
    });

    it("returns 422 for an invalid :id", async () => {
      const res = await app.request("/tasks/not-a-number/pending-questions");
      expect(res.status).toBe(422);
    });
  });

  describe("POST /tasks/:id/question/:requestId (short form)", () => {
    async function hit(taskId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/tasks/${taskId}/question/${requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 422 when answer is missing / not a string / empty", async () => {
      const id = insertTask();
      expect((await hit(id, "q-x", {})).status).toBe(422);
      expect((await hit(id, "q-x", { answer: "" })).status).toBe(422);
      expect((await hit(id, "q-x", { answer: 42 })).status).toBe(422);
    });

    it("returns 422 for oversize answer (> 10000 chars)", async () => {
      const id = insertTask();
      const res = await hit(id, "q-x", { answer: "x".repeat(10_001) });
      expect(res.status).toBe(422);
    });

    it("handles malformed JSON body as empty body → 422", async () => {
      const id = insertTask();
      const res = await app.request(`/tasks/${id}/question/q-x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(422);
    });

    it("returns 404 when the task does not exist", async () => {
      const res = await hit(999999, "q-x", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the executor reports the question unknown", async () => {
      const id = insertTask();
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.answerQuestion as any).mockReturnValue(false);
      const res = await hit(id, "q-missing", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 200 and { ok: true } on success", async () => {
      const id = insertTask();
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.answerQuestion as any).mockReturnValue(true);
      const res = await hit(id, "q-1", { answer: "hello" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(taskExecutor.answerQuestion).toHaveBeenCalledWith(id, "q-1", "hello");
    });
  });

  describe("POST /tasks/:id/question/:requestId/answer — race + validation branches", () => {
    async function hit(taskId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/tasks/${taskId}/question/${requestId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 400 for invalid path params", async () => {
      const res = await hit("abc", "some-req", { answer: "x" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid body (missing answer)", async () => {
      const id = insertTask();
      insertQuestion(id, "race-1");
      const res = await hit(id, "race-1", {});
      expect(res.status).toBe(400);
    });

    it("returns 409 when executor=false and row still pending (race) — recheck still finds row", async () => {
      const id = insertTask();
      insertQuestion(id, "race-409");
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.answerQuestion as any).mockReturnValue(false);
      const res = await hit(id, "race-409", { answer: "hi" });
      expect(res.status).toBe(409);
    });

    it("returns 404 when executor=false and row vanished between lookup and recheck", async () => {
      const id = insertTask();
      insertQuestion(id, "race-404");
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.answerQuestion as any).mockImplementation(() => {
        testDb.db
          .delete(agentQuestions)
          .where(eq(agentQuestions.requestId, "race-404"))
          .run();
        return false;
      });
      const res = await hit(id, "race-404", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 200 with taskStatus on success (status is echoed)", async () => {
      const id = insertTask();
      insertQuestion(id, "race-ok");
      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.answerQuestion as any).mockReturnValue(true);
      const res = await hit(id, "race-ok", { answer: "hi" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.taskStatus).toBe("waiting_for_input"); // route echoes the pre-answer status (mock didn't mutate it)
    });
  });
});
