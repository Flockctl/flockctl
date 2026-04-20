import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { schedules, taskTemplates, projects, tasks } from "../../db/schema.js";
import Database from "better-sqlite3";

// Mock scheduler service so we don't start real cron jobs
vi.mock("../../services/scheduler", () => ({
  schedulerService: {
    schedule: vi.fn(),
    remove: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    triggerNow: vi.fn(),
    computeNextFireTime: vi.fn(() => "2030-01-01T00:00:00.000Z"),
  },
  SchedulerService: class {},
}));

import { app } from "../../server.js";
import { schedulerService } from "../../services/scheduler.js";

let db: FlockctlDb;
let sqlite: Database.Database;

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
  Object.values(schedulerService).forEach((fn: any) => {
    if (typeof fn?.mockClear === "function") fn.mockClear();
  });
});

describe("Schedules routes — extra paths", () => {
  function makeTemplate() {
    const proj = db.insert(projects).values({ name: "p" }).returning().get()!;
    const tmpl = db.insert(taskTemplates).values({
      projectId: proj.id,
      name: "tmpl",
      prompt: "do it",
    }).returning().get()!;
    return tmpl;
  }

  it("GET /schedules/:id embeds template when templateId set", async () => {
    const tmpl = makeTemplate();
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toBeTruthy();
    expect(body.template.name).toBe("tmpl");
  });

  it("POST /schedules requires cronExpression for cron type", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleType: "cron" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("cronExpression");
  });

  it("POST /schedules starts the cron job and sets nextFireTime", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleType: "cron",
        cronExpression: "*/5 * * * *",
        timezone: "UTC",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nextFireTime).toBe("2030-01-01T00:00:00.000Z");
    expect(schedulerService.schedule).toHaveBeenCalled();
  });

  it("PATCH /schedules/:id reschedules when cron expression changes", async () => {
    const sched = db.insert(schedules).values({
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: "*/10 * * * *" }),
    });
    expect(res.status).toBe(200);
    expect(schedulerService.remove).toHaveBeenCalledWith(sched.id);
    expect(schedulerService.schedule).toHaveBeenCalled();
  });

  it("PATCH /schedules/:id returns 404 for unknown id", async () => {
    const res = await app.request("/schedules/9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "UTC" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /schedules/:id/pause returns 422 when already paused", async () => {
    const sched = db.insert(schedules).values({
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "paused",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}/pause`, { method: "POST" });
    expect(res.status).toBe(422);
  });

  it("POST /schedules/:id/resume returns 422 when already active", async () => {
    const sched = db.insert(schedules).values({
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}/resume`, { method: "POST" });
    expect(res.status).toBe(422);
  });

  it("POST /schedules/:id/trigger triggers existing schedule", async () => {
    const sched = db.insert(schedules).values({
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}/trigger`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(schedulerService.triggerNow).toHaveBeenCalledWith(sched.id);
  });

  it("POST /schedules/:id/trigger returns 404 for unknown", async () => {
    const res = await app.request("/schedules/9999/trigger", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("GET /schedules/:id/tasks returns tasks created by this schedule's template", async () => {
    const tmpl = makeTemplate();
    const sched = db.insert(schedules).values({
      templateId: tmpl.id,
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    // Two matching tasks and one non-matching
    db.insert(tasks).values({
      projectId: tmpl.projectId,
      prompt: "a",
      label: `scheduled-${tmpl.name}-111`,
      taskType: "execution",
      status: "done",
    }).run();
    db.insert(tasks).values({
      projectId: tmpl.projectId,
      prompt: "b",
      label: `scheduled-${tmpl.name}-222`,
      taskType: "execution",
      status: "queued",
    }).run();
    db.insert(tasks).values({
      projectId: tmpl.projectId,
      prompt: "c",
      label: "manual",
      taskType: "execution",
      status: "done",
    }).run();

    const res = await app.request(`/schedules/${sched.id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(2);
    expect(body.items.every((t: any) => t.label.startsWith(`scheduled-${tmpl.name}-`))).toBe(true);
  });

  it("GET /schedules/:id/tasks returns 404 for unknown schedule", async () => {
    const res = await app.request("/schedules/9999/tasks");
    expect(res.status).toBe(404);
  });

  it("GET /schedules/:id/tasks returns empty when schedule has no template", async () => {
    const sched = db.insert(schedules).values({
      scheduleType: "cron",
      cronExpression: "0 * * * *",
      status: "active",
    }).returning().get()!;

    const res = await app.request(`/schedules/${sched.id}/tasks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.items.length).toBe(0);
  });

  it("GET /schedules filters by status and scheduleType", async () => {
    db.insert(schedules).values({
      scheduleType: "cron", cronExpression: "0 * * * *", status: "active",
    }).run();
    db.insert(schedules).values({
      scheduleType: "cron", cronExpression: "0 * * * *", status: "paused",
    }).run();
    db.insert(schedules).values({
      scheduleType: "once", runAt: "2030-01-01T00:00:00Z", status: "active",
    }).run();

    const res1 = await app.request("/schedules?status=active");
    const body1 = await res1.json();
    expect(body1.items.every((s: any) => s.status === "active")).toBe(true);
    expect(body1.items.length).toBe(2);

    const res2 = await app.request("/schedules?schedule_type=once");
    const body2 = await res2.json();
    expect(body2.items.every((s: any) => s.scheduleType === "once")).toBe(true);
    expect(body2.items.length).toBe(1);
  });
});
