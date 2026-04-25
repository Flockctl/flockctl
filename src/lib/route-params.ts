import type { Context } from "hono";
import { ValidationError, NotFoundError } from "./errors.js";

/**
 * Parse a route `:param` as a positive integer id.
 *
 * Returns the id (≥ 1) or throws `ValidationError` when the segment is
 * missing, non-numeric, or ≤ 0. Use this instead of the 80+ ad-hoc
 * `parseInt(c.req.param("id"), 10)` calls scattered across the route
 * handlers — those were all inconsistent about NaN handling, leading to
 * `WHERE id = NaN` queries that silently returned 404 instead of 422.
 *
 * @param c     Hono context
 * @param name  Param name (defaults to "id")
 */
export function parseIdParam(c: Context, name = "id"): number {
  const raw = c.req.param(name);
  if (raw === undefined || raw === "") {
    throw new ValidationError(`missing route param :${name}`);
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new ValidationError(`invalid :${name} — expected a positive integer`);
  }
  return parsed;
}

/**
 * Like {@link parseIdParam} but optional — returns `undefined` for missing
 * segments and still validates when the segment is present. Handy for
 * routes where the param is technically optional (e.g. "/chats/:id/whatever"
 * mounted as a catch-all).
 */
export function parseOptionalIdParam(c: Context, name = "id"): number | undefined {
  const raw = c.req.param(name);
  if (raw === undefined || raw === "") return undefined;
  return parseIdParam(c, name);
}

/**
 * Parse a route `:param` as a string, throwing 422 when absent. Wrapper for
 * consistency with {@link parseIdParam} and to avoid sprinkling `if (!raw)
 * throw` checks across handlers.
 */
export function parseStringParam(c: Context, name: string): string {
  const raw = c.req.param(name);
  if (raw === undefined || raw === "") {
    throw new ValidationError(`missing route param :${name}`);
  }
  return raw;
}

/**
 * Convenience: parse `:id`, then assert the referenced row exists. Pass a
 * loader (typically a Drizzle `.get()`) and the `kind` string the NotFound
 * message should use. Returns the row on success.
 */
export function parseIdParamOrNotFound<T>(
  c: Context,
  kind: string,
  loader: (id: number) => T | undefined,
  paramName = "id",
): { id: number; row: NonNullable<T> } {
  const id = parseIdParam(c, paramName);
  const row = loader(id);
  if (row === undefined || row === null) {
    throw new NotFoundError(`${kind} not found`);
  }
  return { id, row: row as NonNullable<T> };
}
