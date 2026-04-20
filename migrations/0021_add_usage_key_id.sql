-- Persist which AI provider key produced each usage record so analytics can
-- filter directly instead of reconstructing the link via tasks/chats.
ALTER TABLE usage_records ADD COLUMN ai_provider_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX idx_usage_records_key ON usage_records(ai_provider_key_id);
