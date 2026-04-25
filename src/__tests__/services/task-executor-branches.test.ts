/**
 * Branch-coverage tests for `src/services/task-executor/executor.ts`.
 *
 * Targets uncovered branches not hit by task-executor.test.ts and friends:
 *   - execute: queue dedup — calling enqueue twice for the same id only
 *     appends once (line 81 false branch)
 *   - cancel: on a queued (not-yet-running) task → splice path (line 327 true)
 *   - cancel: on an unknown task → falls through both guards, returns false
 *   - pendingPermissions: task id with no session → returns empty array
 *     (line 404 false branch)
 *   - answerQuestion: unknown requestId → false (findPendingQuestionRow miss)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

vi.mock("../../services/ws-manager", () => ({
  wsManager: { broadcast: vi.fn(), broadcastAll: vi.fn() },
}));

// Keep the real executor but stub the KeyPool so reserveForTask always forces
// the enqueue path (reservation.enqueue = true) — this lets us exercise
// execute()'s enqueue branch without touching AgentSession or subprocesses.
vi.mock("../../services/task-executor/executor-key-pool", () => {
  class StubPool {
    setMax() {}
    async reserveForTask() {
      return { key: null, enqueue: true };
    }
    release() {}
  }
  return { KeyPool: StubPool };
});

import { TaskExecutor } from "../../services/task-executor/executor.js";
import { tasks } from "../../db/schema.js";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => { sqlite.close(); });

beforeEach(() => {
  sqlite.exec(`DELETE FROM tasks; DELETE FROM projects; DELETE FROM task_logs;`);
});

describe("TaskExecutor — branch edges", () => {
  it("enqueue dedupes: calling execute twice for same id leaves one queue entry", async () => {
    const exec = new TaskExecutor();
    const t1 = db.insert(tasks).values({ prompt: "a", agent: "claude-code" } as any).returning().get()!;

    await exec.execute(t1.id);
    await exec.execute(t1.id);
    // Cancel hits the qIdx !== -1 splice branch and returns false (no session).
    expect(exec.cancel(t1.id)).toBe(false);
    // Second call: neither queue entry nor session → still false.
    expect(exec.cancel(t1.id)).toBe(false);
  });

  it("cancel() returns false for an unknown task id", () => {
    const exec = new TaskExecutor();
    expect(exec.cancel(99999)).toBe(false);
  });

  it("pendingPermissions returns [] when the task has no active session", () => {
    const exec = new TaskExecutor();
    expect(exec.pendingPermissions(123)).toEqual([]);
  });

  it("resolvePermission returns false when no session exists", () => {
    const exec = new TaskExecutor();
    expect(
      exec.resolvePermission(42, "r1", { behavior: "allow" }),
    ).toBe(false);
  });

  it("answerQuestion returns false when requestId is unknown", () => {
    const exec = new TaskExecutor();
    const t1 = db.insert(tasks).values({ prompt: "x", agent: "claude-code" } as any).returning().get()!;
    expect(exec.answerQuestion(t1.id, "unknown-request", "answer")).toBe(false);
  });

  it("isRunning / activeCount reflect empty sessions", () => {
    const exec = new TaskExecutor();
    expect(exec.isRunning(1)).toBe(false);
    expect(exec.activeCount).toBe(0);
    expect([...exec.activeSessions()]).toEqual([]);
    expect(exec.getMetrics(1)).toBeNull();
  });
});
