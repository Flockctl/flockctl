import type { Context } from "hono";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

/** Global default page size when neither `?per_page=` nor `?limit=` is supplied. */
const DEFAULT_PER_PAGE = 20;
/** Global hard cap on page size to prevent runaway LIMIT clauses. */
const DEFAULT_MAX_PER_PAGE = 100;

/** Optional knobs for endpoints that legitimately want a non-default page size. */
export interface PaginationOptions {
  /** Default page size when the caller omits `per_page`/`limit`. Defaults to 20. */
  defaultPerPage?: number;
  /** Hard upper-bound on page size. Defaults to 100. */
  maxPerPage?: number;
}

/**
 * Parse a query-string value into a finite number with a fallback.
 *
 * `Number("abc")` returns `NaN`, and `Math.min(100, Math.max(1, NaN))` is
 * still `NaN`. Without this guard a request like `?limit=abc` propagated a
 * `NaN` into a SQL `LIMIT NaN OFFSET NaN`, which better-sqlite3 rejects with a
 * generic 500. Round-tripping the raw value through `Number.isFinite` keeps
 * the route on the happy path with the documented default.
 *
 * Exported so the very few routes that pre-existed the unified pagination
 * helper (e.g. legacy `?limit=` style) can share the same NaN-safe semantics.
 */
export function parseIntParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve `?page=` / `?per_page=` (or the equivalent `?offset=` / `?limit=`)
 * into a canonical `{ page, perPage, offset }` triple.
 *
 * Pass `opts` only when an endpoint legitimately needs a non-default page
 * size — e.g. supervisor timeline events (`maxPerPage: 1000`) or task logs
 * (`defaultPerPage: 1000, maxPerPage: 5000`). The shape of the query
 * grammar stays identical so clients don't need to special-case those
 * endpoints; only the clamps change.
 */
export function paginationParams(
  c: Context,
  opts: PaginationOptions = {},
): { page: number; perPage: number; offset: number } {
  const defaultPerPage = opts.defaultPerPage ?? DEFAULT_PER_PAGE;
  const maxPerPage = opts.maxPerPage ?? DEFAULT_MAX_PER_PAGE;

  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");

  if (offsetRaw !== undefined || limitRaw !== undefined) {
    const perPage = Math.min(maxPerPage, Math.max(1, parseIntParam(limitRaw, defaultPerPage)));
    const offset = Math.max(0, parseIntParam(offsetRaw, 0));
    const page = Math.floor(offset / perPage) + 1;
    return { page, perPage, offset };
  }

  const page = Math.max(1, parseIntParam(c.req.query("page"), 1));
  const perPage = Math.min(
    maxPerPage,
    Math.max(1, parseIntParam(c.req.query("per_page"), defaultPerPage)),
  );
  return { page, perPage, offset: (page - 1) * perPage };
}
