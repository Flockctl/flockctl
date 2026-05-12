-- Allow 'write' as an additional value of `fs_audit_log.action`, and add the
-- three columns the new `PUT /:id/fs/file` endpoint needs to record:
--   - sha_before — sha-256 of the on-disk content the writer overwrote;
--                  NULL when the file did not exist (allowCreate path).
--   - sha_after  — sha-256 of the bytes that ended up on disk after rename;
--                  NULL on failure rows where no rename occurred.
--   - bytes      — number of bytes the caller posted (Buffer.byteLength,
--                  utf-8). Recorded even on failure rows so the audit table
--                  exposes "the user TRIED to write 12 MiB" cases instead
--                  of just "ok=0 fs_too_large" with no payload size.
--
-- Columns are nullable because:
--   - On a fresh-create write (allowCreate=true) `sha_before` is NULL.
--   - On any failure (sha conflict, oversize, EPERM) `sha_after` is NULL —
--     no rename happened, so there is no canonical post-state to record.
--   - Pre-existing 'read' rows from migration 0049/0055 carry NULL for all
--     three columns; the in-place ALTER TABLE … ADD COLUMN suffices for
--     the new columns, but the CHECK widening still requires the standard
--     SQLite rebuild dance.
--
-- Rollback: re-CREATE with the narrower CHECK and copy back, but only after
-- confirming no row uses the 'write' action. Forensic data is never silently
-- dropped (matches the rollback contract of 0048 / 0055).
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
  sha_before TEXT,
  sha_after TEXT,
  bytes INTEGER,
  CONSTRAINT fs_audit_log_entity_type_check
    CHECK (entity_type IN ('project','workspace')),
  CONSTRAINT fs_audit_log_action_check
    CHECK (action IN ('read','write','mkdir','create','rename','delete')),
  CONSTRAINT fs_audit_log_ok_check
    CHECK (ok IN (0,1)),
  CONSTRAINT fs_audit_log_scope_check
    CHECK (project_id IS NOT NULL OR workspace_id IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO fs_audit_log_new (id, entity_type, entity_id, project_id, workspace_id,
                              action, path, ok, error_code, ts,
                              sha_before, sha_after, bytes)
  SELECT id, entity_type, entity_id, project_id, workspace_id,
         action, path, ok, error_code, ts,
         NULL, NULL, NULL
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
