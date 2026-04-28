import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimitScheduler } from "../../../services/agents/rate-limit-scheduler.js";
import { createTestDb } from "../../helpers.js";
import { setDb, closeDb } from "../../../db/index.js";

describe("RateLimitScheduler", () => {
  let s: RateLimitScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    s = new RateLimitScheduler();
  });

  afterEach(() => {
    s.cancelAll();
    vi.useRealTimers();
  });

  it("fires the registered handler at resumeAtMs", async () => {
    const handler = vi.fn();
    s.registerHandler("task", handler);
    s.schedule({ kind: "task", id: 42, resumeAtMs: Date.now() + 1000 });

    expect(handler).not.toHaveBeenCalled();
    expect(s.isScheduled("task", 42)).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledWith(42);
    expect(s.isScheduled("task", 42)).toBe(false);
  });

  it("supports both task and chat kinds independently", async () => {
    const taskHandler = vi.fn();
    const chatHandler = vi.fn();
    s.registerHandler("task", taskHandler);
    s.registerHandler("chat", chatHandler);

    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() + 500 });
    s.schedule({ kind: "chat", id: 1, resumeAtMs: Date.now() + 1000 });

    await vi.advanceTimersByTimeAsync(500);
    expect(taskHandler).toHaveBeenCalledWith(1);
    expect(chatHandler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(chatHandler).toHaveBeenCalledWith(1);
  });

  it("re-scheduling the same row replaces the prior timer", async () => {
    const handler = vi.fn();
    s.registerHandler("task", handler);
    s.schedule({ kind: "task", id: 7, resumeAtMs: Date.now() + 5000 });
    s.schedule({ kind: "task", id: 7, resumeAtMs: Date.now() + 100 }); // earlier

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);

    // Advancing past the original time should NOT fire again
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("cancel clears the timer before it fires", async () => {
    const handler = vi.fn();
    s.registerHandler("task", handler);
    s.schedule({ kind: "task", id: 9, resumeAtMs: Date.now() + 1000 });
    s.cancel("task", 9);

    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).not.toHaveBeenCalled();
    expect(s.isScheduled("task", 9)).toBe(false);
  });

  it("cancel for an unknown row is a no-op", () => {
    expect(() => s.cancel("task", 999)).not.toThrow();
  });

  it("cancelAll clears every armed timer", async () => {
    const handler = vi.fn();
    s.registerHandler("task", handler);
    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() + 500 });
    s.schedule({ kind: "task", id: 2, resumeAtMs: Date.now() + 500 });
    s.schedule({ kind: "task", id: 3, resumeAtMs: Date.now() + 500 });

    s.cancelAll();

    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("past-due resumeAtMs fires after a small floor (no immediate hammer)", async () => {
    const handler = vi.fn();
    s.registerHandler("task", handler);
    // 10 seconds in the past — should fire on next tick, not synchronously
    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() - 10_000 });

    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(handler).toHaveBeenCalledWith(1);
  });

  it("warns and skips if no handler registered for kind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() + 100 });
    await vi.advanceTimersByTimeAsync(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("handler errors are logged and don't crash the scheduler", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    s.registerHandler("task", handler);
    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() + 100 });

    await vi.advanceTimersByTimeAsync(200);
    expect(err).toHaveBeenCalled();
    expect(s.isScheduled("task", 1)).toBe(false);
    err.mockRestore();
  });

  it("scheduledKeys exposes armed entries deterministically", () => {
    s.schedule({ kind: "task", id: 1, resumeAtMs: Date.now() + 1000 });
    s.schedule({ kind: "chat", id: 5, resumeAtMs: Date.now() + 1000 });
    expect(s.scheduledKeys).toEqual(["chat:5", "task:1"]);
  });
});

describe("RateLimitScheduler.recoverFromDatabase", () => {
  let s: RateLimitScheduler;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.useFakeTimers();
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    s = new RateLimitScheduler();
  });

  afterEach(() => {
    s.cancelAll();
    closeDb();
    vi.useRealTimers();
  });

  it("re-arms timers for rate_limited tasks and chats", async () => {
    const futureMs = Date.now() + 10_000;
    testDb.sqlite.prepare(
      `INSERT INTO tasks (status, resume_at, claude_session_id) VALUES ('rate_limited', ?, 'sess-t')`,
    ).run(futureMs);
    testDb.sqlite.prepare(
      `INSERT INTO chats (status, resume_at, claude_session_id) VALUES ('rate_limited', ?, 'sess-c')`,
    ).run(futureMs);

    const taskHandler = vi.fn();
    const chatHandler = vi.fn();
    s.registerHandler("task", taskHandler);
    s.registerHandler("chat", chatHandler);

    const counts = s.recoverFromDatabase();
    expect(counts).toEqual({ tasks: 1, chats: 1 });

    await vi.advanceTimersByTimeAsync(10_500);
    expect(taskHandler).toHaveBeenCalled();
    expect(chatHandler).toHaveBeenCalled();
  });

  it("ignores rows in other statuses", () => {
    testDb.sqlite.prepare(
      `INSERT INTO tasks (status, resume_at) VALUES ('failed', ?)`,
    ).run(Date.now() + 10_000);

    const counts = s.recoverFromDatabase();
    expect(counts.tasks).toBe(0);
  });

  it("ignores rate_limited rows with NULL resume_at (defensive)", () => {
    testDb.sqlite.prepare(
      `INSERT INTO tasks (status, resume_at) VALUES ('rate_limited', NULL)`,
    ).run();

    const counts = s.recoverFromDatabase();
    expect(counts.tasks).toBe(0);
  });
});
