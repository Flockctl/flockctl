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
import { parseIdParam, parseIdQuery, parsePositiveIntQuery } from "../lib/route-params.js";
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

// ─── In-memory cache for GET /incidents/tags (audit-round-3 fix) ───
//
// The tags typeahead fires this endpoint on every dialog focus. Without
// caching, each call re-scans the incidents table and JSON.parse's every
// row's `tags` blob. We cache the resulting sorted array per scope with
// a short TTL; mutating handlers below call `invalidateTagsCache` so a
// freshly-saved tag appears the next time the dialog opens.

const TAGS_CACHE_TTL_MS = 30 * 1000;
interface TagsCacheEntry {
  tags: string[];
  expiresAt: number;
}
const tagsCache = new Map<string | number, TagsCacheEntry>();

function readTagsCache(key: string | number): string[] | null {
  const entry = tagsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tagsCache.delete(key);
    return null;
  }
  return entry.tags;
}

function writeTagsCache(key: string | number, tags: string[]): void {
  tagsCache.set(key, { tags, expiresAt: Date.now() + TAGS_CACHE_TTL_MS });
  // Bounded growth — at most the all-scopes key plus one per project
  // ever exists, but cap defensively at 256 in case of churn from
  // bursty traffic before a project is GC'd.
  if (tagsCache.size > 256) {
    const oldest = tagsCache.keys().next().value;
    if (oldest !== undefined) tagsCache.delete(oldest);
  }
}

function invalidateTagsCache(projectId?: number | null): void {
  // Always clear the all-scopes key. When a projectId is provided,
  // clear that specific bucket too.
  tagsCache.delete("_");
  if (typeof projectId === "number") tagsCache.delete(projectId);
}

/**
 * Test-only escape hatch. Tests bypass the POST handler and insert
 * rows via Drizzle directly, so the route-level invalidation never
 * fires. Tests can import this and reset state in `beforeEach` to
 * keep their assertions deterministic across cases.
 *
 * @internal — production code MUST NOT call this.
 */
export function _resetIncidentsTagsCache(): void {
  tagsCache.clear();
}

/** Fetch an incident row by id, throwing `NotFoundError("Incident", id)` if missing. */
function getIncidentOrThrow(id: number): IncidentRow {
  return requireRow(
    getDb().select().from(incidents).where(eq(incidents.id, id)).get(),
    "Incident",
    id,
  );
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
//
// Audit-round-3 finding: the previous shape scanned the entire incidents
// table and JSON.parse'd every row's `tags` blob on every request. The
// dialog typeahead fires this endpoint on every focus → noticeable cost
// once an operator accumulates hundreds of incidents.
//
// Fix: short-lived in-memory cache keyed by `projectId ?? "_"` with a
// 30s TTL. The cache is invalidated explicitly by `invalidateTagsCache`
// (called from POST/PUT/DELETE handlers below) and falls back to a
// time-based expiry so a daemon that misses an invalidation (e.g. direct
// DB write outside the route) eventually recovers.
incidentRoutes.get("/tags", (c) => {
  const db = getDb();

  const projectId = parseIdQuery(c, "projectId");
  const cacheKey = projectId ?? "_";

  const cached = readTagsCache(cacheKey);
  if (cached) {
    c.header("X-Cache", "hit");
    return c.json({ tags: cached });
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
  writeTagsCache(cacheKey, tags);
  c.header("X-Cache", "miss");
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

  const projectId = parseIdQuery(c, "projectId");
  // `?limit=` is optional — absent/empty falls back to the service-layer
  // default (DEFAULT_LIMIT = 10), and the service itself caps at MAX_LIMIT.
  // The route only enforces "positive integer" so the operator gets a 422
  // instead of a silent clamp on `?limit=0` or `?limit=-5`.
  const limit = parsePositiveIntQuery(c, "limit");

  const items = searchIncidents(q, { tags, projectId, limit });
  return c.json({ items, total: items.length });
});

// GET /incidents/:id
incidentRoutes.get("/:id", (c) => {
  const id = parseIdParam(c);
  return c.json(serialize(getIncidentOrThrow(id)));
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

  if (data.tags && data.tags.length > 0) {
    invalidateTagsCache(data.projectId ?? null);
  }
  return c.json(serialize(row), 201);
});

// PUT /incidents/:id
incidentRoutes.put("/:id", async (c) => {
  const id = parseIdParam(c);
  getIncidentOrThrow(id);

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

  // `.returning().get()` removes the second SELECT round-trip and the unsafe
  // `!` non-null assertion the old form relied on (it would have thrown a
  // confusing 500 if a concurrent DELETE landed between the UPDATE and the
  // re-fetch — vanishingly unlikely, but still wrong).
  const updated = getDb()
    .update(incidents)
    .set(patch)
    .where(eq(incidents.id, id))
    .returning()
    .get();
  // Tags may have been mutated — invalidate the tags cache so the
  // typeahead picks up the change on the next dialog open.
  if (data.tags !== undefined) {
    invalidateTagsCache(data.projectId ?? updated?.projectId ?? null);
  }
  return c.json(serialize(requireRow(updated, "Incident", id)));
});

// DELETE /incidents/:id
incidentRoutes.delete("/:id", (c) => {
  const id = parseIdParam(c);
  const row = getIncidentOrThrow(id);
  getDb().delete(incidents).where(eq(incidents.id, id)).run();
  // Deleted incident may have been the last carrier of a given tag —
  // invalidate so the typeahead drops orphaned values.
  invalidateTagsCache(row.projectId ?? null);
  return c.json({ deleted: true });
});
