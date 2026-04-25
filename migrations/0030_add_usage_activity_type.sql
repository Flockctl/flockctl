-- Adds `activity_type` to usage_records so standalone LLM activities (not
-- attached to a task or a chat message) can be tagged in cost reports.
-- Current taggable activities: 'incident_extract' (LLM extracts structured
-- incident fields from a chat transcript). Legacy rows remain NULL, which
-- callers interpret as the original task/chat-attributed usage.
ALTER TABLE usage_records ADD COLUMN activity_type TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_records_activity_type
  ON usage_records (activity_type) WHERE activity_type IS NOT NULL;
