/**
 * Parse a JSON string without throwing. Returns `null` on any parse failure
 * or when the payload is falsy. Use for optional JSON-encoded TEXT columns
 * (tags, metadata, etc.) where corruption should be tolerated.
 */
export function jsonSafeParse<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON string as `string[]`, returning `null` if the payload is
 * missing, malformed, or not a plain array of strings.
 */
export function jsonSafeParseStringArray(raw: string | null | undefined): string[] | null {
  const parsed = jsonSafeParse<unknown>(raw);
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((t) => typeof t === "string")) return null;
  return parsed;
}

/**
 * Parse a JSON string as `number[]`, returning `null` if the payload is
 * missing, malformed, or not a plain array of finite numbers. Mirrors
 * {@link jsonSafeParseStringArray} for numeric columns (key-id allowlists,
 * weight tables, etc.).
 */
export function jsonSafeParseNumberArray(raw: string | null | undefined): number[] | null {
  const parsed = jsonSafeParse<unknown>(raw);
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return parsed;
}

/**
 * Parse a JSON string into an opaque `unknown`, returning a structured
 * `{ _parse_error: true, raw }` envelope on any failure. Useful for forensic
 * surfaces (mission events, audit logs) where a corrupted blob must NOT
 * poison the entire response — the caller can render a "(unparseable)"
 * placeholder for that one row and keep going.
 */
export function jsonSafeParseOrParseError(
  raw: string,
): unknown | { _parse_error: true; raw: string } {
  const parsed = jsonSafeParse<unknown>(raw);
  // Distinguish "parsed to literal null" from "failed to parse": if the input
  // string is the JSON token "null", we want to return null; if it is junk,
  // we want the error envelope. The only way to tell them apart is to retry
  // with try/catch on the raw input.
  if (parsed !== null) return parsed;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _parse_error: true, raw };
    }
  }
  /* v8 ignore next — raw is typed `string`; `typeof raw !== 'string'` is unreachable. */
  return { _parse_error: true, raw };
}
