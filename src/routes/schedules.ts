import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { schedules, tasks } from "../db/schema.js";
import { eq, and, sql, desc, like } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam } from "../lib/route-params.js";
import { schedulerService } from "../services/scheduler.js";
import { getTemplate, type TemplateScope } from "../services/templates.js";

export const scheduleRoutes = new Hono();

const VALID_SCOPES: ReadonlySet<TemplateScope> = new Set<TemplateScope>(["global", "workspace", "project"]);

interface TemplateRefInput {
  templateScope?: unknown;
  templateName?: unknown;
  templateWorkspaceId?: unknown;
  templateProjectId?: unknown;
}

interface TemplateRef {
  templateScope: TemplateScope;
  templateName: string;
  templateWorkspaceId: number | null;
  templateProjectId: number | null;
}

/**
 * Validate an incoming template reference. Enforces the same invariant as the
 * DB CHECK constraint so we return a clean 422 instead of a SQL error.
 */
function parseTemplateRef(body: TemplateRefInput): TemplateRef {
  if (typeof body.templateScope !== "string" || !VALID_SCOPES.has(body.templateScope as TemplateScope)) {
    throw new ValidationError("templateScope must be one of 'global' | 'workspace' | 'project'");
  }
  if (typeof body.templateName !== "string" || body.templateName.length === 0) {
    throw new ValidationError("templateName is required");
  }
  const scope = body.templateScope as TemplateScope;
  const wsId = body.templateWorkspaceId == null ? null : Number(body.templateWorkspaceId);
  const projId = body.templateProjectId == null ? null : Number(body.templateProjectId);

  if (scope === "global" && (wsId !== null || projId !== null)) {
    throw new ValidationError("templateWorkspaceId/templateProjectId must be null for scope=global");
  }
  if (scope === "workspace" && (wsId === null || projId !== null)) {
    throw new ValidationError("templateWorkspaceId is required (and templateProjectId must be null) for scope=workspace");
  }
  if (scope === "project" && projId === null) {
    throw new ValidationError("templateProjectId is required for scope=project");
  }

  // Verify the template file actually exists so the user gets a 422 at create
  // time rather than a silent skip at the next cron fire.
  const template = getTemplate(scope, body.templateName, {
    workspaceId: wsId ?? undefined,
    projectId: projId ?? undefined,
  });
  if (!template) {
    throw new ValidationError(`Template "${body.templateName}" not found in scope=${scope}`);
  }

  return {
    templateScope: scope,
    templateName: body.templateName,
    templateWorkspaceId: scope === "workspace" ? wsId : null,
    templateProjectId: scope === "project" ? projId : null,
  };
}

// GET /schedules
scheduleRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const conditions: any[] = [];
  const status = c.req.query("status");
  const scheduleType = c.req.query("schedule_type");

  if (status) conditions.push(eq(schedules.status, status));
  if (scheduleType) conditions.push(eq(schedules.scheduleType, scheduleType));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = db.select().from(schedules).where(where).orderBy(desc(schedules.createdAt)).limit(perPage).offset(offset).all();
  /* v8 ignore next — SQL count(*) aggregate always returns one row */
  const total = db.select({ count: sql<number>`count(*)` }).from(schedules).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /schedules/:id
scheduleRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const schedule = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!schedule) throw new NotFoundError("Schedule");

  // Resolve the referenced template from disk (may be null if the file has
  // been deleted out-of-band).
  let template = null;
  try {
    template = getTemplate(
      schedule.templateScope as TemplateScope,
      schedule.templateName,
      {
        workspaceId: schedule.templateWorkspaceId ?? undefined,
        projectId: schedule.templateProjectId ?? undefined,
      },
    );
  } catch {
    template = null;
  }

  return c.json({ ...schedule, template });
});

// POST /schedules
scheduleRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.scheduleType) throw new ValidationError("scheduleType is required");
  if (body.scheduleType === "cron" && !body.cronExpression) {
    throw new ValidationError("cronExpression is required for cron schedules");
  }

  const ref = parseTemplateRef(body);

  const result = db.insert(schedules).values({
    templateScope: ref.templateScope,
    templateName: ref.templateName,
    templateWorkspaceId: ref.templateWorkspaceId,
    templateProjectId: ref.templateProjectId,
    assignedKeyId: body.assignedKeyId ?? null,
    scheduleType: body.scheduleType,
    cronExpression: body.cronExpression ?? null,
    runAt: body.runAt ?? null,
    timezone: body.timezone ?? "UTC",
    status: "active",
    misfireGraceSeconds: body.misfireGraceSeconds ?? null,
  }).returning().get();

  // Start cron job if applicable
  /* v8 ignore next — `result` from returning().get() on a just-inserted row is always defined */
  if (result && body.cronExpression) {
    schedulerService.schedule(result.id, body.cronExpression, body.timezone);
  }

  // Compute initial nextFireTime
  /* v8 ignore next — `result` is always defined (see above) */
  if (result && body.cronExpression) {
    const nextFire = schedulerService.computeNextFireTime(body.cronExpression, body.timezone);
    if (nextFire) {
      const db2 = getDb();
      db2.update(schedules)
        .set({ nextFireTime: nextFire })
        .where(eq(schedules.id, result.id))
        .run();
      result.nextFireTime = nextFire;
    }
  }

  return c.json(result, 201);
});

// PATCH /schedules/:id
scheduleRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  const body = await c.req.json();

  // Template reference is mutable, but all four columns move together to
  // preserve the CHECK constraint. The caller must supply the full new
  // reference if any of its parts changes.
  const wantsTemplateChange =
    body.templateScope !== undefined ||
    body.templateName !== undefined ||
    body.templateWorkspaceId !== undefined ||
    body.templateProjectId !== undefined;

  let ref: TemplateRef | null = null;
  if (wantsTemplateChange) {
    ref = parseTemplateRef({
      templateScope: body.templateScope ?? existing.templateScope,
      templateName: body.templateName ?? existing.templateName,
      templateWorkspaceId: body.templateWorkspaceId ?? existing.templateWorkspaceId,
      templateProjectId: body.templateProjectId ?? existing.templateProjectId,
    });
  }

  db.update(schedules)
    .set({
      ...(ref && {
        templateScope: ref.templateScope,
        templateName: ref.templateName,
        templateWorkspaceId: ref.templateWorkspaceId,
        templateProjectId: ref.templateProjectId,
      }),
      ...(body.assignedKeyId !== undefined && { assignedKeyId: body.assignedKeyId }),
      ...(body.cronExpression !== undefined && { cronExpression: body.cronExpression }),
      ...(body.runAt !== undefined && { runAt: body.runAt }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.misfireGraceSeconds !== undefined && { misfireGraceSeconds: body.misfireGraceSeconds }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schedules.id, id))
    .run();

  // Reschedule if cron expression changed
  if (body.cronExpression !== undefined && existing.status === "active") {
    schedulerService.remove(id);
    if (body.cronExpression) {
      schedulerService.schedule(id, body.cronExpression, body.timezone ?? existing.timezone ?? undefined);
    }
  }

  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return c.json(updated);
});

// DELETE /schedules/:id
scheduleRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  schedulerService.remove(id);
  db.delete(schedules).where(eq(schedules.id, id)).run();
  return c.json({ deleted: true });
});

// POST /schedules/:id/pause
scheduleRoutes.post("/:id/pause", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");
  if (existing.status !== "active") throw new ValidationError("Schedule is not active");

  schedulerService.pause(id);
  db.update(schedules).set({ status: "paused", updatedAt: new Date().toISOString() }).where(eq(schedules.id, id)).run();
  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return c.json(updated);
});

// POST /schedules/:id/resume
scheduleRoutes.post("/:id/resume", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");
  if (existing.status !== "paused") throw new ValidationError("Schedule is not paused");

  schedulerService.resume(id);
  db.update(schedules).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(schedules.id, id)).run();
  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return c.json(updated);
});

// GET /schedules/:id/tasks — tasks created by this schedule
scheduleRoutes.get("/:id/tasks", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const { page, perPage, offset } = paginationParams(c);

  const schedule = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!schedule) throw new NotFoundError("Schedule");

  // Task label prefix is `scheduled-<templateName>-…` (see scheduler.ts).
  // We look up by the template name recorded on the schedule itself so
  // deleting or renaming the template file on disk doesn't hide history.
  const prefix = `scheduled-${schedule.templateName}-`;
  const where = like(tasks.label, `${prefix}%`);
  const items = db.select().from(tasks).where(where).orderBy(desc(tasks.createdAt)).limit(perPage).offset(offset).all();
  /* v8 ignore next — SQL count(*) aggregate always returns one row */
  const total = db.select({ count: sql<number>`count(*)` }).from(tasks).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// POST /schedules/:id/trigger — run now
scheduleRoutes.post("/:id/trigger", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  schedulerService.triggerNow(id);

  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return c.json(updated);
});
