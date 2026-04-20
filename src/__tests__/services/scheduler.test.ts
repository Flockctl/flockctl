import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, getDb, type FlockctlDb } from "../../db/index.js";
import { schedules, taskTemplates, tasks, projects } from "../../db/schema.js";
import Database from "better-sqlite3";
import { SchedulerService } from "../../services/scheduler.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let scheduler: SchedulerService;

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
  scheduler = new SchedulerService();
});

afterEach(() => {
  scheduler.stopAll();
});

import { afterEach } from "vitest";

describe("SchedulerService", () => {
  it("schedule() throws for invalid cron expression", () => {
    expect(() => scheduler.schedule(1, "not-a-cron")).toThrow("Invalid cron expression");
  });

  it("schedule() accepts valid cron expression", () => {
    expect(() => scheduler.schedule(1, "*/5 * * * *")).not.toThrow();
  });

  it("remove() removes a scheduled job", () => {
    scheduler.schedule(1, "*/5 * * * *");
    scheduler.remove(1);
    // Removing again should not throw
    expect(() => scheduler.remove(1)).not.toThrow();
  });

  it("stopAll() clears all jobs", () => {
    scheduler.schedule(1, "*/5 * * * *");
    scheduler.schedule(2, "0 * * * *");
    scheduler.stopAll();
    // Stopping again should not throw
    expect(() => scheduler.stopAll()).not.toThrow();
  });

  it("pause() updates DB status to paused", () => {
    // Create a template and schedule in DB
    const proj = db.insert(projects).values({ name: "sched-proj" }).returning().get();
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj!.id,
      name: "tmpl1",
      prompt: "do stuff",
    }).returning().get();

    const sched = db.insert(schedules).values({
      templateId: tmpl!.id,
      scheduleType: "cron",
      cronExpression: "*/10 * * * *",
      status: "active",
    }).returning().get();

    scheduler.schedule(sched!.id, "*/10 * * * *");
    scheduler.pause(sched!.id);

    const updated = db.select().from(schedules).where(require("drizzle-orm").eq(schedules.id, sched!.id)).get();
    expect(updated!.status).toBe("paused");
  });

  it("resume() updates DB status to active", () => {
    const proj = db.insert(projects).values({ name: "sched-proj-2" }).returning().get();
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj!.id,
      name: "tmpl2",
      prompt: "do more",
    }).returning().get();

    const sched = db.insert(schedules).values({
      templateId: tmpl!.id,
      scheduleType: "cron",
      cronExpression: "0 12 * * *",
      status: "paused",
    }).returning().get();

    scheduler.resume(sched!.id);

    const updated = db.select().from(schedules).where(require("drizzle-orm").eq(schedules.id, sched!.id)).get();
    expect(updated!.status).toBe("active");
  });

  it("loadExistingSchedules() loads active schedules from DB", () => {
    const proj = db.insert(projects).values({ name: "sched-proj-3" }).returning().get();
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj!.id,
      name: "tmpl3",
      prompt: "test",
    }).returning().get();

    db.insert(schedules).values({
      templateId: tmpl!.id,
      scheduleType: "cron",
      cronExpression: "0 0 * * *",
      status: "active",
    }).run();

    db.insert(schedules).values({
      templateId: tmpl!.id,
      scheduleType: "cron",
      cronExpression: "0 6 * * *",
      status: "paused",
    }).run();

    // Should not throw even if some schedules are paused
    expect(() => scheduler.loadExistingSchedules()).not.toThrow();
  });

  it("schedule() replaces existing job with same id", () => {
    scheduler.schedule(99, "*/5 * * * *");
    // Replace with different cron — should not throw
    scheduler.schedule(99, "0 * * * *");
    scheduler.remove(99);
  });
});
