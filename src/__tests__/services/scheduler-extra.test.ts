import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, createTestTemplate } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { schedules, tasks, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: { execute: vi.fn() },
}));

import { SchedulerService } from "../../services/scheduler.js";
import { taskExecutor } from "../../services/task-executor/index.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let scheduler: SchedulerService;
let homeDir: string;
let origHome: string | undefined;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  origHome = process.env.FLOCKCTL_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-scheduler-extra-"));
  process.env.FLOCKCTL_HOME = homeDir;
});

afterAll(() => {
  sqlite.close();
  if (origHome === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM tasks;
    DELETE FROM schedules;
    DELETE FROM projects;
  `);
  rmSync(join(homeDir, "templates"), { recursive: true, force: true });
  (taskExecutor.execute as any).mockReset();
  scheduler = new SchedulerService();
});

afterEach(() => scheduler.stopAll());

describe("SchedulerService — computeNextFireTime", () => {
  it("returns ISO timestamp for a valid cron", () => {
    const next = scheduler.computeNextFireTime("0 * * * *");
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns null for invalid cron", () => {
    expect(scheduler.computeNextFireTime("not-a-cron")).toBeNull();
  });
});

describe("SchedulerService.triggerNow / executeSchedule", () => {
  function setup() {
    // Project-scoped template so the created task carries projectId.
    const projPath = mkdtempSync(join(tmpdir(), "flockctl-sched-extra-proj-"));
    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    const ref = createTestTemplate({
      name: "t",
      scope: "project",
      projectId: proj.id,
      prompt: "do it",
      model: "m",
    });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      templateProjectId: proj.id,
      scheduleType: "cron",
      cronExpression: "*/15 * * * *",
      status: "active",
    }).returning().get()!;
    return { proj, ref, sched, projPath };
  }

  it("creates a new task and calls taskExecutor.execute when active", () => {
    const { sched, ref, projPath } = setup();
    try {
      scheduler.triggerNow(sched.id);

      const createdTasks = db.select().from(tasks).all();
      expect(createdTasks.length).toBe(1);
      expect(createdTasks[0].prompt).toBe("do it");
      expect(createdTasks[0].label).toContain(`scheduled-${ref.templateName}`);
      expect(taskExecutor.execute).toHaveBeenCalledWith(createdTasks[0].id);

      const updated = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
      expect(updated.lastFireTime).not.toBeNull();
      expect(updated.nextFireTime).not.toBeNull();
    } finally {
      rmSync(projPath, { recursive: true, force: true });
    }
  });

  it("no-ops when schedule does not exist", () => {
    scheduler.triggerNow(9999);
    expect(taskExecutor.execute).not.toHaveBeenCalled();
    expect(db.select().from(tasks).all().length).toBe(0);
  });

  it("no-ops when schedule is paused", () => {
    const { sched, projPath } = setup();
    try {
      db.update(schedules).set({ status: "paused" }).where(eq(schedules.id, sched.id)).run();

      scheduler.triggerNow(sched.id);
      expect(taskExecutor.execute).not.toHaveBeenCalled();
    } finally {
      rmSync(projPath, { recursive: true, force: true });
    }
  });

  it("no-ops (skips this fire) when referenced template file is missing", () => {
    // Seed a schedule that points at a template name that was never written
    // to disk. The scheduler should log and skip rather than throw.
    const sched = db.insert(schedules).values({
      templateScope: "global",
      templateName: "missing-template",
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    }).returning().get()!;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      scheduler.triggerNow(sched.id);
      expect(taskExecutor.execute).not.toHaveBeenCalled();
      expect(db.select().from(tasks).all().length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("catches task insert errors gracefully", () => {
    // Orphan the schedule's project id to trigger a FK failure on task insert.
    const projPath = mkdtempSync(join(tmpdir(), "flockctl-sched-err-"));
    const proj = db.insert(projects).values({ name: "p-err", path: projPath }).returning().get()!;
    const ref = createTestTemplate({
      name: "broken",
      scope: "project",
      projectId: proj.id,
      prompt: "x",
    });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      templateProjectId: proj.id,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    }).returning().get()!;

    // Point the schedule at a non-existent project id so task insert fails FK.
    sqlite.exec(`PRAGMA foreign_keys = OFF;`);
    sqlite.exec(`UPDATE schedules SET template_project_id = 999999 WHERE id = ${sched.id};`);
    sqlite.exec(`PRAGMA foreign_keys = ON;`);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => scheduler.triggerNow(sched.id)).not.toThrow();
      // Template file still exists under the real project path, so getTemplate
      // will fail (project 999999 has no row). The scheduler logs and skips.
      expect(taskExecutor.execute).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      rmSync(projPath, { recursive: true, force: true });
    }
  });
});

describe("SchedulerService.resume() variants", () => {
  it("no-ops when schedule not found", () => {
    expect(() => scheduler.resume(9999)).not.toThrow();
  });

  it("no-ops when schedule has no cron expression", () => {
    const ref = createTestTemplate({ name: "t", prompt: "x" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: null,
      status: "paused",
    } as any).returning().get()!;

    expect(() => scheduler.resume(sched.id)).not.toThrow();
    const reread = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(reread.status).toBe("paused");
  });

  it("restarts existing paused job with task.start()", () => {
    const ref = createTestTemplate({ name: "resume-t", prompt: "x" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "paused",
    }).returning().get()!;

    // First schedule → create the job, then pause
    scheduler.schedule(sched.id, "0 * * * *");
    scheduler.pause(sched.id);
    // Now resume — should hit the existing-job branch
    expect(() => scheduler.resume(sched.id)).not.toThrow();

    const reread = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(reread.status).toBe("active");
  });
});
