-- Add covering index for the only hot-path lookup against `task_logs`:
-- `GET /tasks/:id/logs`, which does
--   SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp
-- Without an index this seq-scans the entire table on every request
-- and re-sorts the result; with the composite index below SQLite walks
-- straight to the matching rows in already-ordered form. The same
-- index also covers the FK constraint check fired by
-- `DELETE FROM tasks WHERE id = ?` (CASCADE → task_logs.task_id).
--
-- Idempotent (`IF NOT EXISTS`) so re-running against a DB that already
-- has the index is a no-op rather than a hard error.
CREATE INDEX IF NOT EXISTS idx_task_logs_task_timestamp
  ON task_logs (task_id, timestamp);
