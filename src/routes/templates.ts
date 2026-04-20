import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { taskTemplates } from "../db/schema.js";
import { eq, sql, desc } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";

export const templateRoutes = new Hono();

// GET /templates
templateRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const projectId = c.req.query("project_id");
  const where = projectId ? eq(taskTemplates.projectId, parseInt(projectId)) : undefined;

  const items = db.select().from(taskTemplates).where(where).orderBy(desc(taskTemplates.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(taskTemplates).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /templates/:id
templateRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const template = db.select().from(taskTemplates).where(eq(taskTemplates.id, id)).get();
  if (!template) throw new NotFoundError("Template");
  return c.json(template);
});

// POST /templates
templateRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.name) throw new ValidationError("name is required");

  const result = db.insert(taskTemplates).values({
    projectId: body.projectId ?? null,
    name: body.name,
    description: body.description ?? null,
    prompt: body.prompt ?? null,
    agent: body.agent ?? null,
    model: body.model ?? null,
    image: body.image ?? null,
    workingDir: body.workingDir ?? null,
    envVars: body.envVars ? JSON.stringify(body.envVars) : null,
    timeoutSeconds: body.timeoutSeconds ?? null,
    labelSelector: body.labelSelector ?? null,
    assignedKeyId: body.assignedKeyId ?? null,
  }).returning().get();

  return c.json(result, 201);
});

// PATCH /templates/:id
templateRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(taskTemplates).where(eq(taskTemplates.id, id)).get();
  if (!existing) throw new NotFoundError("Template");

  const body = await c.req.json();
  db.update(taskTemplates)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.prompt !== undefined && { prompt: body.prompt }),
      ...(body.agent !== undefined && { agent: body.agent }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.image !== undefined && { image: body.image }),
      ...(body.workingDir !== undefined && { workingDir: body.workingDir }),
      ...(body.envVars !== undefined && { envVars: body.envVars ? JSON.stringify(body.envVars) : null }),
      ...(body.timeoutSeconds !== undefined && { timeoutSeconds: body.timeoutSeconds }),
      ...(body.labelSelector !== undefined && { labelSelector: body.labelSelector }),
      ...(body.projectId !== undefined && { projectId: body.projectId }),
      ...(body.assignedKeyId !== undefined && { assignedKeyId: body.assignedKeyId }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(taskTemplates.id, id))
    .run();

  const updated = db.select().from(taskTemplates).where(eq(taskTemplates.id, id)).get();
  return c.json(updated);
});

// DELETE /templates/:id
templateRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(taskTemplates).where(eq(taskTemplates.id, id)).get();
  if (!existing) throw new NotFoundError("Template");

  db.delete(taskTemplates).where(eq(taskTemplates.id, id)).run();
  return c.json({ deleted: true });
});
