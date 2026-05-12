/**
 * Outgoing-JSON timestamp normaliser.
 *
 * The daemon's persistence layer mixes two shapes for timestamp values that
 * eventually land in API responses:
 *
 *   1. ISO 8601 with explicit UTC marker — `"2026-04-27T18:17:11.497Z"`.
 *      Emitted by JS code paths that route through `new Date().toISOString()`
 *      before serialising. JS, Python, Go, etc. all parse this unambiguously.
 *
 *   2. Bare SQLite — `"2026-04-27 17:04:51"`. Emitted by columns whose default
 *      is `(datetime('now'))`; SQLite stores the value as UTC but writes it
 *      with no timezone marker. When a route returns the row directly the
 *      client receives a naïve string — `new Date(naïve)` parses it as **local
 *      time**, drifting wall-clock readings by the user's UTC offset (the
 *      "everything is 3 hours off in Moscow" symptom).
 *
 * Rather than audit every route to add `.toISOString()` calls (and remember to
 * do so on every new endpoint forever), this module exports a small pair:
 *
 *   - {@link toIsoUtcString} — pure, idempotent string-to-string converter.
 *     ISO inputs (with `Z` or numeric offset) pass through unchanged. Bare
 *     SQLite (and ISO-without-TZ) gets a `Z` appended after canonicalising
 *     to `T`-separated form.
 *
 *   - {@link normalizeTimestampsDeep} — walks an arbitrary JSON value and
 *     rewrites every string that looks like a leaked timestamp. Used as
 *     a Hono response middleware in `server.ts` so EVERY JSON body the
 *     daemon emits is normalised at one chokepoint.
 *
 * **Why a regex on the value is safe.** The match pattern is so specific that
 * a non-timestamp string colliding with it is a vanishing edge case: it would
 * have to be exactly `YYYY-MM-DD[T| ]HH:MM:SS(.ms)?` with no surrounding
 * characters. Even if such a string appeared in user-provided notes, rewriting
 * it to ISO-Z is a no-op in display (still the same date); we deliberately do
 * NOT key on field names because new endpoints introduce new field names all
 * the time and a field-name allowlist would silently leak whenever someone
 * forgot to update it.
 */

/**
 * Match a "naïve" timestamp — date and time with no timezone marker. The
 * trailing `(\.\d+)?` accepts millisecond suffixes from SQLite's `STRFTIME`
 * variants. Anchored on both ends so we never partially-rewrite a string that
 * happens to embed a timestamp (e.g. log lines).
 */
const NAIVE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/**
 * Match a value that already has explicit UTC (`Z`) or a numeric offset
 * (`+03:00`, `-0500`, etc.). When this matches we leave the input alone.
 */
const HAS_TZ_MARKER_RE = /[Zz]$|[+-]\d{2}:?\d{2}$/;

/**
 * Convert a server-side timestamp string to canonical ISO-8601 UTC.
 *
 *   - `"2026-04-27 17:04:51"`        → `"2026-04-27T17:04:51.000Z"`
 *   - `"2026-04-27 17:04:51.123"`    → `"2026-04-27T17:04:51.123Z"`
 *   - `"2026-04-27T17:04:51"`        → `"2026-04-27T17:04:51.000Z"`
 *   - `"2026-04-27T17:04:51.497Z"`   → unchanged
 *   - `"2026-04-27T17:04:51+03:00"`  → unchanged
 *   - any non-timestamp string       → unchanged
 *
 * Idempotent: feeding the output back in produces the same string. This means
 * the response middleware can run on already-normalised payloads without any
 * double-rewrite hazard.
 */
export function toIsoUtcString(input: string): string {
  // Already explicit — pass through.
  if (HAS_TZ_MARKER_RE.test(input)) return input;
  const m = NAIVE_TIMESTAMP_RE.exec(input);
  if (!m) return input;
  const [, date, time, frac] = m;
  return `${date}T${time}${frac ?? ".000"}Z`;
}

/**
 * Walk an arbitrary JSON-shaped value and return a structurally-equivalent
 * value with every leaked-timestamp string rewritten via {@link toIsoUtcString}.
 *
 *   - Strings: rewritten if they match the naïve-timestamp pattern.
 *   - Arrays: each element is normalised; identity preserved when nothing
 *     changed (so the middleware can short-circuit).
 *   - Plain objects: each property's value is normalised. The key name itself
 *     is never inspected — the value pattern is the discriminator.
 *   - Other primitives (number, boolean, null, undefined, bigint, symbol):
 *     returned as-is.
 *
 * Cycle-safe behaviour is NOT provided — JSON responses are by definition
 * acyclic, and adding a `WeakSet` traversal would cost more than the entire
 * rewrite. If a future caller needs to walk a cyclic graph it should pre-flatten.
 */
export function normalizeTimestampsDeep<T>(value: T): T {
  if (typeof value === "string") {
    const rewritten = toIsoUtcString(value);
    return rewritten === value ? value : (rewritten as unknown as T);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = normalizeTimestampsDeep(value[i]);
      if (next !== value[i]) changed = true;
      out[i] = next;
    }
    return (changed ? out : value) as T;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      const next = normalizeTimestampsDeep(v);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
