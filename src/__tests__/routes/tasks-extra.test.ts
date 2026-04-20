import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { tasks, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// Prevent task-executor from actually spawning subprocess
vi.mock("../../services/task-executor", () => ({
  taskExecutor: {
    execute: vi.fn(),
    cancel: vi.fn(),
    getMetrics: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    resolvePermission: vi.fn(() => true),
  },
}));

describe("Tasks API — extra endpoints", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    const p = testDb.db.insert(projects).values({ name: "Task Extra Project" }).returning().get();
    projectId = p!.id;
  });

  afterAll(() => testDb.sqlite.close());

  beforeEach(() => {
    testDb.sqlite.exec("DELETE FROM tasks;");
  });

  describe("POST /tasks validation", () => {
    it("rejects missing prompt and promptFile", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("accepts promptFile without prompt", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptFile: "/tmp/prompt.md" }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.promptFile).toBe("/tmp/prompt.md");
    });

    it("rejects task-level disabledSkills with 400", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "disabled-skills test",
          disabledSkills: ["skill-a"],
        }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects task-level disabledMcpServers with 422", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "disabled-mcp test",
          disabledMcpServers: ["server-b"],
        }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /tasks/stats", () => {
    it("returns zero stats on empty DB", async () => {
      const res = await app.request("/tasks/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.queued).toBe(0);
      expect(body.completed).toBe(0);
      expect(body.avgDurationSeconds).toBeNull();
    });

    it("aggregates counts by status", async () => {
      testDb.db.insert(tasks).values([
        { status: "queued" },
        { status: "queued" },
        { status: "running" },
        { status: "completed" },
        { status: "done", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:01:00.000Z" },
      ] as any).run();

      const res = await app.request("/tasks/stats");
      const body = await res.json();
      expect(body.total).toBe(5);
      expect(body.queued).toBe(2);
      expect(body.running).toBe(1);
      expect(body.completed).toBe(1);
      expect(body.done).toBe(1);
    });

    it("filters stats by project_id", async () => {
      testDb.db.insert(tasks).values([
        { projectId, status: "queued" },
        { projectId: null, status: "queued" },
      ] as any).run();

      const res = await app.request(`/tasks/stats?project_id=${projectId}`);
      const body = await res.json();
      expect(body.total).toBe(1);
    });
  });

  describe("GET /tasks/:id/diff", () => {
    it("returns 404 if task not found", async () => {
      const res = await app.request("/tasks/999/diff");
      expect(res.status).toBe(404);
    });

    it("returns 404 if no gitCommitBefore", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "no diff" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/diff`);
      expect(res.status).toBe(404);
    });

    it("returns 422 if no workingDir set", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "d",
        gitCommitBefore: "abc123",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/diff`);
      expect(res.status).toBe(422);
    });

    it("returns 500 when git fails (invalid commit)", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "bad-diff",
        gitCommitBefore: "nonexistent-sha",
        gitCommitAfter: "also-not-a-sha",
        workingDir: "/tmp",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/diff`);
      // git will fail, returning 500 with error body
      expect([500, 422]).toContain(res.status);
    });
  });

  describe("POST /tasks/:id/approve", () => {
    it("returns 404 for missing task", async () => {
      const res = await app.request("/tasks/999/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("rejects approve of task not in approval state", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "p",
        status: "done",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("approves a task awaiting approval", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "p",
        status: "pending_approval",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "LGTM" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
      expect(updated.status).toBe("done");
      expect(updated.approvalStatus).toBe("approved");
      expect(updated.approvalNote).toBe("LGTM");
    });

    it("approve with no body still works", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "p",
        status: "pending_approval",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/approve`, { method: "POST" });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /tasks/:id/reject", () => {
    it("returns 404 for missing task", async () => {
      const res = await app.request("/tasks/999/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("rejects task awaiting approval", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "reject test",
        status: "pending_approval",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "not good" }),
      });
      expect(res.status).toBe(200);

      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
      expect(updated.status).toBe("cancelled");
      expect(updated.approvalStatus).toBe("rejected");
      expect(updated.errorMessage).toContain("not good");
    });

    it("refuses to reject completed task", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "done task",
        status: "done",
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("POST /tasks/:id/permission/:requestId", () => {
    it("rejects invalid behavior", async () => {
      const res = await app.request("/tasks/1/permission/req-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "invalid" }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects when task is not running", async () => {
      const res = await app.request("/tasks/1/permission/req-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "allow" }),
      });
      expect(res.status).toBe(422);
    });

    it("allows when task is running and permission resolved", async () => {
      const { taskExecutor } = await import("../../services/task-executor.js");
      (taskExecutor.isRunning as any).mockReturnValue(true);
      (taskExecutor.resolvePermission as any).mockReturnValue(true);

      const res = await app.request("/tasks/1/permission/req-allow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "allow" }),
      });
      expect(res.status).toBe(200);

      (taskExecutor.isRunning as any).mockReturnValue(false);
    });

    it("denies with message", async () => {
      const { taskExecutor } = await import("../../services/task-executor.js");
      (taskExecutor.isRunning as any).mockReturnValue(true);
      (taskExecutor.resolvePermission as any).mockReturnValue(true);

      const res = await app.request("/tasks/1/permission/req-deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "deny", message: "nope" }),
      });
      expect(res.status).toBe(200);

      (taskExecutor.isRunning as any).mockReturnValue(false);
    });

    it("returns 404 when permission request doesn't exist", async () => {
      const { taskExecutor } = await import("../../services/task-executor.js");
      (taskExecutor.isRunning as any).mockReturnValue(true);
      (taskExecutor.resolvePermission as any).mockReturnValue(false);

      const res = await app.request("/tasks/1/permission/missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "allow" }),
      });
      expect(res.status).toBe(404);

      (taskExecutor.isRunning as any).mockReturnValue(false);
    });
  });

  describe("PATCH /tasks/:id — permission_mode", () => {
    it("creates a task with permission_mode set at create time", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "pm-create", permission_mode: "bypassPermissions" }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.permissionMode).toBe("bypassPermissions");
    });

    it("rejects invalid permission_mode at create", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "pm-bad", permission_mode: "nonsense" }),
      });
      expect(res.status).toBe(422);
    });

    it("updates permission_mode via PATCH", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "pm-patch" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: "plan" }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.permissionMode).toBe("plan");
    });

    it("clears permission_mode when explicitly set to null (inherit from parent)", async () => {
      const t = testDb.db.insert(tasks).values({
        prompt: "pm-clear",
        permissionMode: "bypassPermissions",
      } as any).returning().get()!;

      const res = await app.request(`/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: null }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.permissionMode).toBeNull();
    });

    it("rejects invalid permission_mode via PATCH", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "pm-patch-bad" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: "garbage" }),
      });
      expect(res.status).toBe(422);
    });

    it("PATCH returns 404 for missing task", async () => {
      const res = await app.request(`/tasks/999999`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: "plan" }),
      });
      expect(res.status).toBe(404);
    });

    it("accepts camelCase permissionMode alias", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "pm-camel" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionMode: "acceptEdits" }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.permissionMode).toBe("acceptEdits");
    });
  });

  describe("GET /tasks/:id with liveMetrics", () => {
    it("includes liveMetrics when taskExecutor returns metrics", async () => {
      const { taskExecutor } = await import("../../services/task-executor.js");
      (taskExecutor.getMetrics as any).mockReturnValue({
        inputTokens: 123,
        outputTokens: 45,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 20,
        totalCostUsd: 0.5,
        turns: 3,
        durationMs: 4321,
      });

      const t = testDb.db.insert(tasks).values({ prompt: "live" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.liveMetrics).toBeDefined();
      expect(body.liveMetrics.input_tokens).toBe(123);
      expect(body.liveMetrics.turns).toBe(3);

      (taskExecutor.getMetrics as any).mockReturnValue(null);
    });
  });

  describe("GET /tasks filter edge cases", () => {
    it("filters by created_after and created_before", async () => {
      testDb.db.insert(tasks).values([
        { prompt: "old", createdAt: "2024-01-01T00:00:00.000Z" },
        { prompt: "new", createdAt: "2026-06-01T00:00:00.000Z" },
      ] as any).run();

      const res = await app.request("/tasks?created_after=2025-01-01&created_before=2027-01-01");
      const body = await res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].prompt).toBe("new");
    });
  });
});
