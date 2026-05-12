-- Git audit log: append-only forensic record of every git mutation
-- Flockctl performs (`pull` | `commit` | `push`).
--
-- Why a new table rather than reusing usage_records or mission_events:
--   - usage_records is LLM-cost-keyed; git operations carry no token cost.
--   - mission_events cascades on mission delete (history travels with the
--     mission), but a forensic record of git mutations must SURVIVE
--     project / workspace deletion so the trail is never lost simply
--     because the owning row was removed.
--
-- FK cascade behavior — both project_id and workspace_id use ON DELETE
-- SET NULL. That intentionally orphans the audit row instead of deleting
-- it; the CHECK constraint applies at INSERT/UPDATE time only (SQLite
-- does not re-evaluate CHECK on cascaded NULLs), which is the desired
-- behavior. Code MUST never create a row scoped to neither project nor
-- workspace.
--
-- Sensitive-data invariant (asserted by the slice's security test):
--   - args_json records summaries of opts (paths count, force flag,
--     remote name, commit_message_bytes) — NEVER the commit message
--     body, file contents, or credential-bearing URLs.
--   - stderr_truncated is bounded to ≤ 4096 bytes by the writer.
--   - exit_code is NULL when the operation never reached `git` (path
--     missing, not_a_repo) — distinguishable from 0 (success).
--
-- created_at is INTEGER ms (drizzle `timestamp_ms`) rather than the
-- project-wide TEXT `datetime('now')`. Forensic queries frequently
-- filter by sub-second windows (pull-then-push happens in ~50ms), and
-- the JS-side `$defaultFn(() => new Date())` does NOT emit a SQL
-- DEFAULT clause — the NOT NULL constraint forces every insert path
-- to populate the column explicitly, so a missed write fails fast.
--
-- Indexes are partial reverse-chronological compounds, one per scope.
-- Each index is bounded by its live scoped population — a row scoped
-- only to a workspace is NOT carried in the project index, and vice
-- versa. SQLite supports DESC in index column lists; the optimizer
-- uses it for ORDER BY created_at DESC + LIMIT without a sort step.
--
-- Rollback: DROP TABLE git_audit_log (the indexes drop with the table).

CREATE TABLE git_audit_log (
  id TEXT PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  args_json TEXT NOT NULL,
  exit_code INTEGER,
  reason TEXT,
  stderr_truncated TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT git_audit_log_action_check
    CHECK (action IN ('pull','commit','push')),
  CONSTRAINT git_audit_log_scope_check
    CHECK (project_id IS NOT NULL OR workspace_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX idx_git_audit_log_project_created
  ON git_audit_log (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_git_audit_log_workspace_created
  ON git_audit_log (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
