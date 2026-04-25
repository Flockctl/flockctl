/**
 * Branch-coverage tests for `src/services/scheduler.ts`.
 *
 * Targets remaining uncovered branches not hit by scheduler.test.ts or
 * scheduler-extra.test.ts:
 *   - loadExistingSchedules: row with null cronExpression is skipped;
 *     row with null timezone forwards `undefined` into schedule().
 *   - pause: no-op when schedule id isn't tracked (jobs map has no entry).
 *   - executeSchedule:
 *       • global/workspace template with null templateProjectId →
 *         `schedule.templateProjectId ?? null` picks the right-hand side
 *       • template without envVars → `envVars ? JSON.stringify : null` false
 *       • schedule with null cronExpression at fire time → `nextFire` is null
 *         (reached via the triggerNow path on a non-cron-schedule row).
 */
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
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-scheduler-br-"));
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

describe("loadExistingSchedules — per-row branches", () => {
  it("skips rows with null cronExpression and handles null timezone", () => {
    const ref = createTestTemplate({ name: "tz-null", prompt: "x" });
    // Active with null cronExpression → skip branch (line 32 false)
    sqlite.prepare(
      `INSERT INTO schedules (template_scope, template_name, schedule_type, cron_expression, timezone, status)
       VALUES (?, ?, 'one-off', NULL, NULL, 'active')`,
    ).run(ref.templateScope, ref.templateName);
    // Active with cron + null timezone → goes through schedule() with tz=undefined
    sqlite.prepare(
      `INSERT INTO schedules (template_scope, template_name, schedule_type, cron_expression, timezone, status)
       VALUES (?, ?, 'cron', '*/30 * * * *', NULL, 'active')`,
    ).run(ref.templateScope, ref.templateName);

    expect(() => scheduler.loadExistingSchedules()).not.toThrow();
  });
});

describe("pause() — untracked schedule id", () => {
  it("no-ops when the schedule id has no in-memory job (if(job) false branch)", () => {
    const ref = createTestTemplate({ name: "pause-untracked", prompt: "x" });
    const row = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    // Never called .schedule() for this id → jobs map has no entry.
    expect(() => scheduler.pause(row.id)).not.toThrow();

    const after = db.select().from(schedules).where(eq(schedules.id, row.id)).get()!;
    expect(after.status).toBe("paused");
  });
});

describe("executeSchedule — non-project template branches", () => {
  it("global template fires with templateProjectId null (nullish branch)", () => {
    // Global-scope template: templateProjectId stays null on the schedule
    // and on the resulting task — exercises `templateProjectId ?? null` RHS.
    const ref = createTestTemplate({ name: "g-t", prompt: "global run" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    }).returning().get()!;

    scheduler.triggerNow(sched.id);
    const createdTasks = db.select().from(tasks).all();
    expect(createdTasks.length).toBe(1);
    expect(createdTasks[0]!.projectId).toBeNull();
    // template without envVars → tasks.envVars is null (RHS of ternary)
    expect(createdTasks[0]!.envVars).toBeNull();
    expect(taskExecutor.execute).toHaveBeenCalledWith(createdTasks[0]!.id);
  });

  it("template with envVars serializes to JSON string (LHS of envVars ternary)", () => {
    const ref = createTestTemplate({
      name: "env-template",
      prompt: "run",
      envVars: { FOO: "bar" },
    });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
    }).returning().get()!;

    scheduler.triggerNow(sched.id);
    const row = db.select().from(tasks).all()[0]!;
    expect(row.envVars).toBe(JSON.stringify({ FOO: "bar" }));
  });

  it("fires a non-cron (one-off) schedule → nextFire branch is null", () => {
    // cronExpression IS set in DB so getTemplate passes, but we update it to
    // null after seeding so the final update's `cronExpression ?`-branch
    // takes the null RHS. We keep status=active so the early-return passes.
    const ref = createTestTemplate({ name: "once-t", prompt: "x" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "one-off",
      cronExpression: null,
      status: "active",
    } as any).returning().get()!;

    expect(() => scheduler.triggerNow(sched.id)).not.toThrow();
    const after = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(after.nextFireTime).toBeNull();
    expect(after.lastFireTime).not.toBeNull();
  });

  it("resume() on a new scheduler re-schedules with null timezone → undefined (line 87 RHS)", () => {
    const ref = createTestTemplate({ name: "resume-null-tz", prompt: "x" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "*/10 * * * *",
      timezone: null,
      status: "paused",
    } as any).returning().get()!;

    // Fresh scheduler: no in-memory job → else-branch of `if (job)` fires,
    // forwarding `schedule.timezone ?? undefined` through to schedule().
    expect(() => scheduler.resume(sched.id)).not.toThrow();
    const reread = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
    expect(reread.status).toBe("active");
  });

  it("project-scoped template with null timezone uses undefined for tz (nullish branch)", () => {
    // Exercises `schedule.timezone ?? undefined` on line 174 when timezone is null.
    const projPath = mkdtempSync(join(tmpdir(), "flockctl-sched-br-proj-"));
    try {
      const proj = db.insert(projects).values({ name: "p-br", path: projPath }).returning().get()!;
      const ref = createTestTemplate({
        name: "pb",
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
        timezone: null,
        status: "active",
      } as any).returning().get()!;

      scheduler.triggerNow(sched.id);
      const after = db.select().from(schedules).where(eq(schedules.id, sched.id)).get()!;
      expect(after.nextFireTime).not.toBeNull();
    } finally {
      rmSync(projPath, { recursive: true, force: true });
    }
  });
});
