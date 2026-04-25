-- Move templates from DB to filesystem (global/workspace/project scopes) and
-- rework `schedules` to reference templates by (scope, name, optional
-- workspaceId/projectId) instead of a FK to `task_templates.id`. Also moves
-- `assigned_key_id` off the (now-gone) template onto the schedule so one
-- template can be reused with different AI keys.
--
-- This is a **hard breaking change**:
--   - All rows in `task_templates` are discarded.
--   - All rows in `schedules` are discarded (they reference dead templates).
--
-- Templates now live on disk — see `src/services/templates.ts`:
--   ~/flockctl/templates/<name>.json                        — global
--   <workspace>/.flockctl/templates/<name>.json             — workspace
--   <project>/.flockctl/templates/<name>.json               — project

DROP TABLE IF EXISTS schedules;--> statement-breakpoint
DROP TABLE IF EXISTS task_templates;--> statement-breakpoint

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_scope TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  template_project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  assigned_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL,
  schedule_type TEXT NOT NULL,
  cron_expression TEXT,
  run_at TEXT,
  timezone TEXT DEFAULT 'UTC',
  status TEXT DEFAULT 'active',
  last_fire_time TEXT,
  next_fire_time TEXT,
  misfire_grace_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  CONSTRAINT schedules_template_scope_check CHECK (template_scope IN ('global','workspace','project')),
  CONSTRAINT schedules_template_ids_check CHECK (
    (template_scope = 'global'    AND template_workspace_id IS NULL     AND template_project_id IS NULL)
 OR (template_scope = 'workspace' AND template_workspace_id IS NOT NULL AND template_project_id IS NULL)
 OR (template_scope = 'project'   AND template_project_id   IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX idx_schedules_template ON schedules (template_scope, template_name);
