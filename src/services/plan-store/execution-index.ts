// ─── Plan-task → execution-task SQLite inverse index ───
//
// The plan store lives on disk as markdown files. Finding "the plan task
// that points at execution task #N" used to do a full FS walk
// (`auto-executor.ts:findPlanTaskByExecutionId`), which scales as
// O(P × M × S × T) with one `readdirSync` + YAML parse per node. The walk
// fires on every terminal task transition.
//
// This module mirrors the (execution_task_id → plan-task location) mapping
// into SQLite via the `plan_task_execution_index` table created in
// migration 0062. Plan-store mutation paths
// (`createPlanTask` / `updatePlanTask` / `deletePlanTask`) write the
// mapping; the auto-executor resolver queries it by primary key in O(1).
//
// The index is not FK-bound — `execution_task_id` is a soft pointer; the
// plan-store can outlive (or be deleted out-of-band from) the tasks row.
// Drift is self-healing: a stale index entry returns a location whose
// `.md` file doesn't exist on disk, the plan-store helpers return null,
// the resolver falls back to the FS walk, finds the right location (or
// confirms truly-missing), and the new walk's `setPlanTaskExecutionIndex`
// call repairs the index.

import type Database from "better-sqlite3";
import { getRawDb } from "../../db/index.js";

export interface PlanTaskExecutionIndexEntry {
  projectId: number;
  milestoneSlug: string;
  sliceSlug: string;
  taskSlug: string;
}

// Per-handle prepared-statement cache. Mirrors the WeakMap pattern proven
// in `supervisor.ts:69`, `wakeup-service.ts`, `heartbeat.ts`. Keyed on the
// Database handle so test DB swaps reset the cache cleanly.
interface IndexStmts {
  upsert: Database.Statement;
  getByExecId: Database.Statement;
  deleteByExecId: Database.Statement;
  deleteByLocation: Database.Statement;
  deleteAllForSlice: Database.Statement;
  deleteAllForMilestone: Database.Statement;
  deleteAllForProject: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, IndexStmts>();

function getStmts(sqlite: Database.Database): IndexStmts {
  let cached = stmtCache.get(sqlite);
  if (cached) return cached;
  cached = {
    upsert: sqlite.prepare(`
      INSERT INTO plan_task_execution_index
        (execution_task_id, project_id, milestone_slug, slice_slug, task_slug, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(execution_task_id) DO UPDATE SET
        project_id = excluded.project_id,
        milestone_slug = excluded.milestone_slug,
        slice_slug = excluded.slice_slug,
        task_slug = excluded.task_slug,
        updated_at = datetime('now')
    `),
    getByExecId: sqlite.prepare(`
      SELECT project_id AS projectId,
             milestone_slug AS milestoneSlug,
             slice_slug AS sliceSlug,
             task_slug AS taskSlug
      FROM plan_task_execution_index
      WHERE execution_task_id = ?
    `),
    deleteByExecId: sqlite.prepare(
      `DELETE FROM plan_task_execution_index WHERE execution_task_id = ?`,
    ),
    deleteByLocation: sqlite.prepare(`
      DELETE FROM plan_task_execution_index
      WHERE project_id = ? AND milestone_slug = ? AND slice_slug = ? AND task_slug = ?
    `),
    deleteAllForSlice: sqlite.prepare(`
      DELETE FROM plan_task_execution_index
      WHERE project_id = ? AND milestone_slug = ? AND slice_slug = ?
    `),
    deleteAllForMilestone: sqlite.prepare(`
      DELETE FROM plan_task_execution_index
      WHERE project_id = ? AND milestone_slug = ?
    `),
    deleteAllForProject: sqlite.prepare(
      `DELETE FROM plan_task_execution_index WHERE project_id = ?`,
    ),
  };
  stmtCache.set(sqlite, cached);
  return cached;
}

/** Upsert the mapping for one execution-task-id → plan-task location. */
export function setPlanTaskExecutionIndex(
  executionTaskId: number,
  entry: PlanTaskExecutionIndexEntry,
): void {
  const sqlite = getRawDb();
  getStmts(sqlite).upsert.run(
    executionTaskId,
    entry.projectId,
    entry.milestoneSlug,
    entry.sliceSlug,
    entry.taskSlug,
  );
}

/** Read the location for an execution task id, or `null` if not indexed. */
export function getPlanTaskExecutionIndex(
  executionTaskId: number,
): PlanTaskExecutionIndexEntry | null {
  const sqlite = getRawDb();
  const row = getStmts(sqlite).getByExecId.get(executionTaskId) as
    | PlanTaskExecutionIndexEntry
    | undefined;
  return row ?? null;
}

/** Remove a single mapping by exec task id (idempotent). */
export function deletePlanTaskExecutionIndex(executionTaskId: number): void {
  const sqlite = getRawDb();
  getStmts(sqlite).deleteByExecId.run(executionTaskId);
}

/** Remove any mapping pointing at the given (project, milestone, slice,
 *  task) location. Used by `updatePlanTask` when the execution task id is
 *  cleared / repointed — there may be at most one row, but use
 *  delete-by-location to be safe across pathological double-write states. */
export function deletePlanTaskExecutionIndexByLocation(
  projectId: number,
  milestoneSlug: string,
  sliceSlug: string,
  taskSlug: string,
): void {
  const sqlite = getRawDb();
  getStmts(sqlite).deleteByLocation.run(projectId, milestoneSlug, sliceSlug, taskSlug);
}

/** Clear all mappings under a slice (called by slice delete / repoint). */
export function deletePlanTaskExecutionIndexForSlice(
  projectId: number,
  milestoneSlug: string,
  sliceSlug: string,
): void {
  const sqlite = getRawDb();
  getStmts(sqlite).deleteAllForSlice.run(projectId, milestoneSlug, sliceSlug);
}

/** Clear all mappings under a milestone. */
export function deletePlanTaskExecutionIndexForMilestone(
  projectId: number,
  milestoneSlug: string,
): void {
  const sqlite = getRawDb();
  getStmts(sqlite).deleteAllForMilestone.run(projectId, milestoneSlug);
}

/** Clear every mapping for a project (used by project delete + index
 *  rebuild). */
export function deletePlanTaskExecutionIndexForProject(projectId: number): void {
  const sqlite = getRawDb();
  getStmts(sqlite).deleteAllForProject.run(projectId);
}
