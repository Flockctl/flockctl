import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { tasks, projects, usageRecords } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// Prevent task-executor from actually spawning subprocess
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(),
    cancel: vi.fn(),
    getMetrics: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    resolvePermission: vi.fn(() => true),
    pendingPermissions: vi.fn(() => []),
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

    it("counts failed tasks that were rerun (manual or auto-retry)", async () => {
      const f1 = testDb.db.insert(tasks).values({ status: "failed" } as any).returning().get();
      const f2 = testDb.db.insert(tasks).values({ status: "failed" } as any).returning().get();
      testDb.db.insert(tasks).values({ status: "failed" } as any).run();
      testDb.db.insert(tasks).values({
        status: "queued",
        parentTaskId: f1!.id,
        label: `rerun-${f1!.id}`,
      } as any).run();
      testDb.db.insert(tasks).values({
        status: "running",
        parentTaskId: f2!.id,
        label: `retry-${f2!.id}-1`,
      } as any).run();

      const res = await app.request("/tasks/stats");
      const body = await res.json();
      expect(body.failed).toBe(3);
      expect(body.failedRerun).toBe(2);
      expect(body.failedNotRerun).toBe(1);
    });

    it("reports superseded failures and build-after-rerun counts", async () => {
      // f1 → rescued by a `done` rerun → superseded + buildAfterRerun bumps.
      // f2 → rerun still running → counts as failedRerun but NOT superseded.
      // f3 → timed_out → rescued by a `completed` rerun → superseded (timed_out path).
      // f4 → dead failure, never rerun → failedNotRerun only.
      const f1 = testDb.db.insert(tasks).values({ status: "failed" } as any).returning().get();
      const f2 = testDb.db.insert(tasks).values({ status: "failed" } as any).returning().get();
      const f3 = testDb.db.insert(tasks).values({ status: "timed_out" } as any).returning().get();
      testDb.db.insert(tasks).values({ status: "failed" } as any).run();
      testDb.db.insert(tasks).values({
        status: "done",
        parentTaskId: f1!.id,
        label: `rerun-${f1!.id}`,
      } as any).run();
      testDb.db.insert(tasks).values({
        status: "running",
        parentTaskId: f2!.id,
        label: `rerun-${f2!.id}`,
      } as any).run();
      testDb.db.insert(tasks).values({
        status: "completed",
        parentTaskId: f3!.id,
        label: `rerun-${f3!.id}`,
      } as any).run();

      const res = await app.request("/tasks/stats");
      const body = await res.json();
      // f1 is rescued, f3 is rescued (timed_out path) → 2 superseded.
      expect(body.supersededFailures).toBe(2);
      // Two successful reruns (done + completed) → 2 build-after-rerun.
      expect(body.buildAfterRerun).toBe(2);
    });
  });

  describe("GET /tasks — superseded hiding", () => {
    it("hides failed tasks whose rerun chain already succeeded by default", async () => {
      const parent = testDb.db.insert(tasks).values({
        status: "failed",
        prompt: "parent that was rescued",
      } as any).returning().get();
      testDb.db.insert(tasks).values({
        status: "done",
        parentTaskId: parent!.id,
        prompt: "successful rerun",
      } as any).run();
      // Plain failure that stays visible.
      const deadFailure = testDb.db.insert(tasks).values({
        status: "failed",
        prompt: "dead failure",
      } as any).returning().get();

      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.items.map((t: any) => t.id);
      expect(ids).not.toContain(parent!.id);
      expect(ids).toContain(deadFailure!.id);
    });

    it("include_superseded=true returns the rescued failures too", async () => {
      const parent = testDb.db.insert(tasks).values({
        status: "failed",
        prompt: "parent that was rescued",
      } as any).returning().get();
      testDb.db.insert(tasks).values({
        status: "done",
        parentTaskId: parent!.id,
      } as any).run();

      const res = await app.request("/tasks?include_superseded=true");
      const body = await res.json();
      const ids = body.items.map((t: any) => t.id);
      expect(ids).toContain(parent!.id);
    });

    it("keeps failures visible when the rerun is still running (not yet successful)", async () => {
      const parent = testDb.db.insert(tasks).values({
        status: "failed",
        prompt: "parent with in-flight rerun",
      } as any).returning().get();
      testDb.db.insert(tasks).values({
        status: "running",
        parentTaskId: parent!.id,
      } as any).run();

      const res = await app.request("/tasks");
      const body = await res.json();
      const ids = body.items.map((t: any) => t.id);
      expect(ids).toContain(parent!.id);
    });
  });

  describe("actual_model_used (from usage_records)", () => {
    // Both the list and detail endpoints surface the most recent model used
    // by the provider so the UI can stop showing "Default" once a real
    // run has happened. The value is derived from `usage_records`, NOT
    // from `tasks.model` (which is the *requested* model and stays NULL
    // when the user wanted the system default).
    beforeEach(() => {
      testDb.sqlite.exec("DELETE FROM usage_records;");
    });

    it("GET /tasks returns the most recent usage_records.model per task", async () => {
      const t1 = testDb.db.insert(tasks).values({ prompt: "p1", model: null } as any).returning().get()!;
      const t2 = testDb.db.insert(tasks).values({ prompt: "p2", model: "claude-opus-4" } as any).returning().get()!;
      const t3 = testDb.db.insert(tasks).values({ prompt: "p3", model: null } as any).returning().get()!;

      // t1 had two usage rows — actual_model_used must reflect the most
      // recent one (highest id), not the first one.
      testDb.db.insert(usageRecords).values({
        taskId: t1.id, provider: "anthropic", model: "claude-3-haiku",
      } as any).run();
      testDb.db.insert(usageRecords).values({
        taskId: t1.id, provider: "anthropic", model: "claude-sonnet-4",
      } as any).run();
      // t2 had one usage row that disagrees with task.model.
      testDb.db.insert(usageRecords).values({
        taskId: t2.id, provider: "anthropic", model: "claude-sonnet-4",
      } as any).run();
      // t3 has no usage rows.

      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      const byId = new Map<number, any>(body.items.map((it: any) => [it.id, it]));

      expect(byId.get(t1.id).actual_model_used).toBe("claude-sonnet-4");
      expect(byId.get(t2.id).actual_model_used).toBe("claude-sonnet-4");
      expect(byId.get(t3.id).actual_model_used).toBeNull();
    });

    it("GET /tasks/:id surfaces the same actual_model_used field", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "single", model: null } as any).returning().get()!;
      testDb.db.insert(usageRecords).values({
        taskId: t.id, provider: "anthropic", model: "claude-3-opus",
      } as any).run();

      const res = await app.request(`/tasks/${t.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.actual_model_used).toBe("claude-3-opus");
    });

    it("GET /tasks/:id returns null actual_model_used when no usage exists", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "no usage", model: "claude-haiku" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`);
      const body = await res.json();
      expect(body.actual_model_used).toBeNull();
      // task.model (the *requested* model) is still surfaced so the
      // frontend can fall back to it when actual_model_used is null.
      expect(body.model).toBe("claude-haiku");
    });
  });

  describe("GET /tasks/:id/diff", () => {
    it("returns 404 if task not found", async () => {
      const res = await app.request("/tasks/999/diff");
      expect(res.status).toBe(404);
    });

    it("returns empty payload when task has no file_edits journal", async () => {
      // Synthesized diffs are derived from the `file_edits` journal, not git.
      // A task that never invoked a file-modifying tool therefore reports zero
      // entries / zero files rather than erroring on missing git metadata.
      const t = testDb.db.insert(tasks).values({ prompt: "no-edits" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/diff`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total_entries).toBe(0);
      expect(body.total_files).toBe(0);
      expect(body.diff).toBe("");
      expect(body.summary).toBeNull();
    });

    it("returns synthesized diff from persisted file_edits journal", async () => {
      const journal = {
        version: 1 as const,
        entries: [
          {
            filePath: "/tmp/px/a.ts",
            original: "a\nb\nc\n",
            current: "a\nB\nc\n",
          },
        ],
      };
      const t = testDb.db.insert(tasks).values({
        prompt: "with-edits",
        fileEdits: JSON.stringify(journal),
      } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}/diff`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total_entries).toBe(1);
      expect(body.total_files).toBe(1);
      expect(body.summary).toMatch(/1 file changed/);
      expect(body.diff).toContain("/tmp/px/a.ts");
      expect(body.diff).toContain("-b");
      expect(body.diff).toContain("+B");
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
      const { taskExecutor } = await import("../../services/task-executor/index.js");
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
      const { taskExecutor } = await import("../../services/task-executor/index.js");
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
      const { taskExecutor } = await import("../../services/task-executor/index.js");
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

  describe("GET /tasks/:id/pending-permissions", () => {
    it("returns 404 for unknown task", async () => {
      const res = await app.request("/tasks/999999/pending-permissions");
      expect(res.status).toBe(404);
    });

    it("returns empty items when no session is running", async () => {
      const t = testDb.db.insert(tasks).values({
        projectId, prompt: "no-session", status: "queued",
      } as any).returning().get()!;

      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.pendingPermissions as any).mockReturnValue([]);

      const res = await app.request(`/tasks/${t.id}/pending-permissions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
    });

    it("returns shaped items from the session", async () => {
      const t = testDb.db.insert(tasks).values({
        projectId, prompt: "pending", status: "running",
      } as any).returning().get()!;

      const { taskExecutor } = await import("../../services/task-executor/index.js");
      (taskExecutor.pendingPermissions as any).mockReturnValue([
        {
          requestId: "perm-t1-1",
          toolName: "Bash",
          toolInput: { command: "ls" },
          title: "Bash",
          displayName: "Bash",
          description: "list files",
          decisionReason: "tool requires approval",
          toolUseID: "tu-1",
        },
      ]);

      const res = await app.request(`/tasks/${t.id}/pending-permissions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([{
        request_id: "perm-t1-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        title: "Bash",
        display_name: "Bash",
        description: "list files",
        decision_reason: "tool requires approval",
        tool_use_id: "tu-1",
      }]);

      (taskExecutor.pendingPermissions as any).mockReturnValue([]);
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
      const { taskExecutor } = await import("../../services/task-executor/index.js");
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

  describe("GET /tasks/:id rerun chain", () => {
    it("includes direct children (reruns) ordered by creation time", async () => {
      const parent = testDb.db.insert(tasks).values({
        prompt: "original",
        status: "failed",
      } as any).returning().get()!;
      const child1 = testDb.db.insert(tasks).values({
        prompt: "original",
        status: "failed",
        parentTaskId: parent.id,
        label: `rerun-${parent.id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as any).returning().get()!;
      const child2 = testDb.db.insert(tasks).values({
        prompt: "original",
        status: "running",
        parentTaskId: parent.id,
        label: `rerun-${child1.id}`,
        createdAt: "2026-01-02T00:00:00.000Z",
      } as any).returning().get()!;
      // Unrelated task — must not leak into children.
      testDb.db.insert(tasks).values({ prompt: "unrelated" } as any).run();

      const res = await app.request(`/tasks/${parent.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.children)).toBe(true);
      expect(body.children).toHaveLength(2);
      expect(body.children[0].id).toBe(child1.id);
      expect(body.children[1].id).toBe(child2.id);
      expect(body.children[1].status).toBe("running");
      expect(body.children[1].label).toBe(`rerun-${child1.id}`);
    });

    it("returns empty children array for tasks with no reruns", async () => {
      const t = testDb.db.insert(tasks).values({ prompt: "solo" } as any).returning().get()!;
      const res = await app.request(`/tasks/${t.id}`);
      const body = await res.json();
      expect(body.children).toEqual([]);
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
