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
--> statement-breakpoint
CREATE UNIQUE INDEX idx_secrets_scope_name ON secrets (scope, scope_id, name);
