import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import Database from "better-sqlite3";
import {
  createMilestone, createSlice, createPlanTask, updatePlanTask,
} from "../../services/plan-store/index.js";

// Mock task-executor so the emitter contract is the only thing under test.
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: { execute: vi.fn(() => Promise.resolve()) },
}));

import {
  syncPlanFromExecutionTask,
  taskTerminalEvents,
  type TaskTerminalEvent,
} from "../../services/auto-executor.js";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM tasks; DELETE FROM projects;`);
  taskTerminalEvents.removeAllListeners();
});

function makePlanLinkedExec(status: string, errorMessage?: string) {
  const projPath = mkdtempSync(join(tmpdir(), "tte-"));
  const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
  const m = createMilestone(projPath, { title: "M" });
  const s = createSlice(projPath, m.slug, { title: "S" });
  const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });
  const exec = db
    .insert(tasks)
    .values({ projectId: proj.id, status, errorMessage } as any)
    .returning()
    .get()!;
  updatePlanTask(projPath, m.slug, s.slug, pt.slug, {
    executionTaskId: exec.id,
    status: "active",
  });
  return { projPath, execId: exec.id };
}

describe("task_terminal_event_emitter_typed_payload", () => {
  it("exports a TypedEventEmitter instance with on/emit/off/listenerCount", () => {
    expect(taskTerminalEvents).toBeDefined();
    expect(typeof taskTerminalEvents.emit).toBe("function");
    expect(typeof taskTerminalEvents.on).toBe("function");
    expect(typeof taskTerminalEvents.off).toBe("function");
    expect(typeof taskTerminalEvents.listenerCount).toBe("function");
    expect(taskTerminalEvents.listenerCount()).toBe(0);
  });

  it("emits a typed payload when exec task transitions to DONE", () => {
    const events: TaskTerminalEvent[] = [];
    taskTerminalEvents.on((e) => events.push(e));

    const { projPath, execId } = makePlanLinkedExec("done");
    syncPlanFromExecutionTask(execId);

    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe(execId);
    expect(events[0].status).toBe("done");
    expect(events[0].error).toBeUndefined();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("emits with error string for FAILED exec status", () => {
    const events: TaskTerminalEvent[] = [];
    taskTerminalEvents.on((e) => events.push(e));

    const { projPath, execId } = makePlanLinkedExec("failed", "boom");
    syncPlanFromExecutionTask(execId);

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
    expect(events[0].error).toBe("boom");
    rmSync(projPath, { recursive: true, force: true });
  });

  it("emits for CANCELLED and TIMED_OUT terminal statuses", () => {
    for (const status of ["cancelled", "timed_out"] as const) {
      const events: TaskTerminalEvent[] = [];
      taskTerminalEvents.removeAllListeners();
      taskTerminalEvents.on((e) => events.push(e));

      const { projPath, execId } = makePlanLinkedExec(status);
      syncPlanFromExecutionTask(execId);

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe(status);
      rmSync(projPath, { recursive: true, force: true });
    }
  });

  it("does NOT emit for non-terminal statuses (running, pending_approval)", () => {
    const events: TaskTerminalEvent[] = [];
    taskTerminalEvents.on((e) => events.push(e));

    for (const status of ["running", "pending_approval"] as const) {
      const { projPath, execId } = makePlanLinkedExec(status);
      syncPlanFromExecutionTask(execId);
      rmSync(projPath, { recursive: true, force: true });
    }

    expect(events).toHaveLength(0);
  });

  it("does NOT emit when exec status is queued (no plan-status mapping)", () => {
    const events: TaskTerminalEvent[] = [];
    taskTerminalEvents.on((e) => events.push(e));

    const { projPath, execId } = makePlanLinkedExec("queued");
    syncPlanFromExecutionTask(execId);

    expect(events).toHaveLength(0);
    rmSync(projPath, { recursive: true, force: true });
  });

  it("supports off() to remove a listener", () => {
    const events: TaskTerminalEvent[] = [];
    const listener = (e: TaskTerminalEvent) => events.push(e);

    taskTerminalEvents.on(listener);
    taskTerminalEvents.off(listener);

    const { projPath, execId } = makePlanLinkedExec("done");
    syncPlanFromExecutionTask(execId);

    expect(events).toHaveLength(0);
    rmSync(projPath, { recursive: true, force: true });
  });
});
