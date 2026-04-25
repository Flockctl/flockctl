import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { FlockctlDb } from "../db/index.js";
import {
  createTemplate as createTemplateFile,
  type TemplateScope,
  type TemplateInput,
} from "../services/templates.js";

/**
 * Create an in-memory test database with all tables matching the Drizzle schema.
 */
export function createTestDb(): {
  sqlite: BetterSqlite3Database;
  db: FlockctlDb;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  // DDL matching src/db/schema.ts exactly
  sqlite.exec(`
    CREATE TABLE ai_provider_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      label TEXT,
      key_value TEXT,
      cli_command TEXT,
      env_var_name TEXT,
      config_dir TEXT,
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      last_error TEXT,
      last_error_at TEXT,
      consecutive_errors INTEGER DEFAULT 0,
      disabled_until TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      path TEXT NOT NULL UNIQUE,
      repo_url TEXT,
      allowed_key_ids TEXT,
      gitignore_flockctl INTEGER DEFAULT 0 NOT NULL,
      gitignore_todo INTEGER DEFAULT 0 NOT NULL,
      gitignore_agents_md INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      path TEXT,
      repo_url TEXT,
      required_providers TEXT,
      provider_fallback_chain TEXT,
      backoff_config TEXT,
      allowed_key_ids TEXT,
      denied_key_ids TEXT,
      gitignore_flockctl INTEGER DEFAULT 0 NOT NULL,
      gitignore_todo INTEGER DEFAULT 0 NOT NULL,
      gitignore_agents_md INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      vision TEXT,
      success_criteria TEXT,
      depends_on TEXT,
      order_index INTEGER DEFAULT 0,
      key_risks TEXT,
      proof_strategy TEXT,
      boundary_map_markdown TEXT,
      verification_contract TEXT,
      verification_integration TEXT,
      verification_operational TEXT,
      verification_uat TEXT,
      definition_of_done TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE plan_slices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id INTEGER REFERENCES milestones(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      risk TEXT,
      depends TEXT,
      demo TEXT,
      goal TEXT,
      success_criteria TEXT,
      order_index INTEGER DEFAULT 0,
      proof_level TEXT,
      integration_closure TEXT,
      observability_impact TEXT,
      threat_surface TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slice_id INTEGER REFERENCES plan_slices(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      model TEXT,
      status TEXT DEFAULT 'pending',
      estimate TEXT,
      files TEXT,
      verify TEXT,
      depends TEXT,
      inputs TEXT,
      expected_output TEXT,
      task_id INTEGER,
      order_index INTEGER DEFAULT 0,
      output TEXT,
      summary TEXT,
      verification_passed INTEGER,
      verification_output TEXT,
      failure_modes TEXT,
      negative_tests TEXT,
      observability_impact TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      prompt TEXT,
      prompt_file TEXT,
      agent TEXT,
      model TEXT,
      image TEXT,
      command TEXT,
      working_dir TEXT,
      env_vars TEXT,
      status TEXT DEFAULT 'queued',
      task_type TEXT DEFAULT 'execution',
      target_slice_slug TEXT,
      label TEXT,
      assigned_key_id INTEGER,
      allowed_key_ids TEXT,
      failed_key_ids TEXT,
      timeout_seconds INTEGER,
      max_retries INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      parent_task_id INTEGER,
      exit_code INTEGER,
      error_message TEXT,
      git_commit_before TEXT,
      git_commit_after TEXT,
      git_diff_summary TEXT,
      requires_approval INTEGER DEFAULT 0,
      approval_status TEXT,
      approved_at TEXT,
      approval_note TEXT,
      permission_mode TEXT,
      claude_session_id TEXT,
      acceptance_criteria TEXT,
      decision_table TEXT,
      file_edits TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      stream_type TEXT DEFAULT 'stdout',
      timestamp TEXT DEFAULT (datetime('now'))
    );

    -- task_templates table is gone; templates now live on disk as JSON files
    -- managed by src/services/templates.ts. See migration 0037.

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
      CONSTRAINT schedules_template_scope_check
        CHECK (template_scope IN ('global','workspace','project')),
      CONSTRAINT schedules_template_ids_check
        CHECK (
          (template_scope = 'global'    AND template_workspace_id IS NULL     AND template_project_id IS NULL)
       OR (template_scope = 'workspace' AND template_workspace_id IS NOT NULL AND template_project_id IS NULL)
       OR (template_scope = 'project'   AND template_project_id   IS NOT NULL)
        )
    );
    CREATE INDEX idx_schedules_template ON schedules (template_scope, template_name);

    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      claude_session_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      permission_mode TEXT,
      ai_provider_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL,
      model TEXT,
      requires_approval INTEGER DEFAULT 0,
      approval_status TEXT,
      approved_at TEXT,
      approval_note TEXT,
      file_edits TEXT,
      thinking_enabled INTEGER DEFAULT 1 NOT NULL,
      effort TEXT,
      pinned INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_chats_entity ON chats (project_id, entity_type, entity_id);

    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE chat_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      parent_tool_use_id TEXT,
      todos_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_chat_todos_chat_created ON chat_todos (chat_id, created_at DESC);
    CREATE INDEX idx_chat_todos_task_created ON chat_todos (task_id, created_at DESC) WHERE task_id IS NOT NULL;
    CREATE INDEX idx_chat_todos_chat_parent_created
      ON chat_todos (chat_id, parent_tool_use_id, created_at DESC);

    CREATE TABLE chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_chat_attachments_chat_created ON chat_attachments (chat_id, created_at);
    CREATE INDEX idx_chat_attachments_message ON chat_attachments (message_id);

    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      chat_message_id INTEGER,
      project_id INTEGER,
      ai_provider_key_id INTEGER,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_input_tokens INTEGER DEFAULT 0,
      cache_read_input_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      activity_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_usage_records_activity_type
      ON usage_records (activity_type) WHERE activity_type IS NOT NULL;

    CREATE TABLE budget_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      scope_id INTEGER,
      period TEXT NOT NULL,
      limit_usd REAL NOT NULL,
      action TEXT DEFAULT 'pause',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_budget_limits_scope ON budget_limits (scope, scope_id);

    CREATE TABLE secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      scope_id INTEGER,
      name TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_secrets_scope_name ON secrets (scope, scope_id, name);

    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      symptom TEXT,
      root_cause TEXT,
      resolution TEXT,
      tags TEXT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      created_by_chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_incidents_project ON incidents (project_id);
    CREATE INDEX idx_incidents_created ON incidents (created_at);

    -- FTS5 virtual table + triggers, mirroring migration 0025_add_incidents.sql.
    -- Required so services that issue MATCH queries against incidents_fts work
    -- in unit tests the same way they do against the real DB.
    CREATE VIRTUAL TABLE incidents_fts USING fts5(
      symptom,
      root_cause,
      resolution,
      content='incidents',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER incidents_ai AFTER INSERT ON incidents BEGIN
      INSERT INTO incidents_fts (rowid, symptom, root_cause, resolution)
      VALUES (new.id, new.symptom, new.root_cause, new.resolution);
    END;

    CREATE TRIGGER incidents_ad AFTER DELETE ON incidents BEGIN
      INSERT INTO incidents_fts (incidents_fts, rowid, symptom, root_cause, resolution)
      VALUES ('delete', old.id, old.symptom, old.root_cause, old.resolution);
    END;

    CREATE TRIGGER incidents_au AFTER UPDATE ON incidents BEGIN
      INSERT INTO incidents_fts (incidents_fts, rowid, symptom, root_cause, resolution)
      VALUES ('delete', old.id, old.symptom, old.root_cause, old.resolution);
      INSERT INTO incidents_fts (rowid, symptom, root_cause, resolution)
      VALUES (new.id, new.symptom, new.root_cause, new.resolution);
    END;

    -- Agent clarification questions emitted via AskUserQuestion. Mirrors
    -- migration 0029_add_agent_questions.sql so task- and chat-executor
    -- tests can exercise the full question/answer persistence flow.
    CREATE TABLE agent_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      tool_use_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT,
      CONSTRAINT agent_questions_status_check
        CHECK (status IN ('pending','answered','cancelled')),
      CONSTRAINT agent_questions_target_check
        CHECK ((task_id IS NOT NULL AND chat_id IS NULL)
            OR (task_id IS NULL AND chat_id IS NOT NULL))
    );
    CREATE INDEX idx_agent_questions_task_status ON agent_questions (task_id, status);
    CREATE INDEX idx_agent_questions_chat_status ON agent_questions (chat_id, status);
    CREATE INDEX idx_agent_questions_status_created ON agent_questions (status, created_at);
  `);

  return { db, sqlite };
}

/**
 * Seed one active AI provider key into the test DB and return its numeric ID.
 *
 * Route-level workspace/project creation requires at least one active key in
 * `allowedKeyIds` (see src/routes/_allowed-keys.ts), so every test that POSTs
 * to `/workspaces` or `/projects` needs a key to reference. Tests that call
 * `db.insert(workspaces|projects)` directly (bypassing the route) do not.
 */
export function seedActiveKey(
  sqlite: BetterSqlite3Database,
  overrides: { provider?: string; providerType?: string; label?: string } = {},
): number {
  const stmt = sqlite.prepare(
    `INSERT INTO ai_provider_keys (provider, provider_type, label, key_value, is_active)
     VALUES (?, ?, ?, ?, 1)`,
  );
  const res = stmt.run(
    overrides.provider ?? "anthropic",
    overrides.providerType ?? "api-key",
    overrides.label ?? "test-key",
    "sk-ant-api-test",
  );
  return Number(res.lastInsertRowid);
}

/**
 * Reference to a template on disk — mirrors the four columns a schedule row
 * needs (`templateScope` + `templateName` + optional `templateWorkspaceId` /
 * `templateProjectId`). Use with `createTestTemplate` to seed a template file
 * and then feed the returned ref into a `schedules` insert.
 */
export interface TemplateRef {
  templateScope: TemplateScope;
  templateName: string;
  templateWorkspaceId: number | null;
  templateProjectId: number | null;
}

/**
 * Seed a template JSON file on disk via the templates service and return a
 * `TemplateRef` suitable for use in a `schedules` insert.
 *
 * Callers must ensure `FLOCKCTL_HOME` is set to a temp dir (global scope) or
 * that the referenced workspace/project row exists with a real `path`
 * (workspace/project scope) before calling this helper — the service reads
 * those rows via `getDb()` to resolve the on-disk location.
 */
export function createTestTemplate(
  input: Partial<TemplateInput> & { name: string; scope?: TemplateScope },
): TemplateRef {
  const scope: TemplateScope = input.scope ?? "global";
  const tpl = createTemplateFile({
    prompt: "do it",
    ...input,
    scope,
    name: input.name,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  });
  return {
    templateScope: tpl.scope,
    templateName: tpl.name,
    templateWorkspaceId: scope === "workspace" ? input.workspaceId ?? null : null,
    templateProjectId: scope === "project" ? input.projectId ?? null : null,
  };
}
