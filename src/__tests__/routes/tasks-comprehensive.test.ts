import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { tasks, taskLogs, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";

describe("Tasks API — comprehensive", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    // Create a project
    const p = testDb.db.insert(projects).values({
      name: "Task Test Project",
    }).returning().get();
    projectId = p!.id;
  });

  afterAll(() => testDb.sqlite.close());

  // ─── List / Empty state ─────────────────────

  describe("GET /tasks", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.page).toBe(1);
    });

    it("supports pagination params", async () => {
      const res = await app.request("/tasks?page=2&per_page=5");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.page).toBe(2);
      expect(body.perPage).toBe(5);
    });
  });

  // ─── Create Tasks ─────────────────────

  describe("POST /tasks", () => {
    it("creates a task with prompt only", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Hello world task" }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.prompt).toBe("Hello world task");
      expect(t.status).toBe("queued");
      expect(t.taskType).toBe("execution");
      expect(t.maxRetries).toBe(0);
    });

    it("creates a task with all optional fields", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: "Full task",
          model: "claude-opus-4-20250514",
          taskType: "execution",
          label: "test-task",
          workingDir: "/tmp",
          timeoutSeconds: 300,
          maxRetries: 3,
          envVars: { FOO: "bar" },
          allowedKeyIds: [1, 2],
        }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.projectId).toBe(projectId);
      expect(t.model).toBe("claude-opus-4-20250514");
      expect(t.label).toBe("test-task");
      expect(t.workingDir).toBe("/tmp");
      expect(t.timeoutSeconds).toBe(300);
      expect(t.maxRetries).toBe(3);
    });

    it("creates a task of type merge", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Merge task",
          taskType: "merge",
        }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.taskType).toBe("merge");
    });
  });

  // ─── Get Single Task ─────────────────────

  describe("GET /tasks/:id", () => {
    it("returns the task", async () => {
      const res = await app.request("/tasks/1");
      expect(res.status).toBe(200);
      const t = await res.json();
      expect(t.id).toBe(1);
      expect(t.prompt).toBe("Hello world task");
    });

    it("returns 404 for non-existent task", async () => {
      const res = await app.request("/tasks/999");
      expect(res.status).toBe(404);
    });

    it("returns 422 for id=0 (not a positive integer)", async () => {
      // parseIdParam rejects non-positive ids up-front so the handler
      // never issues a `WHERE id = 0` query that would silently 404.
      const res = await app.request("/tasks/0");
      expect(res.status).toBe(422);
    });
  });

  // ─── Task Logs ─────────────────────

  describe("GET /tasks/:id/logs", () => {
    it("returns empty logs initially", async () => {
      const res = await app.request("/tasks/1/logs");
      expect(res.status).toBe(200);
      const logs = await res.json();
      expect(logs).toEqual([]);
    });

    it("returns logs after inserting some", async () => {
      testDb.db.insert(taskLogs).values([
        { taskId: 1, content: "Starting execution...", streamType: "stdout" },
        { taskId: 1, content: "Error: something", streamType: "stderr" },
        { taskId: 1, content: "tool_call: read_file", streamType: "tool_call" },
      ]).run();

      const res = await app.request("/tasks/1/logs");
      expect(res.status).toBe(200);
      const logs = await res.json();
      expect(logs.length).toBe(3);
      expect(logs[0].content).toBe("Starting execution...");
      expect(logs[0].stream_type).toBe("stdout");
      expect(logs[1].stream_type).toBe("stderr");
      expect(logs[2].stream_type).toBe("tool_call");
    });

    it("returns 404 for logs of non-existent task", async () => {
      const res = await app.request("/tasks/999/logs");
      expect(res.status).toBe(404);
    });
  });

  // ─── Cancel ─────────────────────

  describe("POST /tasks/:id/cancel", () => {
    it("cancels a queued task", async () => {
      // Insert directly to avoid triggering executor
      testDb.db.insert(tasks).values({
        prompt: "To cancel",
        status: "queued",
      }).run();
      const t = testDb.db.select().from(tasks).all().pop()!;

      const res = await app.request(`/tasks/${t.id}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("cancelled");

      // Verify DB was actually updated
      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
      expect(updated.status).toBe("cancelled");
      expect(updated.completedAt).toBeTruthy();
    });

    it("cancels a running task (DB always updated)", async () => {
      testDb.db.insert(tasks).values({
        prompt: "Running cancel",
        status: "running",
        startedAt: new Date().toISOString(),
      }).run();
      const t = testDb.db.select().from(tasks).all().pop()!;

      const res = await app.request(`/tasks/${t.id}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);

      // DB must be updated to cancelled even without a session
      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
      expect(updated.status).toBe("cancelled");
      expect(updated.completedAt).toBeTruthy();
    });

    it("returns 404 for missing task", async () => {
      const res = await app.request("/tasks/999/cancel", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("rejects cancel of already-cancelled task", async () => {
      // Set up a task as cancelled
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Already cancelled" }),
      });
      const t = await createRes.json();
      testDb.db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, t.id)).run();

      const res = await app.request(`/tasks/${t.id}/cancel`, { method: "POST" });
      expect(res.status).toBe(422);
    });

    it("rejects cancel of completed task", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Done task" }),
      });
      const t = await createRes.json();
      testDb.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, t.id)).run();

      const res = await app.request(`/tasks/${t.id}/cancel`, { method: "POST" });
      expect(res.status).toBe(422);
    });
  });

  // ─── Rerun ─────────────────────

  describe("POST /tasks/:id/rerun", () => {
    it("creates a new task based on original", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: "Rerun me",
          model: "claude-opus-4-20250514",
          taskType: "execution",
          label: "rerun-source",
        }),
      });
      const original = await createRes.json();
      testDb.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, original.id)).run();

      const res = await app.request(`/tasks/${original.id}/rerun`, { method: "POST" });
      expect(res.status).toBe(201);
      const rerun = await res.json();
      expect(rerun.prompt).toBe("Rerun me");
      expect(rerun.projectId).toBe(projectId);
      expect(rerun.parentTaskId).toBe(original.id);
      expect(rerun.label).toBe("rerun-rerun-source");
      expect(rerun.status).toBe("queued");
    });

    it("rerun of task without label uses ID in label", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "No label rerun" }),
      });
      const original = await createRes.json();

      const res = await app.request(`/tasks/${original.id}/rerun`, { method: "POST" });
      expect(res.status).toBe(201);
      const rerun = await res.json();
      expect(rerun.label).toBe(`rerun-${original.id}`);
    });

    it("returns 404 for missing task", async () => {
      const res = await app.request("/tasks/999/rerun", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Filtering ─────────────────────

  describe("GET /tasks with filters", () => {
    beforeAll(() => {
      // Set up diverse tasks for filtering
      testDb.db.insert(tasks).values([
        { projectId, prompt: "Filter A", status: "done", taskType: "execution", label: "alpha" },
        { projectId, prompt: "Filter B", status: "failed", taskType: "merge", label: "beta" },
        { projectId: null, prompt: "Filter C", status: "running", taskType: "execution", label: "gamma" },
      ]).run();
    });

    it("filters by status", async () => {
      const res = await app.request("/tasks?status=done");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.every((t: any) => t.status === "done")).toBe(true);
    });

    it("filters by project_id", async () => {
      const res = await app.request(`/tasks?project_id=${projectId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.every((t: any) => t.projectId === projectId)).toBe(true);
    });

    it("filters by task_type", async () => {
      const res = await app.request("/tasks?task_type=merge");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.every((t: any) => t.taskType === "merge")).toBe(true);
    });

    it("filters by label (like match)", async () => {
      const res = await app.request("/tasks?label=alpha");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].label).toContain("alpha");
    });

    it("returns empty for non-matching filter", async () => {
      const res = await app.request("/tasks?status=nonexistent_status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
    });
  });
});
