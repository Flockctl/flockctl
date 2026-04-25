-- Agent questions: prompts the agent has surfaced back to the user, scoped
-- to either a task or a chat (never both). The XOR is enforced at the DB
-- layer so a partial-update or buggy caller cannot insert a row that orphans
-- in both directions. `request_id` is the idempotency token used by the
-- agent client to safely retry without duplicating rows. `tool_use_id`
-- carries the Anthropic SDK tool_use ID so the answer can be routed back
-- into the in-flight assistant turn.
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
--> statement-breakpoint
CREATE INDEX idx_agent_questions_task_status ON agent_questions (task_id, status);
--> statement-breakpoint
CREATE INDEX idx_agent_questions_chat_status ON agent_questions (chat_id, status);
--> statement-breakpoint
CREATE INDEX idx_agent_questions_status_created ON agent_questions (status, created_at);
