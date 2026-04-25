-- Chat attachments: file blobs uploaded into a chat.
-- `chat_id` cascades on chat deletion; `message_id` is set NULL if the
-- originating message is deleted so the blob row survives for audit.
-- `path` is UNIQUE so a retried upload with a fresh UUID cannot insert
-- duplicate rows — the uploader must regenerate the UUID on retry, not
-- reuse it.
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
--> statement-breakpoint
CREATE INDEX idx_chat_attachments_chat_created ON chat_attachments (chat_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_chat_attachments_message ON chat_attachments (message_id);
