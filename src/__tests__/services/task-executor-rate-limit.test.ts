import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, aiProviderKeys, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

/**
 * Integration test for the task-executor rate-limit pause + resume path.
 *
 * Strategy:
 *   - Mock AgentSession so the first run() throws a synthetic "rate limit"
 *     error with a real Anthropic-shaped 429 envelope (status + headers with
 *     `retry-after-ms`). This is what the SDK actually raises in production.
 *   - Verify the executor parks the task (status='rate_limited', resumeAt set,
 *     scheduler timer armed).
 *   - Use vi.useFakeTimers to fast-forward to the wake-up — the second run()
 *     succeeds (returns a result) and the task lands in 'done'.
 *
 * What this guards: the wiring between `classifyLimit`, `parkRateLimited`,
 * `rateLimitScheduler.schedule`, and `resumeFromRateLimit`. Each piece has its
 * own unit tests; this checks they actually compose end-to-end.
 */

let runAttempt = 0;
let runOutcomes: Array<"throw_429" | "throw_429_again" | "ok"> = [];

vi.mock("../../services/agent-session/index", () => {
  const EventEmitter = require("events").EventEmitter;
  class MockAgentSession extends EventEmitter {
    constructor(_opts: any) { super(); }
    async run() {
      const outcome = runOutcomes[runAttempt++] ?? "ok";
      if (outcome === "throw_429" || outcome === "throw_429_again") {
        const err: any = new Error("rate limited");
        err.status = 429;
        err.headers = new Map<string, string>([["retry-after-ms", "5000"]]);
        throw err;
      }
      this.emit("text", "ok");
      return {
        inputTokens: 10, outputTokens: 5,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        totalCostUsd: 0, turns: 1, durationMs: 1,
      };
    }
    abort() {}
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/ws-manager", () => ({
  wsManager: {
    broadcast: vi.fn(),
    broadcastAll: vi.fn(),
    broadcastTaskStatus: vi.fn(),
    broadcastChatStatus: vi.fn(),
  },
}));

vi.mock("../../services/claude/skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(),
}));
vi.mock("../../services/claude/mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(),
}));
vi.mock("../../services/git-context", () => ({
  buildCodebaseContext: vi.fn(async () => ""),
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn() };
});

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  db.insert(aiProviderKeys).values({
    provider: "anthropic",
    providerType: "anthropic-messages",
    label: "test-key",
    keyValue: "sk-ant-api-test",
    isActive: true,
    priority: 0,
  }).run();
  db.insert(projects).values({ name: "rl-proj" }).run();
});

afterAll(() => sqlite.close());

import { taskExecutor } from "../../services/task-executor/index.js";
import { wsManager } from "../../services/ws-manager.js";
import { rateLimitScheduler } from "../../services/agents/rate-limit-scheduler.js";
import { TaskStatus } from "../../lib/types.js";

describe("TaskExecutor rate-limit pause/resume", () => {
  beforeEach(() => {
    runAttempt = 0;
    runOutcomes = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    rateLimitScheduler.cancelAll();
    vi.useRealTimers();
  });

  it("parks the task and broadcasts rate_limited when the run hits a 429", async () => {
    runOutcomes = ["throw_429"];

    const task = db.insert(tasks).values({
      projectId: 1, prompt: "trigger 429", status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const updated = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(updated!.status).toBe(TaskStatus.RATE_LIMITED);
    expect(updated!.resumeAt).toBeGreaterThan(Date.now());
    // headers say 5000ms — should be within the next 6s
    expect(updated!.resumeAt!).toBeLessThan(Date.now() + 7000);
    expect(updated!.errorMessage).toContain("rate limited");

    expect((wsManager.broadcastTaskStatus as any)).toHaveBeenCalledWith(
      task!.id,
      "rate_limited",
      expect.objectContaining({ resume_at: expect.any(Number) }),
    );

    expect(rateLimitScheduler.isScheduled("task", task!.id)).toBe(true);
  });

  it("auto-resumes via the scheduler and reaches 'done'", async () => {
    vi.useFakeTimers();
    runOutcomes = ["throw_429", "ok"];

    const task = db.insert(tasks).values({
      projectId: 1, prompt: "auto resume", status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const parked = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(parked!.status).toBe(TaskStatus.RATE_LIMITED);

    // Fast-forward past the retry-after-ms window
    await vi.advanceTimersByTimeAsync(6000);
    // Let the executor's microtask queue drain
    await vi.runAllTimersAsync();

    const final = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(final!.status).toBe(TaskStatus.DONE);
    expect(final!.resumeAt).toBeNull();
  });

  it("re-parks if the resume hits the limit again", async () => {
    vi.useFakeTimers();
    runOutcomes = ["throw_429", "throw_429_again", "ok"];

    const task = db.insert(tasks).values({
      projectId: 1, prompt: "double park", status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    // First wake-up — advance just past the first retry-after-ms (5s), but
    // NOT enough to fire the second timer that the re-park installs.
    await vi.advanceTimersByTimeAsync(5500);
    // Microtask flush so the resume handler's awaits settle.
    await Promise.resolve(); await Promise.resolve();

    // After re-park: still rate_limited
    const reparked = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(reparked!.status).toBe(TaskStatus.RATE_LIMITED);

    // Second wake-up — drain everything to completion.
    await vi.runAllTimersAsync();

    const final = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(final!.status).toBe(TaskStatus.DONE);
  });

  it("cancel during pause clears the timer and prevents auto-resume", async () => {
    vi.useFakeTimers();
    runOutcomes = ["throw_429", "ok"];

    const task = db.insert(tasks).values({
      projectId: 1, prompt: "cancel during pause", status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);
    expect(rateLimitScheduler.isScheduled("task", task!.id)).toBe(true);

    // Simulate the cancel route — taskExecutor.cancel must clear the timer.
    taskExecutor.cancel(task!.id);
    expect(rateLimitScheduler.isScheduled("task", task!.id)).toBe(false);

    // Manually flip to cancelled (the route does this; cancel() only signals
    // the in-memory session)
    db.update(tasks).set({ status: "cancelled", resumeAt: null }).where(eq(tasks.id, task!.id)).run();

    // Even if a timer DID fire (it shouldn't), the resume handler bails out
    // because status !== rate_limited.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const final = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(final!.status).toBe("cancelled");
    // Run attempt count should still be 1 — the resume never ran.
    expect(runAttempt).toBe(1);
  });
});
