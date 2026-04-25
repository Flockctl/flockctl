import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import {
  createMilestone, createSlice, createPlanTask,
  getMilestone, listSlices, listPlanTasks, updatePlanTask,
} from "../../services/plan-store/index.js";

// Mock task-executor so auto-executor doesn't actually spawn external agents
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(() => Promise.resolve()),
  },
}));

import {
  startAutoExecution,
  stopAutoExecution,
  getAutoExecutionStatus,
  reconcilePlanStatuses,
  resumeStaleMilestones,
  cancelOrphanedExecutionTasks,
} from "../../services/auto-executor.js";
import { getPlanDir } from "../../services/plan-store/index.js";
import { join as pjoin } from "path";

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
  sqlite.exec(`
    DELETE FROM tasks;
    DELETE FROM projects;
  `);
});

describe("getAutoExecutionStatus / stopAutoExecution", () => {
  it("returns running=false when no execution active", () => {
    expect(getAutoExecutionStatus("nonexistent").running).toBe(false);
  });

  it("stopAutoExecution returns false when no active execution", () => {
    expect(stopAutoExecution("nope")).toBe(false);
  });
});

describe("startAutoExecution (no slices — finishes immediately)", () => {
  it("completes when milestone has no slices", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-empty-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "Empty" });

    await startAutoExecution(proj.id, projPath, m.slug);

    // Milestone is removed from active map
    expect(getAutoExecutionStatus(m.slug).running).toBe(false);
    rmSync(projPath, { recursive: true, force: true });
  });

  it("does not double-start the same milestone", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-dbl-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });

    // Start twice — second call should no-op
    const p1 = startAutoExecution(proj.id, projPath, m.slug);
    const p2 = startAutoExecution(proj.id, projPath, m.slug);
    await Promise.all([p1, p2]);
    expect(getAutoExecutionStatus(m.slug).running).toBe(false);
    rmSync(projPath, { recursive: true, force: true });
  });
});

describe("reconcilePlanStatuses", () => {
  it("returns 0 when no plan tasks need reconciling", () => {
    expect(reconcilePlanStatuses()).toBe(0);
  });

  it("marks plan task completed when linked execution task is done", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-recon-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "Recon" });
    const s = createSlice(projPath, m.slug, { title: "s1" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "t1" });

    // Create a done execution task and link it to the plan task
    const exec = db.insert(tasks).values({ projectId: proj.id, status: "done" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

    const count = reconcilePlanStatuses();
    expect(count).toBe(1);

    const tasksList = listPlanTasks(projPath, m.slug, s.slug);
    expect(tasksList[0].status).toBe("completed");
    // Slice should also be updated
    const slices = listSlices(projPath, m.slug);
    expect(slices[0].status).toBe("completed");
    // Milestone also
    expect(getMilestone(projPath, m.slug)!.status).toBe("completed");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("marks plan task failed when execution task failed/cancelled/timed_out", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-recon-fail-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "s" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "t" });

    const exec = db.insert(tasks).values({ projectId: proj.id, status: "failed" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "active" });

    expect(reconcilePlanStatuses()).toBe(1);
    expect(listPlanTasks(projPath, m.slug, s.slug)[0].status).toBe("failed");
    // Slice should be failed
    expect(listSlices(projPath, m.slug)[0].status).toBe("failed");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips plan tasks without executionTaskId", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-skip-"));
    db.insert(projects).values({ name: "p", path: projPath }).run();
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "s" });
    createPlanTask(projPath, m.slug, s.slug, { title: "t" });

    expect(reconcilePlanStatuses()).toBe(0);
    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips projects without a path", () => {
    db.insert(projects).values({ name: "no-path-proj" }).run();
    expect(reconcilePlanStatuses()).toBe(0);
  });
});

describe("resumeStaleMilestones", () => {
  it("no-ops with no projects", () => {
    expect(() => resumeStaleMilestones()).not.toThrow();
  });

  it("skips completed milestones", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-resume-"));
    db.insert(projects).values({ name: "p", path: projPath }).run();
    const m = createMilestone(projPath, { title: "M", status: "completed" });
    // Add a completed slice so it would not re-start even if status changed
    createSlice(projPath, m.slug, { title: "s", status: "completed" });

    expect(() => resumeStaleMilestones()).not.toThrow();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips milestones with all slices completed/failed", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-resume-done-"));
    db.insert(projects).values({ name: "p", path: projPath }).run();
    const m = createMilestone(projPath, { title: "M", status: "active" });
    createSlice(projPath, m.slug, { title: "s1", status: "completed" });
    createSlice(projPath, m.slug, { title: "s2", status: "failed" });

    expect(() => resumeStaleMilestones()).not.toThrow();
    rmSync(projPath, { recursive: true, force: true });
  });

  it("skips projects without a path", () => {
    db.insert(projects).values({ name: "no-path" }).run();
    expect(() => resumeStaleMilestones()).not.toThrow();
  });
});

describe("cancelOrphanedExecutionTasks", () => {
  it("cancels non-terminal exec tasks whose plan file points elsewhere", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-orphan-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "s" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "t" });
    const promptFile = pjoin(getPlanDir(projPath), m.slug, s.slug, `${pt.slug}.md`);

    const orphan = db.insert(tasks).values({
      projectId: proj.id, promptFile, status: "queued",
    } as any).returning().get()!;
    const live = db.insert(tasks).values({
      projectId: proj.id, promptFile, status: "queued",
    } as any).returning().get()!;

    // Plan file points to the newer exec task → the older one is orphaned
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: live.id });

    const cancelled = cancelOrphanedExecutionTasks();
    expect(cancelled).toBe(1);

    const orphanRow = db.select().from(tasks).where(eq(tasks.id, orphan.id)).get()!;
    expect(orphanRow.status).toBe("cancelled");
    expect(orphanRow.errorMessage).toMatch(/orphan/i);

    const liveRow = db.select().from(tasks).where(eq(tasks.id, live.id)).get()!;
    expect(liveRow.status).toBe("queued");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("leaves tasks whose promptFile is outside any plan dir alone", () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-orphan-outside-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    createMilestone(projPath, { title: "M" });

    // promptFile points outside the plan dir — must be ignored by the sweep
    const t = db.insert(tasks).values({
      projectId: proj.id,
      promptFile: "/tmp/not-in-plan.md",
      status: "queued",
    } as any).returning().get()!;

    expect(cancelOrphanedExecutionTasks()).toBe(0);
    expect(db.select().from(tasks).where(eq(tasks.id, t.id)).get()!.status).toBe("queued");

    rmSync(projPath, { recursive: true, force: true });
  });

  it("no-ops when there are no projects", () => {
    expect(cancelOrphanedExecutionTasks()).toBe(0);
  });
});

describe("executePlanTask — dedupe", () => {
  it("reuses the existing non-terminal exec task instead of spawning a duplicate", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-dedupe-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M", status: "active" });
    const s = createSlice(projPath, m.slug, { title: "s" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "t" });

    // Pre-existing queued exec task from a previous auto-exec run
    const promptFile = pjoin(getPlanDir(projPath), m.slug, s.slug, `${pt.slug}.md`);
    const existing = db.insert(tasks).values({
      projectId: proj.id, promptFile, status: "queued", label: `plan-task-${pt.slug}`,
    } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: existing.id });

    const before = db.select().from(tasks).all().length;

    // Simulate a re-trigger: auto-exec walks waves and hits this plan task.
    // Since the mocked taskExecutor resolves immediately, startAutoExecution
    // will finish without actually dispatching. Before fix: would insert a
    // duplicate task. After fix: must reuse `existing`.
    const p = startAutoExecution(proj.id, projPath, m.slug);
    // Mark existing as done so the internal polling loop resolves.
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, existing.id)).run();
    await p;

    const after = db.select().from(tasks).all().length;
    expect(after).toBe(before);

    rmSync(projPath, { recursive: true, force: true });
  });
});
