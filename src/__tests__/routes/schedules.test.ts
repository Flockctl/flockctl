import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, createTestTemplate } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

// Mock the scheduler service so tests don't start real cron jobs.
vi.mock("../../services/scheduler", () => ({
  schedulerService: {
    schedule: vi.fn(),
    remove: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    triggerNow: vi.fn(),
    computeNextFireTime: vi.fn(() => null),
  },
  SchedulerService: class {},
}));

import { app } from "../../server.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let homeDir: string;
let origHome: string | undefined;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  origHome = process.env.FLOCKCTL_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-sched-"));
  process.env.FLOCKCTL_HOME = homeDir;
});

afterAll(() => {
  sqlite.close();
  if (origHome === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM schedules;`);
  rmSync(join(homeDir, "templates"), { recursive: true, force: true });
});

describe("Schedules routes", () => {
  it("GET /schedules returns empty list", async () => {
    const res = await app.request("/schedules");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("POST /schedules creates a cron schedule", async () => {
    createTestTemplate({ name: "cron-tmpl", prompt: "hi" });
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "cron-tmpl",
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
        timezone: "UTC",
      }),
    });
    expect(res.status).toBe(201);
    const sched = await res.json();
    expect(sched.scheduleType).toBe("cron");
    expect(sched.status).toBe("active");
    expect(sched.templateName).toBe("cron-tmpl");
    expect(sched.templateScope).toBe("global");
  });

  it("GET /schedules/:id returns schedule with embedded template", async () => {
    createTestTemplate({ name: "fetch-tmpl", prompt: "hi" });
    const create = await (await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "fetch-tmpl",
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
      }),
    })).json();

    const res = await app.request(`/schedules/${create.id}`);
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.cronExpression).toBe("0 */6 * * *");
    expect(sched.template).toBeTruthy();
    expect(sched.template.name).toBe("fetch-tmpl");
  });

  it("POST /schedules/:id/pause pauses an active schedule", async () => {
    createTestTemplate({ name: "pause-tmpl" });
    const create = await (await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "pause-tmpl",
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
      }),
    })).json();

    const res = await app.request(`/schedules/${create.id}/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.status).toBe("paused");
  });

  it("POST /schedules/:id/resume resumes a paused schedule", async () => {
    createTestTemplate({ name: "resume-tmpl" });
    const create = await (await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "resume-tmpl",
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
      }),
    })).json();

    await app.request(`/schedules/${create.id}/pause`, { method: "POST" });
    const res = await app.request(`/schedules/${create.id}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    const sched = await res.json();
    expect(sched.status).toBe("active");
  });

  it("DELETE /schedules/:id deletes a schedule", async () => {
    createTestTemplate({ name: "delete-tmpl" });
    const create = await (await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "delete-tmpl",
        scheduleType: "cron",
        cronExpression: "0 */6 * * *",
      }),
    })).json();

    const delRes = await app.request(`/schedules/${create.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`/schedules/${create.id}`);
    expect(getRes.status).toBe(404);
  });

  it("POST /schedules requires scheduleType", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
