-- Add covering indexes on three foreign-key columns that the audit flagged
-- as missing. SQLite uses the leftmost column of an existing composite
-- index for FK constraint checks (DELETE CASCADE / SET NULL), so a
-- separate single-column index is only needed where no such composite
-- already covers the FK.
--
--  * usage_records.task_id          — no covering index. Hot lookup is
--                                     "all usage rows for task #X" used
--                                     by GET /tasks/:id (computes
--                                     cost_usd via SUM). Without an
--                                     index this scans the whole table.
--  * usage_records.chat_message_id  — same as above, used by chat-level
--                                     cost aggregations.
--  * usage_records.project_id       — used by GET /usage/summary?project_id=X
--                                     and the workspace-rollup query in
--                                     usage.ts. Existing
--                                     idx_usage_records_created /
--                                     _provider / _key don't cover it.
--  * incidents.created_by_chat_id   — used by GET /chats/:id/incidents.
--                                     idx_incidents_project covers
--                                     project lookups but not chat ones.
--
-- Note on `agent_questions`: the existing composites
--   idx_agent_questions_task_status (task_id, status)
--   idx_agent_questions_chat_status (chat_id, status)
-- already cover the FK constraint checks via the leftmost-column rule,
-- so no new indexes are needed there despite the audit flag.
--
-- All four use IF NOT EXISTS so the migration is idempotent — re-running
-- against a DB that already has the indexes (e.g. created by hand) is a
-- no-op rather than a hard error.
CREATE INDEX IF NOT EXISTS idx_usage_records_task ON usage_records (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_records_chat_message ON usage_records (chat_message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_records_project ON usage_records (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incidents_chat ON incidents (created_by_chat_id);
