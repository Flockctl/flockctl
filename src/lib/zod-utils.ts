import type { z } from "zod";

/**
 * Flatten a Zod error into a `{ field: messages[] }` map suitable for
 * `ValidationError` details. Issues without a path are grouped under `_`.
 */
export function flattenZodError(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ||= []).push(issue.message);
  }
  return out;
}
