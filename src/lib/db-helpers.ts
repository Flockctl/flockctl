import { eq, sql } from "drizzle-orm";
import { getDb, type FlockctlDb } from "../db/index.js";
import {
  workspaces,
  projects,
  tasks,
  chats,
  schedules,
  aiProviderKeys,
} from "../db/schema.js";
import { NotFoundError } from "./errors.js";

// ─── Prepared-statement cache for PK lookups ─────────────────────────────
//
// `db.select().from(t).where(eq(t.id, ...)).get()` is called from inside
// many hot loops (chats list, attention aggregator, auto-executor
// reconciliation). Each call rebuilds Drizzle's query AST and re-parses
// SQL — wasted cycles on a per-PK lookup.
//
// Mirrors the WeakMap pattern in budget-enforcer.ts: lift each Drizzle
// statement into a per-DB-handle cache (keyed on the Drizzle instance
// because tests rotate it via `setDb()`).

interface PreparedPkSelects {
  workspaceById: ReturnType<typeof buildWorkspaceById>;
  projectById: ReturnType<typeof buildProjectById>;
  taskById: ReturnType<typeof buildTaskById>;
  chatById: ReturnType<typeof buildChatById>;
  scheduleById: ReturnType<typeof buildScheduleById>;
  aiKeyById: ReturnType<typeof buildAiKeyById>;
}

const buildWorkspaceById = (db: FlockctlDb) =>
  db.select().from(workspaces).where(eq(workspaces.id, sql.placeholder("id"))).prepare();
const buildProjectById = (db: FlockctlDb) =>
  db.select().from(projects).where(eq(projects.id, sql.placeholder("id"))).prepare();
const buildTaskById = (db: FlockctlDb) =>
  db.select().from(tasks).where(eq(tasks.id, sql.placeholder("id"))).prepare();
const buildChatById = (db: FlockctlDb) =>
  db.select().from(chats).where(eq(chats.id, sql.placeholder("id"))).prepare();
const buildScheduleById = (db: FlockctlDb) =>
  db.select().from(schedules).where(eq(schedules.id, sql.placeholder("id"))).prepare();
const buildAiKeyById = (db: FlockctlDb) =>
  db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, sql.placeholder("id"))).prepare();

const stmtCache = new WeakMap<FlockctlDb, PreparedPkSelects>();

function getStmts(): PreparedPkSelects {
  const db = getDb();
  let cached = stmtCache.get(db);
  if (cached) return cached;
  cached = {
    workspaceById: buildWorkspaceById(db),
    projectById: buildProjectById(db),
    taskById: buildTaskById(db),
    chatById: buildChatById(db),
    scheduleById: buildScheduleById(db),
    aiKeyById: buildAiKeyById(db),
  };
  stmtCache.set(db, cached);
  return cached;
}

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
  const row = getStmts().workspaceById.get({ id });
  return requireRow(row, "Workspace", id);
}

/**
 * Look up a project by id; throw `NotFoundError("Project", id)` if missing.
 */
export function getProjectOrThrow(id: number) {
  const row = getStmts().projectById.get({ id });
  return requireRow(row, "Project", id);
}

/**
 * Look up a task by id; throw `NotFoundError("Task", id)` if missing.
 */
export function getTaskOrThrow(id: number) {
  const row = getStmts().taskById.get({ id });
  return requireRow(row, "Task", id);
}

/**
 * Look up a chat by id; throw `NotFoundError("Chat", id)` if missing.
 */
export function getChatOrThrow(id: number) {
  const row = getStmts().chatById.get({ id });
  return requireRow(row, "Chat", id);
}

/**
 * Look up a schedule by id; throw `NotFoundError("Schedule", id)` if missing.
 */
export function getScheduleOrThrow(id: number) {
  const row = getStmts().scheduleById.get({ id });
  return requireRow(row, "Schedule", id);
}

/**
 * Look up an AI provider key by id; throw `NotFoundError("AI Key", id)` if missing.
 */
export function getAiKeyOrThrow(id: number) {
  const row = getStmts().aiKeyById.get({ id });
  return requireRow(row, "AI Key", id);
}

// ─── Non-throwing variants ───────────────────────────────────────────────
//
// Use these in service-layer code where "row absent" is a normal control-flow
// outcome (sync helpers, reconciliation passes, defensive guards). Routes
// should still prefer the `*OrThrow` versions so a missing parent surfaces
// as a 404 to the API client.
//
// The contract is intentionally narrow: `undefined | null` from
// `.get()` collapses to `null`. Callers do `if (!row) return;` and
// move on, instead of repeating the inline `db.select()...get()` form.

/** Look up a project by id; return `null` if missing. */
export function getProjectById(id: number) {
  return getStmts().projectById.get({ id }) ?? null;
}

/** Look up a workspace by id; return `null` if missing. */
export function getWorkspaceById(id: number) {
  return getStmts().workspaceById.get({ id }) ?? null;
}

/** Look up an AI provider key by id; return `null` if missing. */
export function getAiKeyById(id: number) {
  return getStmts().aiKeyById.get({ id }) ?? null;
}

/**
 * Look up a task by id; return `null` if missing. Mirrors the other
 * non-throwing PK lookup helpers. Hot path: task-executor / chat-
 * executor read the task row on every transition, so this routes
 * through the same prepared-statement cache as the other helpers.
 */
export function getTaskById(id: number) {
  return getStmts().taskById.get({ id }) ?? null;
}

