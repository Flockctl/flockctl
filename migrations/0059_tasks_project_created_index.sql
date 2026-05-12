-- Composite index for the dominant tasks-list query path:
--   SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT N
-- (see `src/routes/tasks/crud.ts` `registerTaskList` and the analytics
-- breakdowns under `routes/metrics.ts`).
--
-- Existing indexes on tasks:
--   - idx_tasks_project_status      (project_id, status)
--   - idx_tasks_status_created      (status, created_at)
-- Neither covers the bare-list query — `idx_tasks_project_status` carries
-- the project_id leftmost but its second column is `status`, so an ORDER BY
-- created_at falls back to a sort. `idx_tasks_status_created` is keyed on
-- status, so a `WHERE project_id = ?` scan would have to walk the whole
-- index. The new composite below indexes (project_id ASC, created_at DESC)
-- so the planner can serve the list in one indexed walk with no sort.
--
-- Idempotent (`IF NOT EXISTS`) — re-running against a DB that already
-- has the index is a no-op.
CREATE INDEX IF NOT EXISTS idx_tasks_project_created_desc
  ON tasks (project_id, created_at DESC);
