CREATE TABLE IF NOT EXISTS ai_provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  label TEXT,
  key_value TEXT,
  cli_command TEXT,
  env_var_name TEXT,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  last_error TEXT,
  last_error_at TEXT,
  consecutive_errors INTEGER DEFAULT 0,
  disabled_until TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  path TEXT,
  repo_url TEXT,
  base_branch TEXT DEFAULT 'main',
  model TEXT,
  required_providers TEXT,
  allowed_providers TEXT,
  provider_fallback_chain TEXT,
  backoff_config TEXT,
  allowed_key_ids TEXT,
  denied_key_ids TEXT,
  post_merge_verification_cmd TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS milestones (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plan_slices (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plan_tasks (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  prompt TEXT,
  agent TEXT,
  model TEXT,
  image TEXT,
  command TEXT,
  working_dir TEXT,
  env_vars TEXT,
  status TEXT DEFAULT 'queued',
  task_type TEXT DEFAULT 'execution',
  target_slice_id INTEGER,
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
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  stream_type TEXT DEFAULT 'stdout',
  timestamp TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_templates (
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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS schedules (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  project_id INTEGER REFERENCES projects(id),
  title TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS merge_queue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  task_id INTEGER REFERENCES tasks(id),
  task_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  resolution_task_id INTEGER,
  verification_task_id INTEGER,
  conflict_files TEXT,
  resolution_attempts INTEGER DEFAULT 0,
  merge_commit_sha TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  chat_message_id INTEGER,
  project_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
