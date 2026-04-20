-- Drop merge queue feature: remove table and index.
DROP INDEX IF EXISTS idx_merge_queue_project_status;
--> statement-breakpoint
DROP TABLE IF EXISTS merge_queue_entries;
