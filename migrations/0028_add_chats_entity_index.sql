-- Speeds up entity-aware chat lookups used by the fetch-or-create flow.
-- `GET /chats?project_id=…&entity_type=…&entity_id=…` and the idempotent
-- `POST /chats` path both scan on this exact triple, so a composite index
-- in (project_id, entity_type, entity_id) order turns the lookup from a
-- full chats scan into an O(log n) probe. IF NOT EXISTS keeps the migration
-- safe to re-run on DBs that already had the index hand-created.
CREATE INDEX IF NOT EXISTS idx_chats_entity ON chats (project_id, entity_type, entity_id);
