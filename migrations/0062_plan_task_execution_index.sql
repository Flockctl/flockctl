-- Add an inverse-index table that maps execution_task_id → plan-task location.
--
-- Background
-- ----------
-- The plan store is FS-backed (markdown files under
-- `<project>/.flockctl/plan/<milestone>/<slice>/<task>.md`). Looking up
-- "which plan task points at execution task #N" used to require a full
-- four-level walk:
--
--   foreach project in DB
--     foreach milestone in <project>/.flockctl/plan/
--       foreach slice in <project>/.flockctl/plan/<milestone>/
--         foreach task in <project>/.flockctl/plan/<milestone>/<slice>/
--           if task.execution_task_id === N → return location
--
-- This is `O(P × M × S × T)` with one `readdirSync` + YAML parse per node.
-- It fires on every terminal task transition (`auto-executor.ts` →
-- `findPlanTaskByExecutionId`) — the hottest FS walk in the daemon.
-- An in-memory cache mitigates the steady state but stale-cache + bulk
-- task completion still triggers tens of thousands of disk reads.
--
-- This table is the SQLite-side inverse index. Plan-store mutations
-- (`updatePlanTask`, `deletePlanTask`, plus the slice / milestone
-- delete cascade) write the mapping; the resolver queries it by
-- `execution_task_id` PK in O(1).
--
-- The table is intentionally not FK-referenced to anything. The `execution_task_id`
-- is a soft pointer at a row in `tasks` (which may be deleted via cascade) —
-- entries are purged via the plan-store mutation path, not via DB cascade.
-- The plan store and the index can drift in pathological cases (out-of-process
-- writers to the markdown files); when that happens the auto-executor's
-- existing fallback FS walk + cache rebuild closes the loop, so drift is
-- self-healing.
--
-- Rollback: DROP TABLE plan_task_execution_index;
CREATE TABLE IF NOT EXISTS plan_task_execution_index (
  execution_task_id INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL,
  milestone_slug    TEXT NOT NULL,
  slice_slug        TEXT NOT NULL,
  task_slug         TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
-- Index on project_id so per-project sweeps (e.g. on project delete) can
-- clear all entries without scanning the whole index.
CREATE INDEX IF NOT EXISTS idx_plan_task_exec_index_project
  ON plan_task_execution_index (project_id);
