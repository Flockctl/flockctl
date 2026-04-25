CREATE TABLE chat_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  todos_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX idx_chat_todos_chat_created ON chat_todos (chat_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX idx_chat_todos_task_created ON chat_todos (task_id, created_at DESC) WHERE task_id IS NOT NULL;
