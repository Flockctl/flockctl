import { NotFoundError } from "./errors.js";

/**
 * Throw `NotFoundError` if `row` is falsy, otherwise return `row` with
 * nullability narrowed away. Use to collapse the ubiquitous
 * `db.select(...).get()` + null-check pattern into one expression:
 *
 * ```ts
 * const chat = requireRow(
 *   db.select().from(chats).where(eq(chats.id, id)).get(),
 *   "Chat",
 *   id,
 * );
 * ```
 *
 * Centralizing the 404 handling keeps error messages consistent across
 * resources.
 */
export function requireRow<T>(
  row: T | undefined | null,
  resourceName: string,
  id?: number | string,
): T {
  if (row === null || row === undefined) {
    throw new NotFoundError(resourceName, id);
  }
  return row;
}
