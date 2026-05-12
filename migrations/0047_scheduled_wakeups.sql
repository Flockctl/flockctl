-- Scheduled wakeups: persist intent-to-resume signalled by an in-session
-- agent (typically Claude Code's `ScheduleWakeup` tool) so a daemon-side
-- worker can fire it at `fire_at`, even when no `/loop` dispatcher is
-- attached to the originating session.
--
-- Why this table is separate from `schedules`:
--   - `schedules` is template-triggered cron (recurring, "fire forever
--     until cancelled"); a wakeup is one-shot, scoped to a single live
--     chat / task, and dies as soon as it fires (or is cancelled, or
--     misses its window).
--   - `schedules` has no concept of "missed" — a cron either fires on
--     time or the next tick is the next opportunity. A wakeup whose
--     window slipped (daemon was down, OS asleep, OOM-killed worker)
--     MUST be visible to the operator as a `missed` row so the chat
--     never disappears into "looks idle".
--
-- Scope (chat_id XOR task_id):
--   A wakeup belongs to exactly one running session. The CHECK constraint
--   asserts at-least-one is set; service-layer code asserts exactly-one
--   so a row scoped to BOTH is rejected at INSERT time (the DB allows
--   it, but it's nonsensical and would double-fire on resume).
--
-- Cascade behavior:
--   - chat_id / task_id use ON DELETE CASCADE: when the owning session is
--     deleted, the wakeup is no longer meaningful — there is nothing to
--     resume into. Dropping the row also stops the worker from firing
--     against a dangling claude_session_id.
--
-- Status enum (CHECK-constrained):
--   - pending   — created, fire_at in the future (or just-due, awaiting
--                 the next worker tick).
--   - fired     — worker invoked the resume callback; `fired_at` set.
--   - cancelled — operator clicked Cancel, or the session ended cleanly
--                 before the timer fired.
--   - missed    — worker recovered after a downtime that exceeded the
--                 fire_at + grace_period window. The row is preserved
--                 (NOT auto-fired) so the operator sees the missed wake
--                 in the inbox and decides whether to dismiss or resume
--                 manually. This is the "we don't lose chats" guarantee.
--
-- Indexes:
--   - `idx_scheduled_wakeups_pending` is the worker hot path: every tick
--     SELECTs pending rows with fire_at <= now() ORDER BY fire_at ASC,
--     so a partial index on `fire_at WHERE status='pending'` is exactly
--     the right shape — fired/cancelled/missed rows are excluded from
--     the index entirely, keeping the worker scan O(due-pending) not
--     O(table-size).
--   - Per-scope reverse-chronological indexes (chat / task) cover the
--     UI inbox view "show me wakeups for this chat, newest first".
--
-- Rollback: DROP TABLE scheduled_wakeups (indexes drop with the table).

CREATE TABLE scheduled_wakeups (
  id TEXT PRIMARY KEY,
  chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  claude_session_id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  fired_at INTEGER,
  missed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT scheduled_wakeups_status_check
    CHECK (status IN ('pending','fired','cancelled','missed')),
  CONSTRAINT scheduled_wakeups_scope_check
    CHECK (chat_id IS NOT NULL OR task_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX idx_scheduled_wakeups_pending
  ON scheduled_wakeups (fire_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX idx_scheduled_wakeups_chat
  ON scheduled_wakeups (chat_id, created_at DESC)
  WHERE chat_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_scheduled_wakeups_task
  ON scheduled_wakeups (task_id, created_at DESC)
  WHERE task_id IS NOT NULL;
