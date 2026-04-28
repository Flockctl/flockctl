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
  listPlanTasks, updatePlanTask, getPlanDir,
} from "../../services/plan-store/index.js";
import { join as pjoin } from "path";

vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: { execute: vi.fn() },
}));

vi.mock("../../services/ws-manager", () => ({
  wsManager: { broadcastAll: vi.fn(), broadcastTaskStatus: vi.fn(), broadcastChatStatus: vi.fn() },
}));

import { taskExecutor } from "../../services/task-executor/index.js";
import { startAutoExecution, stopAutoExecution } from "../../services/auto-executor.js";

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
  sqlite.exec(`DELETE FROM tasks; DELETE FROM projects;`);
  (taskExecutor.execute as any).mockReset();
});

describe("auto-executor — dedupe branches for non-terminal exec statuses", () => {
  for (const status of ["running", "pending_approval", "waiting_for_input"] as const) {
    it(`reuses existing exec task when status is '${status}'`, async () => {
      const projPath = mkdtempSync(join(tmpdir(), `ae-reuse-${status}-`));
      const proj = db.insert(projects).values({ name: `p-${status}-${Date.now()}`, path: projPath }).returning().get()!;
      const m = createMilestone(projPath, { title: "M" });
      const s = createSlice(projPath, m.slug, { title: "S" });
      const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

      const promptFile = pjoin(getPlanDir(projPath), m.slug, s.slug, `${pt.slug}.md`);
      const existing = db.insert(tasks).values({
        projectId: proj.id,
        promptFile,
        status,
        label: `plan-task-${pt.slug}`,
      } as any).returning().get()!;
      updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: existing.id });

      const before = db.select().from(tasks).all().length;

      // Kick off auto-exec; we'll resolve the existing task in a tick.
      const p = startAutoExecution(proj.id, projPath, m.slug);
      // Mark existing as done so the polling loop in executePlanTask resolves.
      queueMicrotask(() => {
        getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, existing.id)).run();
      });
      // Use fake timers to advance the 1000ms poll interval
      vi.useFakeTimers();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      vi.useRealTimers();
      await p;

      const after = db.select().from(tasks).all().length;
      expect(after).toBe(before); // no new row created

      rmSync(projPath, { recursive: true, force: true });
    });
  }

  it("creates a new exec task when previous execTask points at terminal status", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-refresh-done-"));
    const proj = db.insert(projects).values({ name: `p-refresh-${Date.now()}`, path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    const s = createSlice(projPath, m.slug, { title: "S" });
    const pt = createPlanTask(projPath, m.slug, s.slug, { title: "T" });

    const oldExec = db.insert(tasks).values({ projectId: proj.id, status: "failed" } as any).returning().get()!;
    updatePlanTask(projPath, m.slug, s.slug, pt.slug, { executionTaskId: oldExec.id });

    (taskExecutor.execute as any).mockImplementation((taskId: number) => {
      queueMicrotask(() => {
        getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId)).run();
      });
    });

    vi.useFakeTimers();
    const p = startAutoExecution(proj.id, projPath, m.slug);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await p;

    const all = db.select().from(tasks).all();
    // Should contain the old failed exec + a new one
    expect(all.length).toBeGreaterThanOrEqual(2);

    rmSync(projPath, { recursive: true, force: true });
  });

  it("stop during wave breaks slice loop (running=false branch)", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "ae-stop-slicewave-"));
    const proj = db.insert(projects).values({ name: `p-stop-${Date.now()}`, path: projPath }).returning().get()!;
    const m = createMilestone(projPath, { title: "M" });
    createSlice(projPath, m.slug, { title: "S1" });
    createSlice(projPath, m.slug, { title: "S2" });

    (taskExecutor.execute as any).mockImplementation(() => {});

    vi.useFakeTimers();
    const p = startAutoExecution(proj.id, projPath, m.slug);
    await vi.advanceTimersByTimeAsync(100);
    stopAutoExecution(m.slug);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await p;

    rmSync(projPath, { recursive: true, force: true });
  });
});
