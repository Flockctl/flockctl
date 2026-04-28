import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  workspaces,
  projects,
  tasks,
  chats,
  schedules,
  aiProviderKeys,
} from "../db/schema.js";
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

/**
 * Look up a workspace by id; throw `NotFoundError("Workspace", id)` if missing.
 *
 * Replaces the ~13 inline copies of:
 *   const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
 *   if (!ws) throw new NotFoundError("Workspace", id);
 */
export function getWorkspaceOrThrow(id: number) {
  const row = getDb().select().from(workspaces).where(eq(workspaces.id, id)).get();
  return requireRow(row, "Workspace", id);
}

/**
 * Look up a project by id; throw `NotFoundError("Project", id)` if missing.
 */
export function getProjectOrThrow(id: number) {
  const row = getDb().select().from(projects).where(eq(projects.id, id)).get();
  return requireRow(row, "Project", id);
}

/**
 * Look up a task by id; throw `NotFoundError("Task", id)` if missing.
 */
export function getTaskOrThrow(id: number) {
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
  return requireRow(row, "Task", id);
}

/**
 * Look up a chat by id; throw `NotFoundError("Chat", id)` if missing.
 */
export function getChatOrThrow(id: number) {
  const row = getDb().select().from(chats).where(eq(chats.id, id)).get();
  return requireRow(row, "Chat", id);
}

/**
 * Look up a schedule by id; throw `NotFoundError("Schedule", id)` if missing.
 */
export function getScheduleOrThrow(id: number) {
  const row = getDb().select().from(schedules).where(eq(schedules.id, id)).get();
  return requireRow(row, "Schedule", id);
}

/**
 * Look up an AI provider key by id; throw `NotFoundError("AI Key", id)` if missing.
 */
export function getAiKeyOrThrow(id: number) {
  const row = getDb().select().from(aiProviderKeys).where(eq(aiProviderKeys.id, id)).get();
  return requireRow(row, "AI Key", id);
}

