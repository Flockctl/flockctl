import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, taskLogs, aiProviderKeys, projects, budgetLimits, usageRecords } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

// Track sessions so tests can drive events
const createdSessions: any[] = [];
// Hook called inside mock run() BEFORE any throw so test can mutate DB state
let beforeThrowHook: null | (() => void) = null;

vi.mock("../../services/agent-session/index", () => {
  const EventEmitter = require("events").EventEmitter;
  class MockAgentSession extends EventEmitter {
    private opts: any;
    aborted = false;
    constructor(opts: any) {
      super();
      this.opts = opts;
      createdSessions.push(this);
    }
    async run() {
      // Allow prompt-driven test scenarios
      const p: string = this.opts.prompt ?? "";
      if (beforeThrowHook) beforeThrowHook();
      if (p.includes("HANG_UNTIL_ABORT")) {
        // Wait until abort() is called, then throw with the recorded reason
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.aborted) resolve();
            else setTimeout(check, 5);
          };
          check();
        });
        const e: any = new Error(`aborted: ${this.abortReason}`);
        e.name = this.abortReason === "timeout" ? "TimeoutError" : "AbortError";
        e.reason = this.abortReason;
        throw e;
      }
      if (p.includes("THROW_SHUTDOWN_ABORT")) {
        const e: any = new Error("Daemon shutting down");
        e.name = "AbortError";
        e.reason = "shutdown";
        throw e;
      }
      if (p.includes("THROW_ABORT")) {
        const e: any = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (p.includes("THROW_TIMEOUT")) {
        const e: any = new Error("Task timed out after 5s");
        e.name = "TimeoutError";
        e.reason = "timeout";
        throw e;
      }
      if (p.includes("THROW_GENERIC")) {
        throw new Error("boom");
      }
      // Emit events to cover handlers
      if (p.includes("EMIT_TOOL")) {
        this.emit("tool_call", "Bash", { command: "ls -la" });
        this.emit("tool_call", "Read", { file_path: "/x" });
        this.emit("tool_call", "Write", { file_path: "/y" });
        this.emit("tool_call", "Edit", { file_path: "/z" });
        this.emit("tool_call", "Glob", { pattern: "**/*.ts" });
        this.emit("tool_call", "Grep", { pattern: "foo" });
        this.emit("tool_call", "ListDir", { path: "." });
        this.emit("tool_call", "SomethingElse", { foo: "bar" });
        this.emit("tool_result", "Bash", "output line");
        this.emit("tool_result", "Bash", "");
      }
      if (p.includes("EMIT_PERM")) {
        this.emit("permission_request", {
          requestId: "r1",
          toolName: "Bash",
          toolInput: { command: "rm" },
          title: "Allow Bash?",
          displayName: "bash",
          description: "shell",
          decisionReason: "dangerous",
          toolUseID: "use1",
        });
      }
      if (p.includes("EMIT_USAGE_EVT")) {
        this.emit("usage", {
          inputTokens: 100, outputTokens: 50,
          cacheCreationInputTokens: 10, cacheReadInputTokens: 20,
          totalCostUsd: 0.01, turns: 2, durationMs: 1234,
        });
      }
      if (p.includes("EMIT_ERROR")) {
        this.emit("error", new Error("something bad"));
      }
      this.emit("text", "done text");
      return {
        inputTokens: 123, outputTokens: 45,
        cacheCreationInputTokens: 5, cacheReadInputTokens: 10,
        totalCostUsd: 0, turns: 1, durationMs: 10,
      };
    }
    abortReason: string | null = null;
    abort(reason: string = "user") {
      this.aborted = true;
      if (this.abortReason === null) this.abortReason = reason;
    }
    resolvePermission() { return true; }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/ws-manager", () => ({
  wsManager: { broadcast: vi.fn(), broadcastAll: vi.fn() },
}));

vi.mock("../../services/claude/skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(() => {}),
}));

vi.mock("../../services/claude/mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(() => {}),
}));

vi.mock("../../services/git-context", () => ({
  buildCodebaseContext: vi.fn(async () => ""),
}));

vi.mock("../../services/project-config", () => ({
  loadProjectConfig: vi.fn(() => ({})),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false), // No .git directory by default
    mkdirSync: vi.fn(),
  };
});

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => "abc123\n"),
}));

let db: FlockctlDb;
let sqlite: Database.Database;
let projectId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  db.insert(aiProviderKeys).values({
    provider: "anthropic",
    providerType: "anthropic-messages",
    label: "k",
    keyValue: "sk-ant-api-k",
    isActive: 1,
    priority: 0,
  } as any).run();

  const p = db.insert(projects).values({ name: "tx-proj" }).returning().get()!;
  projectId = p.id;
});

afterAll(() => sqlite.close());

import { taskExecutor } from "../../services/task-executor/index.js";
import { wsManager } from "../../services/ws-manager.js";
import { reconcileClaudeSkillsForProject } from "../../services/claude/skills-sync.js";
import { loadProjectConfig } from "../../services/project-config.js";

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM task_logs;
    DELETE FROM tasks;
    DELETE FROM budget_limits;
    DELETE FROM usage_records;
  `);
  createdSessions.length = 0;
  (wsManager.broadcast as any).mockClear();
  (wsManager.broadcastAll as any).mockClear();
  (loadProjectConfig as any).mockReset();
  (loadProjectConfig as any).mockReturnValue({});
});

describe("TaskExecutor — budget", () => {
  it("fails task when budget is exceeded with pause action", async () => {
    // Insert usage record exceeding budget
    db.insert(usageRecords).values({
      projectId,
      provider: "anthropic",
      model: "m",
      totalCostUsd: 1000,
    } as any).run();

    db.insert(budgetLimits).values({
      scope: "project",
      scopeId: projectId,
      period: "daily",
      limitUsd: 1,
      action: "pause",
      isActive: 1,
    } as any).run();

    const task = db.insert(tasks).values({
      projectId,
      prompt: "will be paused",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const updated = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(updated.status).toBe("failed");
    expect(updated.errorMessage).toContain("Budget exceeded");
  });

  it("logs warning when budget warn-action triggered but proceeds", async () => {
    db.insert(usageRecords).values({
      projectId,
      provider: "anthropic",
      model: "m",
      totalCostUsd: 500,
    } as any).run();

    db.insert(budgetLimits).values({
      scope: "project",
      scopeId: projectId,
      period: "daily",
      limitUsd: 1,
      action: "warn",
      isActive: 1,
    } as any).run();

    const task = db.insert(tasks).values({
      projectId,
      prompt: "warn-only",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const updated = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(updated.status).toBe("done");

    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some((l) => l.content.includes("Budget warning"))).toBe(true);
  });
});

describe("TaskExecutor — reconciler failure is non-fatal", () => {
  it("continues task when reconcileClaudeSkillsForProject throws", async () => {
    (reconcileClaudeSkillsForProject as any).mockImplementationOnce(() => {
      throw new Error("reconcile broken");
    });

    const task = db.insert(tasks).values({
      projectId,
      prompt: "reconcile-fail",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    // Reconciler errors are swallowed (try/catch in task-executor); task proceeds.
    const updated = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(updated.status).toBe("done");
  });
});

describe("TaskExecutor — session error variants", () => {
  it("marks task as failed when promptFile is missing instead of crashing", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: null,
      promptFile: "/nonexistent/path/task.md",
      status: "queued",
    }).returning().get()!;

    await expect(taskExecutor.execute(task.id)).resolves.toBeUndefined();

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("failed");
    expect(u.errorMessage).toContain("Prompt file not found");
  });

  it("sets status=cancelled for AbortError", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_ABORT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("cancelled");
  });

  it("sets status=timed_out for TimeoutError", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_TIMEOUT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("timed_out");
  });

  it("timeout log prefix says 'Timed out', not 'Cancelled'", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_TIMEOUT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    const stderr = logs.find(l => l.streamType === "stderr");
    expect(stderr).toBeTruthy();
    expect(stderr!.content).toMatch(/^Timed out:/);
    expect(stderr!.content).not.toMatch(/^Cancelled:/);
  });

  it("preserves running status on shutdown abort (for resume on restart)", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_SHUTDOWN_ABORT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    // Must stay RUNNING so resetStaleTasks re-queues on next boot
    expect(u.status).toBe("running");
    // And no terminal stderr log should be written
    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some(l => l.content.startsWith("Cancelled:"))).toBe(false);
    expect(logs.some(l => l.content.startsWith("Failed:"))).toBe(false);
  });

  it("user-initiated AbortError is classified as cancelled, not failed", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_ABORT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("cancelled");
    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some(l => l.content.startsWith("Cancelled:"))).toBe(true);
  });

  it("auto-retries failed task with retryCount < maxRetries", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_GENERIC",
      status: "queued",
      maxRetries: 1,
      retryCount: 0,
    }).returning().get()!;

    await taskExecutor.execute(task.id);
    // wait for setTimeout 0 retry to schedule
    await new Promise((r) => setTimeout(r, 20));

    const allTasks = db.select().from(tasks).all();
    // Original should be failed, retry task should exist
    const retry = allTasks.find((t) => t.parentTaskId === task.id);
    expect(retry).toBeTruthy();
    expect(retry!.retryCount).toBe(1);
    expect(retry!.label).toContain("retry-");
  });

  it("does not re-update a task that was cancelled externally", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "THROW_GENERIC",
      status: "queued",
    }).returning().get()!;

    // Simulate external cancellation right before the session throws
    beforeThrowHook = () => {
      db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, task.id)).run();
    };

    await taskExecutor.execute(task.id);
    beforeThrowHook = null;

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    // Must NOT be overwritten to "failed"
    expect(u.status).toBe("cancelled");
  });
});

describe("TaskExecutor — emitting events", () => {
  it("handles tool_call + tool_result + text events", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "EMIT_TOOL please",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some((l) => l.content.startsWith("$ "))).toBe(true); // Bash
    expect(logs.some((l) => l.content.includes("📄 Read"))).toBe(true);
    expect(logs.some((l) => l.content.includes("✏️ Write"))).toBe(true);
    expect(logs.some((l) => l.content.includes("✏️ Edit"))).toBe(true);
    expect(logs.some((l) => l.content.includes("📂 Glob"))).toBe(true);
    expect(logs.some((l) => l.content.includes("🔍 Grep"))).toBe(true);
    expect(logs.some((l) => l.content.includes("📂 ListDir"))).toBe(true);
    expect(logs.some((l) => l.content.includes("🔧 SomethingElse"))).toBe(true);
    expect(logs.some((l) => l.content.startsWith("✓ Bash: output"))).toBe(true);
  });

  it("broadcasts permission_request events to ws", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "EMIT_PERM please",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const permBroadcasts = (wsManager.broadcast as any).mock.calls.filter(
      (c: any[]) => c[1]?.type === "permission_request",
    );
    expect(permBroadcasts.length).toBe(1);
    expect(permBroadcasts[0][1].payload.tool_name).toBe("Bash");

    // Log line also written
    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some((l) => l.content.includes("Permission request"))).toBe(true);
  });

  it("broadcasts usage events and stores running metrics", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "EMIT_USAGE_EVT please",
      status: "queued",
    }).returning().get()!;

    const execPromise = taskExecutor.execute(task.id);
    // Wait a tick for metrics to be populated
    await execPromise;

    const metricCalls = (wsManager.broadcast as any).mock.calls.filter(
      (c: any[]) => c[1]?.type === "task_metrics",
    );
    expect(metricCalls.length).toBeGreaterThan(0);
  });

  it("logs error when session emits error event", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "EMIT_ERROR please",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task.id)).all();
    expect(logs.some((l) => l.content.includes("ERROR: something bad"))).toBe(true);
  });
});

describe("TaskExecutor — approval + usage + provider inference", () => {
  it("sets status=pending_approval when task.requiresApproval=true", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "needs approval",
      status: "queued",
      requiresApproval: true,
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("pending_approval");
  });

  it("saves usage with inferred provider for openai-like model", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "ok",
      status: "queued",
      model: "gpt-4o-mini",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const records = db.select().from(usageRecords).where(eq(usageRecords.taskId, task.id)).all();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].provider).toBe("openai");
  });

  it("saves usage with inferred provider for gemini-like model", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "ok",
      status: "queued",
      model: "gemini-pro",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const records = db.select().from(usageRecords).where(eq(usageRecords.taskId, task.id)).all();
    expect(records[0].provider).toBe("google");
  });

  it("saves usage with inferred provider for mistral-like model", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "ok",
      status: "queued",
      model: "mistral-large",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const records = db.select().from(usageRecords).where(eq(usageRecords.taskId, task.id)).all();
    expect(records[0].provider).toBe("mistral");
  });
});

describe("TaskExecutor — timeout resolution", () => {
  // Precedence: task.timeoutSeconds > config.yaml defaultTimeout > undefined.
  // config.yaml is the portable source of truth — UI writes there, and task 77
  // in the wild timed out because the executor was reading a stale DB column
  // instead of the config file the user had edited.

  it("uses task.timeoutSeconds when set, ignoring project config", async () => {
    const p = db.insert(projects).values({
      name: "t-over",
      path: "/tmp/t-over",
    } as any).returning().get()!;
    (loadProjectConfig as any).mockReturnValue({ defaultTimeout: 10 });

    const task = db.insert(tasks).values({
      projectId: p.id,
      prompt: "ok",
      status: "queued",
      timeoutSeconds: 600,
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    expect(createdSessions.at(-1).opts.timeoutSeconds).toBe(600);
  });

  it("falls back to config.yaml defaultTimeout when task has none", async () => {
    const p = db.insert(projects).values({
      name: "t-fallback",
      path: "/tmp/t-fallback",
    } as any).returning().get()!;
    (loadProjectConfig as any).mockReturnValue({ defaultTimeout: 10 });

    const task = db.insert(tasks).values({
      projectId: p.id,
      prompt: "ok",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    expect(createdSessions.at(-1).opts.timeoutSeconds).toBe(10);
    expect(loadProjectConfig).toHaveBeenCalledWith("/tmp/t-fallback");
  });

  it("passes undefined (no timeout) when neither task nor config specifies one", async () => {
    const p = db.insert(projects).values({
      name: "t-none",
      path: "/tmp/t-none",
    } as any).returning().get()!;

    const task = db.insert(tasks).values({
      projectId: p.id,
      prompt: "ok",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    expect(createdSessions.at(-1).opts.timeoutSeconds).toBeUndefined();
  });

  it("skips config.yaml load when project has no path", async () => {
    const p = db.insert(projects).values({ name: "t-no-path" } as any).returning().get()!;

    const task = db.insert(tasks).values({
      projectId: p.id,
      prompt: "ok",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    expect(loadProjectConfig).not.toHaveBeenCalled();
    expect(createdSessions.at(-1).opts.timeoutSeconds).toBeUndefined();
  });

  it("classifies config-yaml timeout as timed_out (not cancelled)", async () => {
    // Simulates task 77 in the wild: config.yaml had defaultTimeout: 10, the
    // session exceeded it, and we want it reported as timed_out — not as a
    // user cancel.
    const p = db.insert(projects).values({
      name: "t-timeout-class",
      path: "/tmp/t-timeout-class",
    } as any).returning().get()!;
    (loadProjectConfig as any).mockReturnValue({ defaultTimeout: 10 });

    const task = db.insert(tasks).values({
      projectId: p.id,
      prompt: "THROW_TIMEOUT",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("timed_out");
    expect(u.errorMessage).toMatch(/timed out/i);
  });
});

describe("TaskExecutor — resetStaleTasks", () => {
  it("re-queues running tasks left orphaned", () => {
    // Insert a running task without an active session
    const t = db.insert(tasks).values({
      projectId,
      prompt: "stale",
      status: "running",
      startedAt: "2025-01-01T00:00:00Z",
    }).returning().get()!;

    const requeued = taskExecutor.resetStaleTasks();
    expect(requeued).toContain(t.id);

    const reset = db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
    expect(reset.status).toBe("queued");
    expect(reset.startedAt).toBeNull();
  });

  it("returns empty array when no stale running tasks", () => {
    const ids = taskExecutor.resetStaleTasks();
    expect(Array.isArray(ids)).toBe(true);
  });

  it("adopts DB-queued tasks orphaned by a prior daemon restart", () => {
    // After a restart the in-memory queue is empty, so any `queued` task in
    // DB that isn't currently owned by a session must be re-enqueued.
    const t = db.insert(tasks).values({
      projectId,
      prompt: "orphan-queued",
      status: "queued",
    }).returning().get()!;

    const requeued = taskExecutor.resetStaleTasks();
    expect(requeued).toContain(t.id);

    const after = db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
    expect(after.status).toBe("queued");
  });
});

describe("TaskExecutor — cancel + isRunning + getMetrics", () => {
  it("cancels a task from the queue", async () => {
    taskExecutor.setMaxConcurrent(0);

    const task = db.insert(tasks).values({
      projectId,
      prompt: "queued-cancel",
      status: "queued",
    }).returning().get()!;

    taskExecutor.execute(task.id);
    const cancelled = taskExecutor.cancel(task.id);

    expect(cancelled).toBe(false); // not in sessions, but removed from queue
    taskExecutor.setMaxConcurrent(5);
  });

  it("resolvePermission returns false when session not found", () => {
    expect(
      taskExecutor.resolvePermission(999999, "req", { behavior: "allow" }),
    ).toBe(false);
  });

  it("getMetrics returns null for unknown task", () => {
    expect(taskExecutor.getMetrics(999999)).toBeNull();
  });

  it("cancel() propagates 'user' reason to the active session", async () => {
    // Use HANG_UNTIL_ABORT so the mock waits for abort() before returning
    // — lets us observe the reason the executor passes in.
    const task = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
    }).returning().get()!;

    const runPromise = taskExecutor.execute(task.id);
    // Let the mock session register with the executor
    await new Promise((r) => setImmediate(r));

    const ok = taskExecutor.cancel(task.id);
    expect(ok).toBe(true);

    await runPromise;

    const session = createdSessions.at(-1);
    expect(session.abortReason).toBe("user");
  });

  it("cancelAll() propagates 'shutdown' reason and leaves tasks running", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
    }).returning().get()!;

    const runPromise = taskExecutor.execute(task.id);
    await new Promise((r) => setImmediate(r));

    taskExecutor.cancelAll();
    await runPromise;

    const session = createdSessions.at(-1);
    expect(session.abortReason).toBe("shutdown");

    // Shutdown abort must NOT mark task terminal — it will resume on restart
    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("running");
  });
});

describe("TaskExecutor — per-key concurrency", () => {
  it("runs tasks concurrently when they use different assigned keys", async () => {
    const secondKey = db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "anthropic-messages",
      label: "k2",
      keyValue: "sk-ant-api-k2",
      isActive: 1,
      priority: 1,
    } as any).returning().get()!;

    const baseKey = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.label, "k")).get()!;
    taskExecutor.setMaxConcurrent(1);

    const t1 = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
      assignedKeyId: baseKey.id,
    }).returning().get()!;
    const t2 = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
      assignedKeyId: secondKey.id,
    }).returning().get()!;

    const p1 = taskExecutor.execute(t1.id);
    const p2 = taskExecutor.execute(t2.id);
    await new Promise((r) => setImmediate(r));

    expect(taskExecutor.isRunning(t1.id)).toBe(true);
    expect(taskExecutor.isRunning(t2.id)).toBe(true);

    expect(taskExecutor.cancel(t1.id)).toBe(true);
    expect(taskExecutor.cancel(t2.id)).toBe(true);
    await Promise.all([p1, p2]);

    taskExecutor.setMaxConcurrent(5);
    db.delete(aiProviderKeys).where(eq(aiProviderKeys.id, secondKey.id)).run();
  });

  it("falls back to the next available key when the top-priority key is saturated", async () => {
    const secondKey = db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "anthropic-messages",
      label: "k-fallback",
      keyValue: "sk-ant-api-k-fallback",
      isActive: 1,
      priority: 1,
    } as any).returning().get()!;

    taskExecutor.setMaxConcurrent(1);

    const first = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
    }).returning().get()!;
    const second = db.insert(tasks).values({
      projectId,
      prompt: "HANG_UNTIL_ABORT",
      status: "queued",
    }).returning().get()!;

    const p1 = taskExecutor.execute(first.id);
    await new Promise((r) => setImmediate(r));
    const p2 = taskExecutor.execute(second.id);
    await new Promise((r) => setImmediate(r));

    const firstRow = db.select().from(tasks).where(eq(tasks.id, first.id)).get()!;
    const secondRow = db.select().from(tasks).where(eq(tasks.id, second.id)).get()!;
    expect(firstRow.assignedKeyId).toBeTruthy();
    expect(secondRow.assignedKeyId).toBeTruthy();
    expect(secondRow.assignedKeyId).toBe(secondKey.id);

    expect(taskExecutor.isRunning(first.id)).toBe(true);
    expect(taskExecutor.isRunning(second.id)).toBe(true);

    expect(taskExecutor.cancel(first.id)).toBe(true);
    expect(taskExecutor.cancel(second.id)).toBe(true);
    await Promise.all([p1, p2]);

    taskExecutor.setMaxConcurrent(5);
    db.delete(aiProviderKeys).where(eq(aiProviderKeys.id, secondKey.id)).run();
  });
});
