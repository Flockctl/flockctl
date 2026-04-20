import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { schedules, taskTemplates, tasks } from "../db/schema.js";
import { eq, and, sql, desc, like } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { schedulerService } from "../services/scheduler.js";

export const scheduleRoutes = new Hono();

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
  const total = db.select({ count: sql<number>`count(*)` }).from(schedules).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /schedules/:id
scheduleRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const schedule = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!schedule) throw new NotFoundError("Schedule");

  // Include template info
  let template = null;
  if (schedule.templateId) {
    template = db.select().from(taskTemplates).where(eq(taskTemplates.id, schedule.templateId)).get();
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

  const result = db.insert(schedules).values({
    templateId: body.templateId ?? null,
    scheduleType: body.scheduleType,
    cronExpression: body.cronExpression ?? null,
    runAt: body.runAt ?? null,
    timezone: body.timezone ?? "UTC",
    status: "active",
    misfireGraceSeconds: body.misfireGraceSeconds ?? null,
  }).returning().get();

  // Start cron job if applicable
  if (result && body.cronExpression) {
    schedulerService.schedule(result.id, body.cronExpression, body.timezone);
  }

  // Compute initial nextFireTime
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
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  const body = await c.req.json();
  db.update(schedules)
    .set({
      ...(body.templateId !== undefined && { templateId: body.templateId }),
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
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  schedulerService.remove(id);
  db.delete(schedules).where(eq(schedules.id, id)).run();
  return c.json({ deleted: true });
});

// POST /schedules/:id/pause
scheduleRoutes.post("/:id/pause", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
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
  const id = parseInt(c.req.param("id"));
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
  const id = parseInt(c.req.param("id"));
  const { page, perPage, offset } = paginationParams(c);

  const schedule = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!schedule) throw new NotFoundError("Schedule");

  const template = schedule.templateId
    ? db.select().from(taskTemplates).where(eq(taskTemplates.id, schedule.templateId)).get()
    : null;

  if (!template) {
    return c.json({ items: [], total: 0, page, perPage });
  }

  const prefix = `scheduled-${template.name}-`;
  const where = like(tasks.label, `${prefix}%`);
  const items = db.select().from(tasks).where(where).orderBy(desc(tasks.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(tasks).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// POST /schedules/:id/trigger — run now
scheduleRoutes.post("/:id/trigger", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) throw new NotFoundError("Schedule");

  schedulerService.triggerNow(id);

  const updated = db.select().from(schedules).where(eq(schedules.id, id)).get();
  return c.json(updated);
});
