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
