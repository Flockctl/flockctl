-- Rate-limit pause-and-resume primitives for tasks and chats.
--
-- Why this migration: when an AI provider returns a rate-limit / usage-limit
-- error (Claude API 429 with retry-after, Claude Pro/Max weekly cap surfaced
-- through the CLI, Copilot premium-quota), the prior behavior was to flip the
-- task to FAILED (or, for chats, leave the user with a generic SSE error).
-- Both modes lose the in-flight session and require manual user retry. With
-- `claude_session_id` already persisted on both tables, the only thing missing
-- was a way to (a) park the row in a non-terminal state and (b) remember when
-- to wake it up. That's what these two columns do.
--
-- `resume_at` semantics:
--   - INTEGER unix-epoch milliseconds (NOT seconds — sub-second precision keeps
--     the daemon's wake-up scheduler aligned with the headers Anthropic emits in
--     `retry-after-ms`).
--   - NULL on every other status — populated only while status='rate_limited'.
--   - Cleared back to NULL on resume / cancel, so a stale value never leaks
--     into the next run.
--
-- Tasks side:
--   `tasks.status` is application-enforced (no DB CHECK exists yet — see
--   `validateTaskTransition` in src/lib/types.ts), so adding a new value here
--   is a no-op at the schema level. The new `resume_at` column rides alongside
--   it. No backfill needed: existing rows default to NULL.
--
-- Chats side:
--   Chats have NEVER had a status column. The "waiting" state is derived from
--   `EXISTS(agent_questions WHERE chat_id=? AND status='pending')`. We're
--   adding `status` as the first explicit per-chat lifecycle field, defaulting
--   to 'idle' so existing rows are byte-equivalent to today. Allowed values:
--     'idle'         — no live session
--     'running'      — session currently mid-turn (informational; not yet
--                      consumed by the in-memory chatExecutor.isRunning path)
--     'rate_limited' — paused awaiting `resume_at`
--   No CHECK constraint here either, mirroring the loose convention on
--   `tasks.status`. Future tightening (slice-level) can add CHECKs once the
--   surrounding code is hardened against malformed values.
--
-- Indexes:
--   `idx_tasks_resume_at` and `idx_chats_resume_at` are partial indexes
--   covering ONLY rows with a non-NULL resume_at — the bootstrap recovery
--   query (`SELECT id, resume_at FROM tasks WHERE status='rate_limited'`)
--   reads them at every daemon start, and the partial index keeps the index
--   size bounded by the count of currently-paused rows rather than the full
--   table.
--
-- Rollback: DROP INDEX idx_chats_resume_at; ALTER TABLE chats DROP COLUMN
-- resume_at; ALTER TABLE chats DROP COLUMN status; DROP INDEX
-- idx_tasks_resume_at; ALTER TABLE tasks DROP COLUMN resume_at; — the new
-- TaskStatus value disappears with code revert (no DB CHECK to drop).

ALTER TABLE tasks ADD COLUMN resume_at INTEGER;
--> statement-breakpoint
CREATE INDEX idx_tasks_resume_at ON tasks (resume_at) WHERE resume_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE chats ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
--> statement-breakpoint
ALTER TABLE chats ADD COLUMN resume_at INTEGER;
--> statement-breakpoint
CREATE INDEX idx_chats_resume_at ON chats (resume_at) WHERE resume_at IS NOT NULL;
