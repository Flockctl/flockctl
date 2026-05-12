-- Allow `show` as an additional value of `git_audit_log.action`.
--
-- Migrations 0046–0052 successively widened the action enum from the
-- original ('pull','commit','push') to include 'log', the branch ops,
-- 'diff', 'discard' and 'fetch'. This slice adds the `git show` surface
-- behind the new commit-detail tab — a read-only walk of one commit's
-- metadata + per-file status — through the same `runGitCommand`
-- envelope as the existing entries.
--
-- SQLite does NOT support `ALTER TABLE … DROP CONSTRAINT` or modifying a
-- CHECK in place — same recreate-and-rename dance as 0048 / 0050 / 0051 /
-- 0052: PRAGMA foreign_keys=OFF, recreate with wider CHECK, copy rows,
-- drop old, rename, recreate the two partial reverse-chronological
-- compound indexes, PRAGMA foreign_keys=ON.
--
-- Rollback: re-CREATE the table with the narrower CHECK and copy back —
-- but ONLY after confirming no row carries action='show'. Forensic data
-- is never silently dropped.

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
    CHECK (action IN (
      'pull','commit','push','log',
      'branch_list','checkout','branch_delete',
      'diff','discard','fetch','show'
    )),
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
