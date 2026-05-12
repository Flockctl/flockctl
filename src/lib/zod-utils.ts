import { z } from "zod";

/**
 * Flatten a Zod error into a `{ field: messages[] }` map suitable for
 * `ValidationError` / `AppError` details.
 *
 * Issues are keyed by their TOP-LEVEL path segment (or `_` when the issue
 * has no path) — nested issues at e.g. `["acceptanceCriteria", 1]` collapse
 * onto the `acceptanceCriteria` bucket. This matches what the UI does with
 * the details map: it highlights the offending top-level form field; the
 * specific array index / nested object is not relevant for that affordance.
 * Every `body.details.<field>` test in the route suite assumes this shape.
 */
export function flattenZodError(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
    (out[key] ||= []).push(issue.message);
  }
  return out;
}

/**
 * Shared schema for `{ id }` URL params — coerces to a positive integer.
 *
 * Replaces the 5+ inline copies (`tasks/permissions.ts`,
 * `chats/questions.ts`, `chats/attachments.ts`, `chats/todos.ts`).
 */
export const positiveIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

