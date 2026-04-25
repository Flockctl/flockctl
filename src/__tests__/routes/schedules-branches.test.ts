/**
 * Branch-coverage top-up for src/routes/schedules.ts.
 *
 * Targets the uncovered branches of `parseTemplateRef` (workspace /
 * project scope, cross-field validation) and the PATCH handler's
 * partial-field spreads (assignedKeyId / runAt / timezone /
 * misfireGraceSeconds). Extends — not overlaps — the scenarios in
 * `schedules.test.ts` and `schedules-extra.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, createTestTemplate } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, schedules } from "../../db/schema.js";
import Database from "better-sqlite3";

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
import { schedulerService } from "../../services/scheduler.js";

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
  homeDir = mkdtempSync(join(tmpdir(), "flockctl-sched-branches-"));
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
    DELETE FROM schedules;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
  rmSync(join(homeDir, "templates"), { recursive: true, force: true });
  Object.values(schedulerService).forEach((fn: any) => {
    if (typeof fn?.mockClear === "function") fn.mockClear();
  });
});

describe("parseTemplateRef — scope validation branches", () => {
  it("rejects scope=global when templateWorkspaceId is also passed", async () => {
    createTestTemplate({ name: "g-tmpl", prompt: "hi" });
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "g-tmpl",
        templateWorkspaceId: 42,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/null for scope=global/);
  });

  it("rejects scope=global when templateProjectId is also passed", async () => {
    createTestTemplate({ name: "g2-tmpl" });
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "g2-tmpl",
        templateProjectId: 7,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects scope=workspace when templateWorkspaceId is missing", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "workspace",
        templateName: "ws-tmpl",
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/templateWorkspaceId is required/);
  });

  it("rejects scope=workspace when templateProjectId is also passed", async () => {
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-mixed", path: mkdtempSync(join(tmpdir(), "ws-")) })
      .returning()
      .get()!;
    createTestTemplate({ name: "ws-tmpl", scope: "workspace", workspaceId: ws.id });
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "workspace",
        templateName: "ws-tmpl",
        templateWorkspaceId: ws.id,
        templateProjectId: 5,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects scope=project when templateProjectId is missing", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "project",
        templateName: "p-tmpl",
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/templateProjectId is required/);
  });

  it("rejects empty templateName string", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "global",
        templateName: "",
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects unknown templateScope", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "user",
        templateName: "x",
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects non-string templateScope", async () => {
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: 1,
        templateName: "x",
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("creates a workspace-scoped schedule and echoes workspaceId", async () => {
    const wsPath = mkdtempSync(join(tmpdir(), "ws-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-ok", path: wsPath })
      .returning()
      .get()!;
    createTestTemplate({ name: "ws-tmpl", scope: "workspace", workspaceId: ws.id });

    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "workspace",
        templateName: "ws-tmpl",
        templateWorkspaceId: ws.id,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.templateScope).toBe("workspace");
    expect(body.templateWorkspaceId).toBe(ws.id);
    expect(body.templateProjectId).toBeNull();
  });

  it("creates a project-scoped schedule and echoes projectId", async () => {
    const pPath = mkdtempSync(join(tmpdir(), "proj-"));
    const proj = db
      .insert(projects)
      .values({ name: "p-ok", path: pPath })
      .returning()
      .get()!;
    createTestTemplate({ name: "proj-tmpl", scope: "project", projectId: proj.id });

    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: "project",
        templateName: "proj-tmpl",
        templateProjectId: proj.id,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.templateScope).toBe("project");
    expect(body.templateProjectId).toBe(proj.id);
    expect(body.templateWorkspaceId).toBeNull();
  });
});

describe("GET /schedules/:id — template resolution edge cases", () => {
  it("returns schedule with template=null when the on-disk template is gone", async () => {
    const ref = createTestTemplate({ name: "will-delete", prompt: "hi" });
    const sched = db
      .insert(schedules)
      .values({
        templateScope: ref.templateScope,
        templateName: ref.templateName,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
        status: "active",
      })
      .returning()
      .get()!;

    // Simulate the template file being deleted out-of-band between the
    // schedule-insert and the GET.
    rmSync(join(homeDir, "templates"), { recursive: true, force: true });

    const res = await app.request(`/schedules/${sched.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toBeNull();
  });

  it("returns 404 for an unknown schedule id", async () => {
    const res = await app.request("/schedules/99999");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /schedules/:id — partial field branches", () => {
  function seedSchedule(name: string) {
    const ref = createTestTemplate({ name });
    return db
      .insert(schedules)
      .values({
        templateScope: ref.templateScope,
        templateName: ref.templateName,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        status: "active",
      })
      .returning()
      .get()!;
  }

  it("updates assignedKeyId only, no reschedule", async () => {
    const sched = seedSchedule("patch-keyid");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedKeyId: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignedKeyId).toBeNull();
    expect(schedulerService.remove).not.toHaveBeenCalled();
    expect(schedulerService.schedule).not.toHaveBeenCalled();
  });

  it("updates runAt only", async () => {
    const sched = seedSchedule("patch-runat");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runAt: "2035-06-01T12:00:00Z" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runAt).toBe("2035-06-01T12:00:00Z");
  });

  it("updates timezone only", async () => {
    const sched = seedSchedule("patch-tz");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timezone).toBe("America/New_York");
  });

  it("updates misfireGraceSeconds only", async () => {
    const sched = seedSchedule("patch-misfire");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ misfireGraceSeconds: 120 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.misfireGraceSeconds).toBe(120);
  });

  it("clearing cronExpression removes the cron job without rescheduling", async () => {
    const sched = seedSchedule("patch-clear");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: null }),
    });
    expect(res.status).toBe(200);
    expect(schedulerService.remove).toHaveBeenCalledWith(sched.id);
    // Falsy (null) cronExpression → no re-schedule call.
    expect(schedulerService.schedule).not.toHaveBeenCalled();
  });

  it("patching cronExpression does NOT reschedule when the schedule is paused", async () => {
    const ref = createTestTemplate({ name: "patch-paused" });
    const sched = db
      .insert(schedules)
      .values({
        templateScope: ref.templateScope,
        templateName: ref.templateName,
        scheduleType: "cron",
        cronExpression: "0 * * * *",
        status: "paused",
      })
      .returning()
      .get()!;

    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: "*/15 * * * *" }),
    });
    expect(res.status).toBe(200);
    expect(schedulerService.remove).not.toHaveBeenCalled();
    expect(schedulerService.schedule).not.toHaveBeenCalled();
  });

  it("patching templateName through parseTemplateRef fails when new template missing", async () => {
    const sched = seedSchedule("patch-tmpl");
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateName: "no-such-tmpl" }),
    });
    expect(res.status).toBe(422);
  });

  it("patching templateName to another existing template succeeds", async () => {
    const sched = seedSchedule("patch-tmpl-ok");
    createTestTemplate({ name: "new-tmpl", prompt: "new" });
    const res = await app.request(`/schedules/${sched.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateName: "new-tmpl" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templateName).toBe("new-tmpl");
  });
});

describe("DELETE /schedules/:id — not-found", () => {
  it("returns 404 for unknown id", async () => {
    const res = await app.request("/schedules/987654", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /schedules/:id/pause and /resume — not-found branches", () => {
  it("pause returns 404 for unknown id", async () => {
    const res = await app.request("/schedules/987654/pause", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("resume returns 404 for unknown id", async () => {
    const res = await app.request("/schedules/987654/resume", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ─── POST nullish fallbacks: cronExpression / runAt / timezone / misfireGrace ───
describe("POST /schedules — body nullish fallbacks", () => {
  it("accepts one-shot schedule with no cronExpression and defaults timezone to UTC", async () => {
    const tpl = createTestTemplate({ name: "oneshot-null-fallbacks", scope: "global" });
    const res = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateScope: tpl.templateScope,
        templateName: tpl.templateName,
        scheduleType: "one_shot",
        runAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.cronExpression).toBeNull();
    expect(body.timezone).toBe("UTC");
    expect(body.misfireGraceSeconds).toBeNull();
  });
});

// ─── PATCH fallbacks: templateName / timezone pick existing when body omits them ───
describe("PATCH /schedules/:id — partial template-ref fallbacks", () => {
  it("changing only templateScope reuses existing templateName/workspace/project", async () => {
    // Seed a workspace-scoped template and a schedule pointing at it.
    const wsPath = mkdtempSync(join(tmpdir(), "sch-patch-scope-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-patch-scope", path: wsPath })
      .returning()
      .get()!;
    const tpl = createTestTemplate({
      name: "scope-reuse",
      scope: "workspace",
      workspaceId: ws.id,
    });
    const row = db
      .insert(schedules)
      .values({
        templateScope: tpl.templateScope,
        templateName: tpl.templateName,
        templateWorkspaceId: tpl.templateWorkspaceId,
        templateProjectId: tpl.templateProjectId,
        scheduleType: "one_shot",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        status: "active",
      })
      .returning()
      .get()!;
    // PATCH only templateWorkspaceId to keep it workspace-scope but force the
    // `body.templateName ?? existing.templateName` fallback to fire (the body
    // omits templateName). Send the same workspace id so the ref re-parses
    // cleanly.
    const res = await app.request(`/schedules/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateWorkspaceId: ws.id }),
    });
    expect(res.status).toBe(200);
  });

  it("reschedules via existing.timezone when body omits timezone", async () => {
    const tpl = createTestTemplate({ name: "tz-fallback", scope: "global" });
    const row = db
      .insert(schedules)
      .values({
        templateScope: tpl.templateScope,
        templateName: tpl.templateName,
        templateWorkspaceId: null,
        templateProjectId: null,
        scheduleType: "cron",
        cronExpression: "0 0 * * *",
        timezone: "Europe/Berlin",
        status: "active",
      })
      .returning()
      .get()!;
    const res = await app.request(`/schedules/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: "0 1 * * *" }),
    });
    expect(res.status).toBe(200);
    // schedulerService.schedule should have been called with Europe/Berlin
    // (existing.timezone), not undefined.
    const calls = (schedulerService.schedule as any).mock.calls.map((c: any[]) => c[2]);
    expect(calls).toContain("Europe/Berlin");
  });
});

// Silence the unused workspaces / projects imports at top (used above).
void projects;
