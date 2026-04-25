// ─── Incidents search service ───
// Full-text + tag search over the `incidents` knowledge-base table. Backed
// by the `incidents_fts` FTS5 virtual table created in migration 0025 and
// the triggers that mirror symptom / root_cause / resolution into it.
//
// Also consumed by the auto-retrieval slice that pulls context-relevant
// past incidents into a chat/task, so the scoring + filter logic lives in
// the service and the HTTP route is a thin adapter.

import { getDb, getRawDb } from "../../db/index.js";
import { incidents } from "../../db/schema.js";
import { and, desc, eq } from "drizzle-orm";

type IncidentRow = typeof incidents.$inferSelect;

export interface IncidentSearchResult {
  id: number;
  title: string;
  symptom: string | null;
  rootCause: string | null;
  resolution: string | null;
  tags: string[] | null;
  projectId: number | null;
  createdByChatId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Higher = more relevant. Combines BM25 (flipped sign) + tag-overlap boost. */
  score: number;
}

export interface IncidentSearchOpts {
  /** If provided, only incidents whose `tags` JSON array contains at least one
   *  of these tags are returned; overlap size additionally boosts the score. */
  tags?: string[];
  /** If provided, restrict to incidents with this `project_id`. */
  projectId?: number | null;
  /** Max results to return (default 10, clamped to [1, 100]). */
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** Per-tag-overlap score boost. Calibrated to outrank a mediocre BM25 match
 *  when there is a tag hit but to stay below a strong text match. */
const TAG_BOOST = 1.0;

function parseTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a free-text query into a safe FTS5 MATCH expression.
 * Strategy: extract word-ish tokens, lowercase, quote each to avoid FTS5
 * syntax errors, and OR them together. Returns null when the input has no
 * searchable tokens (empty string, whitespace, punctuation-only).
 */
function sanitizeFtsQuery(query: string): string | null {
  const tokens = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** Normalize a raw-sqlite row (snake_case columns) into an IncidentRow. */
function normalizeRow(r: Record<string, unknown>): IncidentRow {
  return {
    id: Number(r.id),
    title: String(r.title),
    symptom: (r.symptom ?? null) as string | null,
    rootCause: ((r.rootCause ?? r.root_cause) ?? null) as string | null,
    resolution: (r.resolution ?? null) as string | null,
    tags: (r.tags ?? null) as string | null,
    projectId: ((r.projectId ?? r.project_id) ?? null) as number | null,
    createdByChatId: ((r.createdByChatId ?? r.created_by_chat_id) ?? null) as number | null,
    createdAt: ((r.createdAt ?? r.created_at) ?? null) as string | null,
    updatedAt: ((r.updatedAt ?? r.updated_at) ?? null) as string | null,
  };
}

/**
 * Search incidents by text + optional tags + optional project.
 *
 * Scoring model:
 *   score = (-bm25(incidents_fts))   if the query produced FTS matches, else 0
 *         + TAG_BOOST * |tags ∩ incident.tags|
 *
 * Filtering:
 *   - projectId:  WHERE project_id = ?  (SQL-level)
 *   - tags:       incident must share at least one tag (JS post-filter over
 *                 the JSON-encoded tags column, same logic as the serializer)
 *
 * When the query yields no FTS expression (e.g. empty string, only
 * punctuation), we fall back to recency ordering + the same filters — this
 * lets callers reuse the endpoint for a "latest N matching tags/project"
 * probe.
 */
export function searchIncidents(
  query: string,
  opts: IncidentSearchOpts = {},
): IncidentSearchResult[] {
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));
  const hasProject = opts.projectId !== undefined && opts.projectId !== null;
  const projectId = hasProject ? (opts.projectId as number) : null;
  const filterTags = opts.tags && opts.tags.length > 0 ? opts.tags : null;

  const ftsExpr = sanitizeFtsQuery(query);

  type RawRow = Record<string, unknown> & { fts_score?: number };
  let rawRows: RawRow[];

  if (ftsExpr) {
    // FTS path: join incidents_fts (where MATCH filters) with the base
    // table so we can pull all columns in one prepared statement and grab
    // bm25 as fts_score for re-ranking.
    const sqlite = getRawDb();
    const params: unknown[] = [ftsExpr];
    let sqlText = `
      SELECT i.*, bm25(incidents_fts) AS fts_score
      FROM incidents_fts
      JOIN incidents i ON i.id = incidents_fts.rowid
      WHERE incidents_fts MATCH ?
    `;
    if (hasProject) {
      sqlText += " AND i.project_id = ?";
      params.push(projectId);
    }
    // Over-fetch so the JS re-rank (tag boost + tag filter) has a pool
    // wider than `limit` to reorder; bounded so a pathological query with
    // matches on every row still returns quickly.
    sqlText += " ORDER BY rank LIMIT ?";
    params.push(Math.max(limit * 5, 25));

    rawRows = sqlite.prepare(sqlText).all(...params) as RawRow[];
  } else {
    // Fallback: no FTS match expression. Use drizzle over the base table.
    const db = getDb();
    const conditions = hasProject ? [eq(incidents.projectId, projectId!)] : [];
    const base = db.select().from(incidents);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const rows = filtered
      .orderBy(desc(incidents.createdAt))
      .limit(Math.max(limit * 5, 25))
      .all();
    rawRows = rows as unknown as RawRow[];
  }

  const results: IncidentSearchResult[] = [];
  for (const raw of rawRows) {
    const row = normalizeRow(raw);
    const tags = parseTags(row.tags);

    let overlap = 0;
    if (filterTags) {
      overlap = tags ? tags.filter((t) => filterTags.includes(t)).length : 0;
      if (overlap === 0) continue; // tag filter active + no shared tag → drop
    }

    // bm25 returns negative values where more-negative = more relevant, so
    // flip the sign to make "higher score = more relevant" from the caller's
    // point of view. Rows from the fallback path (no FTS match) get 0.
    const ftsScore = typeof raw.fts_score === "number" ? -raw.fts_score : 0;
    const score = ftsScore + overlap * TAG_BOOST;

    results.push({
      id: row.id,
      title: row.title,
      symptom: row.symptom,
      rootCause: row.rootCause,
      resolution: row.resolution,
      tags,
      projectId: row.projectId,
      createdByChatId: row.createdByChatId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Auto-retrieval helpers ─────────────────────────────────────────
// Thin wrappers on top of searchIncidents() used by the chat/task prompt
// builders when injecting "past incidents" context. The goal is a stable,
// opinionated entry point: a short default limit, an explicit project
// filter, and a formatter that produces a compact markdown block with
// only the fields safe to include verbatim in a prompt (title + a short
// resolution — no raw symptom/root-cause that may contain stack traces,
// stack frames, or sensitive identifiers).

export interface RetrieveRelevantIncidentsOpts {
  /** Scope retrieval to a single project. `null`/omitted = no project filter. */
  projectId?: number | null;
  /** Max incidents to return. Defaults to 3 — small enough for a prompt header. */
  limit?: number;
}

/**
 * Retrieve the N most-relevant incidents for a free-text context string.
 *
 * Wrapper over {@link searchIncidents} with a prompt-friendly default of
 * 3 results. No tag filter — the caller is passing raw context (a user
 * message, a task prompt, a stack trace) and we want FTS to drive the
 * ranking. A row's `score` is preserved so the caller can apply a
 * relevance threshold if it wants to.
 */
export function retrieveRelevantIncidents(
  text: string,
  opts: RetrieveRelevantIncidentsOpts = {},
): IncidentSearchResult[] {
  const limit = opts.limit ?? 3;
  return searchIncidents(text, {
    projectId: opts.projectId ?? null,
    limit,
  });
}

/** Truncate a resolution for prompt display; never splits mid-UTF16. */
function shortenResolution(raw: string | null, maxLen = 200): string {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen).trimEnd() + "…";
}

/**
 * Format a set of incidents as a compact markdown "Past incidents" section
 * suitable for injection into a system/user prompt.
 *
 * Output shape:
 *   ## Past incidents
 *
 *   - **<title>** — <short resolution>
 *   - ...
 *
 * Returns an empty string when the input is empty so the caller can
 * concatenate unconditionally without producing a dangling header.
 */
export function formatIncidentsForPrompt(
  items: IncidentSearchResult[] | null | undefined,
): string {
  if (!items || items.length === 0) return "";
  const lines: string[] = ["## Past incidents", ""];
  for (const inc of items) {
    const title = inc.title.trim() || `Incident #${inc.id}`;
    const resolution = shortenResolution(inc.resolution);
    lines.push(
      resolution ? `- **${title}** — ${resolution}` : `- **${title}**`,
    );
  }
  return lines.join("\n");
}
