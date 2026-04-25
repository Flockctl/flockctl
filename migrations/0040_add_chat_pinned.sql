-- Per-chat pin toggle exposed in the chat list sidebar.
--
-- `pinned` sticks a chat to the top of `GET /chats` regardless of which
-- filters (project_id, workspace_id, entity_type, entity_id) are active —
-- the handler orders by `(pinned DESC, created_at DESC)` so pinned rows
-- that match the filter float above the unpinned ones and unpinned rows
-- keep their existing newest-first order underneath. Default 0 so every
-- existing chat upgrades as "unpinned" without any backfill.
ALTER TABLE chats ADD COLUMN pinned INTEGER DEFAULT 0 NOT NULL;
