-- Add partial indexes flagged by the code-optimizer audit.
--
-- All four are heavily skewed to NULL on real workloads, so partial indexes
-- (`WHERE col IS NOT NULL`) keep them tiny while the planner still picks
-- them up for the filtered queries we care about. IF NOT EXISTS makes the
-- migration idempotent against a DB that already has the indexes from a
-- hand-applied fix.
--
--  * tasks.parent_task_id      — used by GET /tasks?parent_task_id=… and
--                                three stats aggregates in routes/tasks/crud.ts
--                                (failedRerunAgg, supersededFailuresAgg,
--                                buildAfterRerunAgg) that scan the whole
--                                tasks table today.
--  * tasks.assigned_key_id     — used by /metrics/overview filtered by
--                                ai_provider_key_id, plus the FK SET NULL
--                                cascade fired by DELETE on aiProviderKeys.
--  * tasks.label               — used by GET /tasks?label=… (leading-wildcard
--                                LIKE is unhelpful, but prefix-LIKE + this
--                                index turns the schedules-by-template
--                                lookup in routes/schedules.ts from a full
--                                scan into an index range scan).
--  * schedules.assigned_key_id — used by /metrics/overview key-scope filter
--                                and the FK SET NULL cascade when an AI key
--                                is removed.
--
-- Why partial (WHERE col IS NOT NULL): in a typical workload >90% of tasks
-- have no parent, no assigned key, and no label. A full index would carry
-- that NULL bulk for zero query benefit (the planner skips NULL rows for
-- equality / prefix-LIKE filters anyway). The partial form keeps the index
-- bounded by the active sub-population.
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_key
  ON tasks (assigned_key_id)
  WHERE assigned_key_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_label
  ON tasks (label)
  WHERE label IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_schedules_assigned_key
  ON schedules (assigned_key_id)
  WHERE assigned_key_id IS NOT NULL;
