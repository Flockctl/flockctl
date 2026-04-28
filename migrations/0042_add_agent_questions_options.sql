-- Multiple-choice support for agent_questions.
--
-- Background: 0029 introduced agent_questions as a free-form prompt — a single
-- `question` string the user typed an answer to. The Claude Code harness's
-- `AskUserQuestion` tool, however, can also surface a multiple-choice prompt
-- with a short chip header and a list of `{ label, description?, preview? }`
-- options, optionally multi-select. Today we collapse those into the same
-- free-form row and lose the option metadata before it ever reaches the UI.
--
-- Three additive columns capture the missing shape:
--
--   * `options` — JSON-serialized array of option objects. NULL preserves the
--     original free-form behavior (no backfill needed).
--   * `multi_select` — boolean (0/1) for whether the user can pick more than
--     one option. Default 0 so existing rows and free-form callers stay valid.
--   * `header` — short chip label (≤ 12 chars per harness convention) rendered
--     above the option list. NULL when absent (free-form prompts).
--
-- Strictly additive: no DROP, no ALTER, no row rewrite. Existing pending and
-- answered questions remain valid because every new column is nullable or has
-- a default, and the existing CHECK constraints (`status_check`, `target_check`)
-- are unaffected.
ALTER TABLE agent_questions ADD COLUMN options TEXT;
--> statement-breakpoint
ALTER TABLE agent_questions ADD COLUMN multi_select INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE agent_questions ADD COLUMN header TEXT;
