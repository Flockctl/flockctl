import { z } from "zod";

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

/**
 * Shared schema for `{ id }` URL params — coerces to a positive integer.
 *
 * Replaces the 5+ inline copies (`tasks/permissions.ts`,
 * `chats/questions.ts`, `chats/attachments.ts`, `chats/todos.ts`).
 */
export const positiveIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

