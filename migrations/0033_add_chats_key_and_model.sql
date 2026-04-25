-- Persist the user's AI provider key + model selection per chat so the UI
-- can restore them on reload instead of re-resolving from globals every time.
-- `ai_provider_key_id` doubles as the provider marker: each row in
-- `ai_provider_keys` carries a `provider` string, so the chat's provider is
-- derived by join — no separate column is needed, and the two can never
-- drift out of sync. `ON DELETE SET NULL` mirrors the pattern used by
-- `usage_records.ai_provider_key_id` so deleting a key leaves chats intact
-- (they'll fall back to the global default key on the next turn).
ALTER TABLE chats ADD COLUMN ai_provider_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE chats ADD COLUMN model TEXT;
