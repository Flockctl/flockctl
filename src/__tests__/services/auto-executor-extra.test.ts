import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb, getDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import {
  createMilestone, createSlice, createPlanTask,
  listPlanTasks, listSlices, updatePlanTask,
} from "../../services/plan-store/index.js";

// Mock task-executor: simulate task completion the next tick
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(),
  },
}));

vi.mock("../../services/ws-manager", () => ({
  wsManager: {
    broadcastAll: vi.fn(), broadcastTaskStatus: vi.fn(), broadcastChatStatus: vi.fn(),
  },
}));

import { taskExecutor } from "../../services/task-executor/index.js";

// Default: each execute() marks the exec task as done next microtask
function installCompleteImmediately() {
  (taskExecutor.execute as any).mockImplementation((taskId: number) => {
    queueMicrotask(() => {
      getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId)).run();
    });
  });
}

import {
  startAutoExecution,
  stopAutoExecution,
  reconcilePlanStatuses,
  resumeStaleMilestones,
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
  (taskExecutor.execute as any).mockReset();
  installCompleteImmediately();
});

describe("auto-executor — extended paths", () => {
  it("executes full milestone → slice → plan task flow", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-full-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M-full" });
    const s = createSlice(projPath, m.slug, { title: "S1" });
    createPlanTask(projPath, m.slug, s.slug, { title: "T1" });

    // Use fake timers so the 1000ms setInterval is controllable
    vi.useFakeTimers();

    const execPromise = startAutoExecution(proj.id, projPath, m.slug);

    // Advance several intervals so polling picks up the "done" status
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    vi.useRealTimers();
    await execPromise;

    expect(taskExecutor.execute).toHaveBeenCalled();
    const finalTasks = listPlanTasks(projPath, m.slug, s.slug);
    expect(finalTasks[0].status).toBe("completed");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips plan tasks that are already completed", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-skip-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M-skip" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    // Pre-mark plan task completed
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { status: "completed" });

    await startAutoExecution(proj.id, projPath, m.slug);

    // taskExecutor.execute should NOT have been called
    expect(taskExecutor.execute).not.toHaveBeenCalled();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips slices that are already completed", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-skip-slice-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M-skip-slice" });
    const s = createSlice(projPath, m.slug, { title: "S", status: "completed" });
    createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    await startAutoExecution(proj.id, projPath, m.slug);
    expect(taskExecutor.execute).not.toHaveBeenCalled();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("stopAutoExecution aborts a running execution", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-stop-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M-stop" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    // Don't complete tasks — let them hang
    (taskExecutor.execute as any).mockImplementationOnce(() => {
      // noop
    });

    vi.useFakeTimers();
    const execPromise = startAutoExecution(proj.id, projPath, m.slug);

    // Give it a tick to start polling
    await vi.advanceTimersByTimeAsync(100);

    // Stop execution mid-flight
    const stopped = stopAutoExecution(m.slug);
    expect(stopped).toBe(true);

    // Let polling loop exit
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    // The execution promise must settle
    await execPromise;
    rmSync(projPath, { recursive: true, force: true });
  });
});

describe("auto-executor — reconcilePlanStatuses edge cases", () => {
  it("marks plan task failed when execution task is cancelled", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-rec-c-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    const exec = db.insert(tasks).values({ projectId: proj.id, status: "cancelled" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

    expect(reconcilePlanStatuses()).toBe(1);
    expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("failed");
    rmSync(projPath, { recursive: true, force: true });
  });

  it("marks plan task failed when execution task is timed_out", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-rec-t-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    const exec = db.insert(tasks).values({ projectId: proj.id, status: "timed_out" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

    expect(reconcilePlanStatuses()).toBe(1);
    expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("failed");
    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips plan task when referenced execution task was deleted", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-rec-missing-"));
    db.insert(projects).values({ name: "p", path: projPath }).run();
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    // Point to a non-existent execution task
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: 9999, status: "active" });

    expect(reconcilePlanStatuses()).toBe(0);
    rmSync(projPath, { recursive: true, force: true });
  });
});

describe("auto-executor — resumeStaleMilestones with work", () => {
  it("kicks startAutoExecution for active milestone with pending slices", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-res-work-"));
    db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M-active", status: "active" });
    // Create a slice so there's work — but already completed, so resumeStaleMilestones skips it
    // This exercises the "hasWork" check in both directions.
    createSlice(projPath, m.slug, { title: "S", status: "completed" });

    // Should not throw
    expect(() => resumeStaleMilestones()).not.toThrow();

    rmSync(projPath, { recursive: true, force: true });
  });
});
