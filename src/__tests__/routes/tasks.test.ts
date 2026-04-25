import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { tasks as tasksTable, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// The executor would try to spawn Claude Code and hit external state — neuter
// it so POST /tasks only exercises the route + Zod validation path.
vi.spyOn(taskExecutor, "execute").mockImplementation(async () => {});

describe("Tasks API", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });
  afterAll(() => testDb.sqlite.close());

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /tasks returns empty list initially", async () => {
    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /tasks/:id returns 404 for missing task", async () => {
    const res = await app.request("/tasks/999");
    expect(res.status).toBe(404);
  });

  it("404 for unknown routes", async () => {
    const res = await app.request("/unknown/route");
    expect(res.status).toBe(404);
  });

  describe("spec fields (acceptance_criteria / decision_table)", () => {
    async function createTask(body: Record<string, unknown> = {}): Promise<Response> {
      return app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do the thing", ...body }),
      });
    }

    it("POST accepts the two spec fields and round-trips them via GET", async () => {
      const criteria = ["User can log in", "User can log out"];
      const decisionTable = {
        columns: ["input", "output"],
        rules: [{ input: "a", output: "b" }, { input: "c", output: "d" }],
      };

      const res = await createTask({
        acceptanceCriteria: criteria,
        decisionTable,
      });
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created.acceptanceCriteria).toEqual(criteria);
      expect(created.decisionTable).toEqual(decisionTable);

      const getRes = await app.request(`/tasks/${created.id}`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.acceptanceCriteria).toEqual(criteria);
      expect(fetched.decisionTable).toEqual(decisionTable);
    });

    it("GET returns null spec fields when the task has none", async () => {
      const res = await createTask();
      const created = await res.json();
      const getRes = await app.request(`/tasks/${created.id}`);
      const fetched = await getRes.json();
      expect(fetched.acceptanceCriteria).toBeNull();
      expect(fetched.decisionTable).toBeNull();
    });

    it("PUT updates the two spec fields and GET returns the new values", async () => {
      const create = await createTask();
      const { id } = await create.json();

      const criteria = ["Returns HTTP 200 on success"];
      const decisionTable = { rules: [{ when: "x", then: "y" }] };

      const putRes = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: criteria, decisionTable }),
      });
      expect(putRes.status).toBe(200);
      const updated = await putRes.json();
      expect(updated.acceptanceCriteria).toEqual(criteria);
      expect(updated.decisionTable).toEqual(decisionTable);

      const getRes = await app.request(`/tasks/${id}`);
      const fetched = await getRes.json();
      expect(fetched.acceptanceCriteria).toEqual(criteria);
      expect(fetched.decisionTable).toEqual(decisionTable);
    });

    it("PUT with null clears a previously-set spec field", async () => {
      const create = await createTask({
        acceptanceCriteria: ["one"],
      });
      const { id } = await create.json();

      const putRes = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: null }),
      });
      expect(putRes.status).toBe(200);
      const updated = await putRes.json();
      expect(updated.acceptanceCriteria).toBeNull();
    });

    it("PUT returns 404 for missing task", async () => {
      const res = await app.request("/tasks/9999", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: ["x"] }),
      });
      expect(res.status).toBe(404);
    });

    it("PUT rejects >50 acceptance criteria with 400", async () => {
      const create = await createTask();
      const { id } = await create.json();

      const tooMany = Array.from({ length: 51 }, (_, i) => `criterion ${i}`);
      const res = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: tooMany }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/spec/i);
      expect(body.details).toHaveProperty("acceptanceCriteria");
    });

    it("PUT rejects an acceptance criterion > 500 chars with 400", async () => {
      const create = await createTask();
      const { id } = await create.json();

      const overflow = "x".repeat(501);
      const res = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: ["ok", overflow] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.details).toHaveProperty("acceptanceCriteria");
    });

    it("PUT rejects decision_table with > 50 rules with 400", async () => {
      const create = await createTask();
      const { id } = await create.json();

      const rules = Array.from({ length: 51 }, (_, i) => ({ i }));
      const res = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionTable: { rules } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.details).toHaveProperty("decisionTable");
    });

    it("PUT accepts decision_table with exactly 50 rules", async () => {
      const create = await createTask();
      const { id } = await create.json();

      const rules = Array.from({ length: 50 }, (_, i) => ({ i }));
      const res = await app.request(`/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisionTable: { rules } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decisionTable.rules).toHaveLength(50);
    });

    it("POST rejects invalid spec fields with 400 before the task is inserted", async () => {
      const res = await createTask({ acceptanceCriteria: Array(51).fill("x") });
      expect(res.status).toBe(400);
    });
  });

  // ─── Question /answer endpoints ─────────────────────────────────────────
  // These exercise the HTTP surface added in slice 02. The executor's
  // answerQuestion is stubbed so we can assert the route's own validation
  // (404 for unknown / wrong-task, 409 for double-answer, 400 for oversize)
  // without spinning up a real AgentSession.
  describe("POST /tasks/:id/question/:requestId/answer", () => {
    function insertTask(status = "running"): number {
      const row = testDb.db.insert(tasksTable).values({
        prompt: "question-answer-test",
        status,
      }).returning().get();
      return row!.id;
    }

    function insertQuestion(opts: {
      taskId: number;
      requestId: string;
      status?: "pending" | "answered" | "cancelled";
    }): void {
      testDb.db.insert(agentQuestions).values({
        requestId: opts.requestId,
        taskId: opts.taskId,
        toolUseId: `tu-${opts.requestId}`,
        question: "what port?",
        status: opts.status ?? "pending",
        answer: opts.status === "answered" ? "prior answer" : null,
        answeredAt: opts.status === "answered" ? new Date().toISOString() : null,
      }).run();
    }

    async function hit(taskId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/tasks/${taskId}/question/${requestId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("answers a pending question and returns the post-answer task status", async () => {
      const taskId = insertTask("running");
      insertQuestion({ taskId, requestId: "q-ok-1" });

      const spy = vi.spyOn(taskExecutor, "answerQuestion").mockImplementation(() => {
        // Mirror the real executor's DB side effects: flip the row to
        // 'answered' and leave the task in 'running'. That way the route's
        // post-answer status read-back returns the expected value.
        testDb.db.update(agentQuestions)
          .set({ status: "answered", answer: "port 52077", answeredAt: new Date().toISOString() })
          .where(eq(agentQuestions.requestId, "q-ok-1"))
          .run();
        return true;
      });

      try {
        const res = await hit(taskId, "q-ok-1", { answer: "port 52077" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.taskStatus).toBe("running");
        expect(spy).toHaveBeenCalledWith(taskId, "q-ok-1", "port 52077");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the requestId is unknown", async () => {
      const taskId = insertTask("running");
      const res = await hit(taskId, "does-not-exist", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the requestId belongs to another task", async () => {
      const ownerTask = insertTask("running");
      const otherTask = insertTask("running");
      insertQuestion({ taskId: ownerTask, requestId: "q-other-1" });

      const res = await hit(otherTask, "q-other-1", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for an oversize answer (> 8000 chars)", async () => {
      const taskId = insertTask("running");
      insertQuestion({ taskId, requestId: "q-size-1" });

      const res = await hit(taskId, "q-size-1", { answer: "x".repeat(8001) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for an empty answer", async () => {
      const taskId = insertTask("running");
      insertQuestion({ taskId, requestId: "q-empty-1" });

      const res = await hit(taskId, "q-empty-1", { answer: "" });
      expect(res.status).toBe(400);
    });

    it("returns 409 when the question is already answered", async () => {
      const taskId = insertTask("running");
      insertQuestion({ taskId, requestId: "q-dup-1", status: "answered" });

      const res = await hit(taskId, "q-dup-1", { answer: "again" });
      expect(res.status).toBe(409);
    });

    it("returns 404 when the task does not exist", async () => {
      const res = await hit(999999, "anything", { answer: "hi" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /tasks/:id/questions", () => {
    it("lists pending questions for the task", async () => {
      const row = testDb.db.insert(tasksTable).values({
        prompt: "list-questions-test",
        status: "waiting_for_input",
      }).returning().get();
      const taskId = row!.id;

      testDb.db.insert(agentQuestions).values({
        requestId: "q-list-1",
        taskId,
        toolUseId: "tu-list-1",
        question: "please clarify",
        status: "pending",
      }).run();

      // Answered questions must NOT appear in the list.
      testDb.db.insert(agentQuestions).values({
        requestId: "q-list-done",
        taskId,
        toolUseId: "tu-list-done",
        question: "old",
        status: "answered",
        answer: "yes",
        answeredAt: new Date().toISOString(),
      }).run();

      const res = await app.request(`/tasks/${taskId}/questions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].requestId).toBe("q-list-1");
    });

    it("returns 404 for a missing task", async () => {
      const res = await app.request("/tasks/999999/questions");
      expect(res.status).toBe(404);
    });
  });
});
