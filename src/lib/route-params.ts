import type { Context } from "hono";
import { ValidationError } from "./errors.js";

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
 * Parse an OPTIONAL `?name=…` query parameter as a positive integer.
 *
 * Returns `undefined` when the query is absent or empty (caller treats the
 * filter / cap as "not applied"). Throws `ValidationError` when the value
 * is present but malformed — `parseInt("abc", 10)` returns `NaN`, and
 * `WHERE col = NaN` silently filters everything out, so the previous inline
 * pattern returned 200 with an empty list instead of a 422 to the API
 * client. Mirrors {@link parseIdParam}'s strict-string round-trip check so
 * "1.5" and "1abc" don't slip through.
 *
 * Use for any optional positive-integer query param: row ids (`?project_id=`,
 * `?ai_provider_key_id=`) or row counts (`?limit=`) where the route wants
 * strict 422 on 0/negative and silent "not applied" on absent/empty.
 */
export function parsePositiveIntQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new ValidationError(`invalid ${name} — expected a positive integer`);
  }
  return parsed;
}

/**
 * Backward-compatible alias for {@link parsePositiveIntQuery}, kept for the
 * routes layer's id-flavoured call sites (`?project_id=`, etc.).
 *
 * Semantically identical — same strict-positive-integer contract, same
 * error message. Picking the right name is a readability choice: use
 * `parseIdQuery` when the param is an FK reference, `parsePositiveIntQuery`
 * for other positive-int parameters like `?limit=`.
 */
export const parseIdQuery = parsePositiveIntQuery;

/**
 * Parse an optional integer-bounded `?name=…` query parameter, clamped to
 * `[min, max]` and falling back to `defaultValue` when absent.
 *
 * Use for "page-size" / "max lines" knobs where the caller MAY tune the
 * response size but a malicious client must not be able to ask for
 * `?maxLines=999999999` and force the server to render the entire diff. The
 * canonical example is `GET /tasks/:id/diff?maxLines=` (and the chat
 * counterpart) — both used to do `parseInt(... ?? "2000", 10) || 2000`, which
 * accepted `Infinity`-style payloads (`1e9`) verbatim.
 *
 * Throws `ValidationError` when the value is present but non-numeric — the
 * `|| defaultValue` short-circuit in the old inline form silently rewrote
 * malformed input to the default, hiding API misuse.
 */
export function parseBoundedIntQuery(
  c: Context,
  name: string,
  opts: { min: number; max: number; default: number },
): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return opts.default;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw) {
    throw new ValidationError(`invalid ${name} — expected an integer`);
  }
  if (parsed < opts.min) return opts.min;
  if (parsed > opts.max) return opts.max;
  return parsed;
}

/**
 * Parse the JSON body of a request, returning `{}` on parse failure.
 *
 * Audit-round-7 finding: many route handlers do bare
 * `await c.req.json()` without a `.catch(...)` — an empty body or
 * malformed JSON surfaces as a generic 500 (or, worse, an unhandled
 * rejection that hits server-entry's `unhandledRejection` handler and
 * exits the daemon). This helper centralises the recovery contract
 * so every handler can short-circuit to `{}` and let downstream
 * field-validation produce a clean 422.
 *
 * Use this everywhere instead of bare `await c.req.json()` in route
 * handlers. Returns `any` to be a drop-in replacement for Hono's
 * `c.req.json()` (which itself returns `Promise<any>`); the safety
 * win is purely the `.catch(() => ({}))` short-circuit, not a
 * type-level guard at this layer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBodySafe(c: Context): Promise<any> {
  return c.req.json().catch(() => ({}));
}

