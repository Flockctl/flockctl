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
--> statement-breakpoint
CREATE INDEX idx_budget_limits_scope ON budget_limits (scope, scope_id);
