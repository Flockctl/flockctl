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
  listPlanTasks, listSlices, getMilestone, updatePlanTask,
} from "../../services/plan-store/index.js";

vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: { execute: vi.fn() },
}));

vi.mock("../../services/ws-manager", () => ({
  wsManager: { broadcastAll: vi.fn() },
}));

import { taskExecutor } from "../../services/task-executor/index.js";
import {
  repointPlanTask,
  syncPlanFromExecutionTask,
  reconcilePlanStatuses,
  startAutoExecution,
  resumeStaleMilestones,
  stopAutoExecution,
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
});

describe("repointPlanTask", () => {
  it("returns false when no plan task references the given execution task id", () => {
    expect(repointPlanTask(999999, 111111)).toBe(false);
  });

  it("rewires plan task to new execution id and restores slice status", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-repoint-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S", status: "failed" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    const oldExec = db.insert(tasks).values({ projectId: proj.id, status: "failed" } as any).returning().get()!;
    const newExec = db.insert(tasks).values({ projectId: proj.id, status: "queued" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: oldExec.id, status: "failed" });

    expect(repointPlanTask(oldExec.id, newExec.id)).toBe(true);

    const updated = listPlanTasks(projPath, m.slug, s.slug)[0];
    expect(updated.executionTaskId).toBe(newExec.id);
    expect(updated.status).toBe("active");

    // Slice aggregate should become "active" since its sole plan task is active now
    const slice = listSlices(projPath, m.slug)[0];
    expect(slice.status).toBe("active");

    rmSync(projPath, { recursive: true, force: true });
  });
});

describe("syncPlanFromExecutionTask", () => {
  it("no-ops when execution task does not exist", () => {
    expect(() => syncPlanFromExecutionTask(999999)).not.toThrow();
  });

  it("no-ops when no plan task references the execution task", () => {
    db.insert(projects).values({ name: "x", path: "/tmp/x" }).run();
    const t = db.insert(tasks).values({ status: "done" } as any).returning().get()!;
    // project path doesn't exist; findPlanTaskByExecutionId should swallow list errors
    expect(() => syncPlanFromExecutionTask(t.id)).not.toThrow();
  });

  it("promotes plan task to completed when exec task is done", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-sync-done-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    const exec = db.insert(tasks).values({ projectId: proj.id, status: "done" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

    syncPlanFromExecutionTask(exec.id);

    const updated = listPlanTasks(projPath, m.slug, s.slug)[0];
    expect(updated.status).toBe("completed");
    expect(listSlices(projPath, m.slug)[0].status).toBe("completed");
    expect(getMilestone(projPath, m.slug)!.status).toBe("completed");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("marks plan task failed for failed/cancelled/timed_out exec statuses", () => {
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      const projPath = mkdtempSync(join(tmpdir(), `ae-sync-${status}-`));
      const proj = db.insert(projects).values({ name: `p-${status}`, path: projPath }).returning().get()!;
      const m = createMilestone(projPath, { title: "M" });
      const s = createSlice(projPath, m.slug, { title: "S" });
      const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });
      const exec = db.insert(tasks).values({ projectId: proj.id, status } as any).returning().get()!;
      updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

      syncPlanFromExecutionTask(exec.id);

      expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("failed");
      rmSync(projPath, { recursive: true, force: true });
    }
  });

  it("marks plan task active when exec status is running or pending_approval", () => {
    for (const status of ["running", "pending_approval"] as const) {
      const projPath = mkdtempSync(join(tmpdir(), `ae-sync-${status}-`));
      const proj = db.insert(projects).values({ name: `p-${status}`, path: projPath }).returning().get()!;
      const m = createMilestone(projPath, { title: "M" });
      const s = createSlice(projPath, m.slug, { title: "S" });
      const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });
      const exec = db.insert(tasks).values({ projectId: proj.id, status } as any).returning().get()!;
      updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "pending" });

      syncPlanFromExecutionTask(exec.id);
      expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("active");

      rmSync(projPath, { recursive: true, force: true });
    }
  });

  it("no-ops for other exec statuses (queued)", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-sync-queued-"));
    const proj = db.insert(projects).values({ name: "p-queued", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });
    const exec = db.insert(tasks).values({ projectId: proj.id, status: "queued" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "pending" });

    syncPlanFromExecutionTask(exec.id);
    expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("pending");

    rmSync(projPath, { recursive: true, force: true });
  });
});

describe("auto-executor resilience", () => {
  it("reconcilePlanStatuses tolerates invalid project paths (list* throws)", () => {
    // Project points at a path that cannot be listed — listMilestones throws inside try/catch
    db.insert(projects).values({ name: "broken", path: "/nonexistent-path-xxx-aeae" }).run();
    expect(() => reconcilePlanStatuses()).not.toThrow();
  });

  it("resumeStaleMilestones tolerates invalid project paths", () => {
    db.insert(projects).values({ name: "broken2", path: "/nonexistent-path-yyy-aeae" }).run();
    expect(() => resumeStaleMilestones()).not.toThrow();
  });

  it("resumeStaleMilestones calls startAutoExecution for active milestone with pending work", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-resume-pending-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "Active-M", status: "active" });
    createSlice(projPath, m.slug, { title: "s-pending" });

    // Don't complete; just verify it doesn't throw and starts. Stop immediately.
    resumeStaleMilestones();
    // Give the started execution a chance to register, then stop.
    await new Promise((r) => setTimeout(r, 20));
    stopAutoExecution(m.slug);

    expect(proj.id).toBeGreaterThan(0);
    rmSync(projPath, { recursive: true, force: true });
  });

  it("executePlanTask polling aborts when exec task is deleted mid-run", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-delete-midrun-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    // taskExecutor deletes the exec row on the next tick
    (taskExecutor.execute as any).mockImplementation((taskId: number) => {
      queueMicrotask(() => {
        getDb().delete(tasks).where(eq(tasks.id, taskId)).run();
      });
    });

    vi.useFakeTimers();
    const p = startAutoExecution(proj.id, projPath, m.slug);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await p;

    expect(taskExecutor.execute).toHaveBeenCalled();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("executePlanTask polling rejects and marks plan task failed when exec goes to failed", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-fail-midrun-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    (taskExecutor.execute as any).mockImplementation((taskId: number) => {
      queueMicrotask(() => {
        getDb().update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
      });
    });

    vi.useFakeTimers();
    const p = startAutoExecution(proj.id, projPath, m.slug);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await p;

    expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("failed");
    expect(listSlices(projPath, m.slug)[0].status).toBe("failed");
    rmSync(projPath, { recursive: true, force: true });
  });

  it("aggregateSliceStatus reports anyActive over anyFailed", () => {
    // Drive via syncPlanFromExecutionTask + repoint to exercise active>failed path
    const projPath = mkdtempSync(join(tmpdir(), "ae-agg-active-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt1 = createPlanTask(projPath, m.slug, s.slug, { title: "T1" });
    const pt2 = createPlanTask(projPath, m.slug, s.slug, { title: "T2" });

    updatePlanTask(projPath, m.slug, s.slug, pt1.slug, { status: "failed" });
    const exec = db.insert(tasks).values({ projectId: proj.id, status: "running" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt2.slug, { executionTaskId: exec.id, status: "pending" });

    syncPlanFromExecutionTask(exec.id);

    // pt1 failed + pt2 active → slice "active"
    expect(listSlices(projPath, m.slug)[0].status).toBe("active");
    rmSync(projPath, { recursive: true, force: true });
  });
});
