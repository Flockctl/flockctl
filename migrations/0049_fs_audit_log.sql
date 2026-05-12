-- Filesystem audit log: append-only forensic record of every project- /
-- workspace-scoped FS operation Flockctl exposes through the API.
--
-- v1 surface (this migration):
--   action='read'  — GET /projects/:id/fs/file?path=<rel>
--                    GET /workspaces/:id/fs/file?path=<rel>
--
-- Future slices add 'write' (slice 01), then 'delete' / 'rename' / 'mkdir'
-- (M01 slice 4). The action enum is intentionally narrow today; broadening
-- it requires both a CHECK-constraint amendment here AND a deliberate review
-- of what data may safely flow into the row.
--
-- Why a dedicated table rather than reusing git_audit_log:
--   - git_audit_log is keyed on git mutations (`pull`/`commit`/`push`); the
--     `action` enum and `args_json` shape are git-specific.
--   - File reads have no git equivalent; mixing them in would force the
--     CHECK constraint to widen and the per-action queries to filter.
--
-- Symmetric design with git_audit_log so operators can reason about the two
-- in the same mental model:
--   - INTEGER `created_at` (epoch ms, drizzle `timestamp_ms`).
--   - Both project_id and workspace_id columns; CHECK requires at least one
--     non-null at INSERT time. ON DELETE SET NULL on both FKs so a forensic
--     row outlives parent deletion (matches git_audit_log).
--   - `path` records the request-supplied relative path (UTF-8 string), not
--     the resolved absolute path — leaking absolute paths would expose
--     operator filesystem layout.
--   - `error_code` is one of the FsErrorCode values from
--     src/services/fs-operations.ts; NULL on success rows (`ok=1`).
--
-- Indexes are partial reverse-chronological compounds, one per scope, so
-- "what files did Flockctl touch in project X recently" / "in workspace Y
-- recently" runs index-only without a sort step.
--
-- Rollback: DROP TABLE fs_audit_log (the indexes drop with the table).

CREATE TABLE fs_audit_log (
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
    CHECK (action IN ('read')),
  CONSTRAINT fs_audit_log_ok_check
    CHECK (ok IN (0,1)),
  CONSTRAINT fs_audit_log_scope_check
    CHECK (project_id IS NOT NULL OR workspace_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX idx_fs_audit_log_project_ts
  ON fs_audit_log (project_id, ts DESC)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_fs_audit_log_workspace_ts
  ON fs_audit_log (workspace_id, ts DESC)
  WHERE workspace_id IS NOT NULL;
