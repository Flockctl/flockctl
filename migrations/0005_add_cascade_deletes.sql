-- Add ON DELETE CASCADE to tasks, task_templates, chats, merge_queue_entries, schedules
-- SQLite requires table recreation to change FK constraints

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- ─── tasks ───
CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
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
  disabled_skills TEXT,
  disabled_mcp_servers TEXT,
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
INSERT INTO tasks_new SELECT * FROM tasks;
--> statement-breakpoint
DROP TABLE tasks;
--> statement-breakpoint
ALTER TABLE tasks_new RENAME TO tasks;
--> statement-breakpoint

-- ─── task_templates ───
CREATE TABLE task_templates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
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
INSERT INTO task_templates_new SELECT * FROM task_templates;
--> statement-breakpoint
DROP TABLE task_templates;
--> statement-breakpoint
ALTER TABLE task_templates_new RENAME TO task_templates;
--> statement-breakpoint

-- ─── schedules (depends on task_templates, must be after) ───
CREATE TABLE schedules_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER REFERENCES task_templates(id) ON DELETE CASCADE,
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
INSERT INTO schedules_new SELECT * FROM schedules;
--> statement-breakpoint
DROP TABLE schedules;
--> statement-breakpoint
ALTER TABLE schedules_new RENAME TO schedules;
--> statement-breakpoint

-- ─── chats ───
CREATE TABLE chats_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  claude_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
INSERT INTO chats_new SELECT * FROM chats;
--> statement-breakpoint
DROP TABLE chats;
--> statement-breakpoint
ALTER TABLE chats_new RENAME TO chats;
--> statement-breakpoint

-- ─── chat_messages (depends on chats, must recreate after chats) ───
CREATE TABLE chat_messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
INSERT INTO chat_messages_new SELECT * FROM chat_messages;
--> statement-breakpoint
DROP TABLE chat_messages;
--> statement-breakpoint
ALTER TABLE chat_messages_new RENAME TO chat_messages;
--> statement-breakpoint

-- ─── merge_queue_entries ───
CREATE TABLE merge_queue_entries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
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
INSERT INTO merge_queue_entries_new SELECT * FROM merge_queue_entries;
--> statement-breakpoint
DROP TABLE merge_queue_entries;
--> statement-breakpoint
ALTER TABLE merge_queue_entries_new RENAME TO merge_queue_entries;
--> statement-breakpoint

-- ─── task_logs (depends on tasks, must recreate after tasks) ───
CREATE TABLE task_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  stream_type TEXT DEFAULT 'stdout',
  timestamp TEXT DEFAULT (datetime('now'))
);
--> statement-breakpoint
INSERT INTO task_logs_new SELECT * FROM task_logs;
--> statement-breakpoint
DROP TABLE task_logs;
--> statement-breakpoint
ALTER TABLE task_logs_new RENAME TO task_logs;
--> statement-breakpoint

PRAGMA foreign_keys = ON;
