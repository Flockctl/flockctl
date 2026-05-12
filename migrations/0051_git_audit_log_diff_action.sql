-- Allow `diff` as an additional value of `git_audit_log.action`.
--
-- Migration 0046 originally pinned the action enum at
-- ('pull','commit','push'); 0048 widened it to add 'log'; 0050 added the
-- three branch-management ops ('branch_list','checkout','branch_delete').
-- This slice adds the read-only `git diff` browser, which writes a forensic
-- row through the same `runGitCommand` envelope every other git surface
-- already uses.
--
-- SQLite does NOT support `ALTER TABLE … DROP CONSTRAINT` or modifying a
-- CHECK in place — the only way to widen the enum is the standard
-- recreate-and-rename dance, identical in shape to migrations 0048 / 0050:
--   1. PRAGMA foreign_keys=OFF so the SET-NULL FKs (project_id /
--      workspace_id) on the old table don't cascade-null while we copy.
--   2. CREATE TABLE git_audit_log_new with the wider CHECK.
--   3. INSERT … SELECT to copy existing rows verbatim.
--   4. DROP the old table (drops its indexes implicitly).
--   5. RENAME the new table into place.
--   6. Recreate the two partial reverse-chronological compound indexes
--      that 0046 established — same names, same shape, same WHERE clauses.
--   7. PRAGMA foreign_keys=ON to restore enforcement.
--
-- Rollback: re-CREATE the table with the narrower CHECK and copy back —
-- but ONLY after confirming no row has `action='diff'`. Forensic data is
-- never silently dropped.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE git_audit_log_new (
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
    CHECK (action IN ('pull','commit','push','log','branch_list','checkout','branch_delete','diff')),
  CONSTRAINT git_audit_log_scope_check
    CHECK (project_id IS NOT NULL OR workspace_id IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO git_audit_log_new
  SELECT id, project_id, workspace_id, action, args_json, exit_code,
         reason, stderr_truncated, duration_ms, created_at
    FROM git_audit_log;
--> statement-breakpoint
DROP TABLE git_audit_log;
--> statement-breakpoint
ALTER TABLE git_audit_log_new RENAME TO git_audit_log;
--> statement-breakpoint
CREATE INDEX idx_git_audit_log_project_created
  ON git_audit_log (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_git_audit_log_workspace_created
  ON git_audit_log (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
