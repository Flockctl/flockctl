-- Allow 'mkdir', 'create', 'rename', 'delete' as additional values of
-- `fs_audit_log.action`.
--
-- Migration 0049 pinned the action enum at ('read') via a CHECK constraint.
-- The new POST /:id/fs/op endpoint surfaces four FS-mutation verbs that need
-- their own audit rows for forensic parity with the read path:
--   - mkdir   — create directory
--   - create  — create file (atomic temp+rename write)
--   - rename  — rename / move file or directory inside the entity root
--   - delete  — remove file or (optionally recursive) directory
--
-- SQLite cannot ALTER a CHECK constraint in place, so this migration uses the
-- standard rebuild dance from 0048_git_audit_log_log_action.sql:
--   1. PRAGMA foreign_keys=OFF so SET-NULL FKs don't cascade-null while we
--      copy the rows.
--   2. CREATE TABLE fs_audit_log_new with the wider CHECK.
--   3. INSERT … SELECT to copy existing rows verbatim.
--   4. DROP the old table (drops its indexes implicitly).
--   5. RENAME the new table into place.
--   6. Recreate the partial reverse-chronological compound indexes from 0049.
--   7. PRAGMA foreign_keys=ON to restore enforcement.
--
-- Rollback: re-CREATE the table with the narrower CHECK and copy back, but
-- ONLY after confirming no row uses one of the new actions. Forensic data is
-- never silently dropped.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE fs_audit_log_new (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_code TEXT,
  ts INTEGER NOT NULL,
  CONSTRAINT fs_audit_log_entity_type_check
    CHECK (entity_type IN ('project','workspace')),
  CONSTRAINT fs_audit_log_action_check
    CHECK (action IN ('read','mkdir','create','rename','delete')),
  CONSTRAINT fs_audit_log_ok_check
    CHECK (ok IN (0,1)),
  CONSTRAINT fs_audit_log_scope_check
    CHECK (project_id IS NOT NULL OR workspace_id IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO fs_audit_log_new
  SELECT id, entity_type, entity_id, project_id, workspace_id,
         action, path, ok, error_code, ts
    FROM fs_audit_log;
--> statement-breakpoint
DROP TABLE fs_audit_log;
--> statement-breakpoint
ALTER TABLE fs_audit_log_new RENAME TO fs_audit_log;
--> statement-breakpoint
CREATE INDEX idx_fs_audit_log_project_ts
  ON fs_audit_log (project_id, ts DESC)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_fs_audit_log_workspace_ts
  ON fs_audit_log (workspace_id, ts DESC)
  WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
