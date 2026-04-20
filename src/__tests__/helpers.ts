import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { FlockctlDb } from "../db/index.js";

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

    CREATE TABLE task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id),
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT,
      agent TEXT,
      model TEXT,
      image TEXT,
      command TEXT,
      working_dir TEXT,
      env_vars TEXT,
      timeout_seconds INTEGER,
      label_selector TEXT,
      assigned_key_id INTEGER REFERENCES ai_provider_keys(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES task_templates(id),
      schedule_type TEXT NOT NULL,
      cron_expression TEXT,
      run_at TEXT,
      timezone TEXT DEFAULT 'UTC',
      status TEXT DEFAULT 'active',
      last_fire_time TEXT,
      next_fire_time TEXT,
      misfire_grace_seconds INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      claude_session_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      permission_mode TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

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
      created_at TEXT DEFAULT (datetime('now'))
    );

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
  `);

  return { db, sqlite };
}
