-- Per-chat thinking / effort controls exposed in the composer toolbar.
--
-- `thinking_enabled` toggles adaptive extended thinking — default 1 matches
-- the prior behavior where the Claude Agent SDK auto-enables adaptive
-- thinking on models that support it. When 0, the SDK is called with
-- `thinking: { type: "disabled" }`, skipping the "think" step entirely.
--
-- `effort` picks the reasoning effort level (`low` | `medium` | `high` |
-- `max`). NULL means "use the hardcoded default" (`high`) — same as the
-- previous behavior — so existing chats upgrade seamlessly. The per-chat
-- value overrides the global default only when the user explicitly picks
-- one from the UI.
ALTER TABLE chats ADD COLUMN thinking_enabled INTEGER DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE chats ADD COLUMN effort TEXT;
