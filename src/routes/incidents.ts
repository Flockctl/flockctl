import { Hono } from "hono";
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { incidents } from "../db/schema.js";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { flattenZodError } from "../lib/zod-utils.js";
import { jsonSafeParseStringArray } from "../lib/json-safe-parse.js";
import { requireRow } from "../lib/db-helpers.js";
import { searchIncidents } from "../services/incidents/service.js";

export const incidentRoutes = new Hono();

// ─── Zod schemas ───
// `title` is required on create. `tags` is an optional string[] and is
// persisted as a JSON-encoded TEXT column (see schema.ts). All other text
// fields are optional and nullable at the DB level.
const tagsSchema = z.array(z.string()).optional();

const createSchema = z.object({
  title: z.string().min(1, "title is required"),
  symptom: z.string().nullish(),
  rootCause: z.string().nullish(),
  resolution: z.string().nullish(),
  tags: tagsSchema,
  projectId: z.number().int().nullish(),
  createdByChatId: z.number().int().nullish(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  symptom: z.string().nullish(),
  rootCause: z.string().nullish(),
  resolution: z.string().nullish(),
  tags: tagsSchema,
  projectId: z.number().int().nullish(),
  createdByChatId: z.number().int().nullish(),
});

type IncidentRow = typeof incidents.$inferSelect;

interface IncidentResponse extends Omit<IncidentRow, "tags"> {
  tags: string[] | null;
}

function serialize(row: IncidentRow): IncidentResponse {
  return { ...row, tags: jsonSafeParseStringArray(row.tags) };
}

function parseIdParam(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("invalid id");
  return id;
}

// GET /incidents — paginated list, newest first
incidentRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const rows = db
    .select()
    .from(incidents)
    .orderBy(desc(incidents.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();
  const total = db.select({ count: sql<number>`count(*)` }).from(incidents).get()?.count ?? 0;

  return c.json({
    items: rows.map(serialize),
    total,
    page,
    perPage,
  });
});

// GET /incidents/tags?projectId=
// Returns the distinct set of tag strings ever used in incidents — optionally
// scoped to a single project. Feeds the typeahead in the "Save as incident"
// dialog so users converge on a consistent tag vocabulary per project.
//
// Registered before `/:id` so "tags" is not captured by the id matcher.
incidentRoutes.get("/tags", (c) => {
  const db = getDb();

  const rawProjectId = c.req.query("projectId");
  let projectId: number | undefined;
  if (rawProjectId !== undefined && rawProjectId !== "") {
    const n = Number(rawProjectId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError("invalid projectId");
    }
    projectId = n;
  }

  // `tags` is stored as a JSON-encoded string array per incident; aggregate
  // client-side since SQLite lacks a cheap JSON-array-flatten primitive (and
  // the incident table is small — at most thousands of rows in practice).
  const rows = projectId
    ? db.select({ tags: incidents.tags }).from(incidents).where(eq(incidents.projectId, projectId)).all()
    : db.select({ tags: incidents.tags }).from(incidents).all();

  const tagSet = new Set<string>();
  for (const row of rows) {
    if (!row.tags) continue;
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          if (typeof t === "string" && t.trim().length > 0) {
            tagSet.add(t.trim());
          }
        }
      }
    } catch {
      /* malformed tags row — skip */
    }
  }

  const tags = [...tagSet].sort((a, b) => a.localeCompare(b));
  return c.json({ tags });
});

// GET /incidents/search?q=&tags=&projectId=&limit=
// Thin adapter over `searchIncidents()`. Registered before `/:id` so that
// the word "search" is not captured by the id matcher.
//
// Query params:
//   q         — free-text query, matched against symptom/root_cause/resolution
//               via FTS5 (BM25 ranking). May be empty — then falls back to
//               recency + tag/project filters.
//   tags      — comma-separated list. Incidents must share at least one tag;
//               the size of the intersection boosts the score.
//   projectId — integer, restricts to a single project.
//   limit     — optional, default 10, clamped to [1, 100].
incidentRoutes.get("/search", (c) => {
  const q = c.req.query("q") ?? "";
  const rawTags = c.req.query("tags");
  const tags = rawTags
    ? rawTags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined;

  const rawProjectId = c.req.query("projectId");
  let projectId: number | undefined;
  if (rawProjectId !== undefined && rawProjectId !== "") {
    const n = Number(rawProjectId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError("invalid projectId");
    }
    projectId = n;
  }

  const rawLimit = c.req.query("limit");
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError("invalid limit");
    }
    limit = n;
  }

  const items = searchIncidents(q, { tags, projectId, limit });
  return c.json({ items, total: items.length });
});

// GET /incidents/:id
incidentRoutes.get("/:id", (c) => {
  const id = parseIdParam(c.req.param("id"));
  const row = requireRow(
    getDb().select().from(incidents).where(eq(incidents.id, id)).get(),
    "Incident",
    id,
  );
  return c.json(serialize(row));
});

// POST /incidents
incidentRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  const row = getDb()
    .insert(incidents)
    .values({
      title: data.title,
      symptom: data.symptom ?? null,
      rootCause: data.rootCause ?? null,
      resolution: data.resolution ?? null,
      tags: data.tags && data.tags.length > 0 ? JSON.stringify(data.tags) : null,
      projectId: data.projectId ?? null,
      createdByChatId: data.createdByChatId ?? null,
    })
    .returning()
    .get();

  return c.json(serialize(row), 201);
});

// PUT /incidents/:id
incidentRoutes.put("/:id", async (c) => {
  const id = parseIdParam(c.req.param("id"));
  requireRow(
    getDb().select().from(incidents).where(eq(incidents.id, id)).get(),
    "Incident",
    id,
  );

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  const patch: Partial<IncidentRow> = {
    updatedAt: new Date().toISOString(),
  };
  if (data.title !== undefined) patch.title = data.title;
  if (data.symptom !== undefined) patch.symptom = data.symptom ?? null;
  if (data.rootCause !== undefined) patch.rootCause = data.rootCause ?? null;
  if (data.resolution !== undefined) patch.resolution = data.resolution ?? null;
  if (data.tags !== undefined) patch.tags = data.tags && data.tags.length > 0 ? JSON.stringify(data.tags) : null;
  if (data.projectId !== undefined) patch.projectId = data.projectId ?? null;
  if (data.createdByChatId !== undefined) patch.createdByChatId = data.createdByChatId ?? null;

  getDb().update(incidents).set(patch).where(eq(incidents.id, id)).run();
  const updated = getDb().select().from(incidents).where(eq(incidents.id, id)).get()!;
  return c.json(serialize(updated));
});

// DELETE /incidents/:id
incidentRoutes.delete("/:id", (c) => {
  const id = parseIdParam(c.req.param("id"));
  requireRow(
    getDb().select().from(incidents).where(eq(incidents.id, id)).get(),
    "Incident",
    id,
  );
  getDb().delete(incidents).where(eq(incidents.id, id)).run();
  return c.json({ deleted: true });
});
