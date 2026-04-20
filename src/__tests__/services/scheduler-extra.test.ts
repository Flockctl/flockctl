import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { schedules, taskTemplates, tasks, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

vi.mock("../../services/task-executor", () => ({
  taskExecutor: { execute: vi.fn() },
}));

import { SchedulerService } from "../../services/scheduler.js";
import { taskExecutor } from "../../services/task-executor.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let scheduler: SchedulerService;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => sqlite.close());

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM tasks;
    DELETE FROM schedules;
    DELETE FROM task_templates;
    DELETE FROM projects;
  `);
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
    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj.id,
      name: "t",
      prompt: "do it",
      model: "m",
    }).returning().get()!;
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
      scheduleType: "cron",
      cronExpression: "*/15 * * * *",
      status: "active",
    }).returning().get()!;
    return { proj, tmpl, sched };
  }

  it("creates a new task and calls taskExecutor.execute when active", () => {
    const { sched, tmpl } = setup();

    scheduler.triggerNow(sched.id);

    const createdTasks = db.select().from(tasks).all();
    expect(createdTasks.length).toBe(1);
    expect(createdTasks[0].prompt).toBe("do it");
    expect(createdTasks[0].label).toContain(`scheduled-${tmpl.name}`);
    expect(taskExecutor.execute).toHaveBeenCalledWith(createdTasks[0].id);

    const updated = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(updated.lastFireTime).not.toBeNull();
    expect(updated.nextFireTime).not.toBeNull();
  });

  it("no-ops when schedule does not exist", () => {
    scheduler.triggerNow(9999);
    expect(taskExecutor.execute).not.toHaveBeenCalled();
    expect(db.select().from(tasks).all().length).toBe(0);
  });

  it("no-ops when schedule is paused", () => {
    const { sched } = setup();
    db.update(schedules).set({ status: "paused" }).where(eq(schedules.id, sched.id)).run();

    scheduler.triggerNow(sched.id);
    expect(taskExecutor.execute).not.toHaveBeenCalled();
  });

  it("no-ops when template is missing", () => {
    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const sched = db.insert(schedules).values({
      templateId: null,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    } as any).returning().get()!;
    void proj;

    scheduler.triggerNow(sched.id);
    expect(taskExecutor.execute).not.toHaveBeenCalled();
  });

  it("catches task insert errors gracefully", () => {
    const proj = db.insert(projects).values({ name: "p-err" }).returning().get()!;
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj.id, name: "broken", prompt: "x",
    }).returning().get()!;
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    }).returning().get()!;

    // Bypass FK to orphan template to a non-existent project
    sqlite.exec(`PRAGMA foreign_keys = OFF;`);
    sqlite.exec(`UPDATE task_templates SET project_id = 999999 WHERE id = ${tmpl.id};`);
    sqlite.exec(`PRAGMA foreign_keys = ON;`);

    expect(() => scheduler.triggerNow(sched.id)).not.toThrow();
    expect(taskExecutor.execute).not.toHaveBeenCalled();
  });
});

describe("SchedulerService.resume() variants", () => {
  it("no-ops when schedule not found", () => {
    expect(() => scheduler.resume(9999)).not.toThrow();
  });

  it("no-ops when schedule has no cron expression", () => {
    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj.id, name: "t", prompt: "x",
    }).returning().get()!;
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
      scheduleType: "cron",
      cronExpression: null,
      status: "paused",
    } as any).returning().get()!;

    expect(() => scheduler.resume(sched.id)).not.toThrow();
    const reread = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(reread.status).toBe("paused");
  });

  it("restarts existing paused job with task.start()", () => {
    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj.id, name: "t", prompt: "x",
    }).returning().get()!;
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
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
