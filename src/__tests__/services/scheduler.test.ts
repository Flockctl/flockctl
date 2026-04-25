import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, createTestTemplate } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { schedules } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { SchedulerService } from "../../services/scheduler.js";

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
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-scheduler-"));
  process.env.FLOCKCTL_HOME = homeDir;
});

afterAll(() => {
  sqlite.close();
  if (origHome === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  scheduler = new SchedulerService();
});

afterEach(() => {
  scheduler.stopAll();
});

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
    const ref = createTestTemplate({ name: "tmpl1", prompt: "do stuff" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "*/10 * * * *",
      status: "active",
    }).returning().get();

    scheduler.schedule(sched!.id, "*/10 * * * *");
    scheduler.pause(sched!.id);

    const updated = db.select().from(schedules).where(eq(schedules.id, sched!.id)).get();
    expect(updated!.status).toBe("paused");
  });

  it("resume() updates DB status to active", () => {
    const ref = createTestTemplate({ name: "tmpl2", prompt: "do more" });
    const sched = db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "0 12 * * *",
      status: "paused",
    }).returning().get();

    scheduler.resume(sched!.id);

    const updated = db.select().from(schedules).where(eq(schedules.id, sched!.id)).get();
    expect(updated!.status).toBe("active");
  });

  it("loadExistingSchedules() loads active schedules from DB", () => {
    const ref = createTestTemplate({ name: "tmpl3", prompt: "test" });

    db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
      scheduleType: "cron",
      cronExpression: "0 0 * * *",
      status: "active",
    }).run();

    db.insert(schedules).values({
      templateScope: ref.templateScope,
      templateName: ref.templateName,
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
