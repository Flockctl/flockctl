-- Incidents knowledge-base table + FTS5 full-text index.
-- drizzle-kit does not emit FTS5 virtual tables or triggers, so this migration
-- is hand-authored and registered in meta/_journal.json manually.

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
--> statement-breakpoint
CREATE INDEX idx_incidents_project ON incidents (project_id);
--> statement-breakpoint
CREATE INDEX idx_incidents_created ON incidents (created_at);
--> statement-breakpoint

-- FTS5 virtual table backed by `incidents` as external content.
-- Only the searchable text columns are indexed; rowid mirrors incidents.id.
CREATE VIRTUAL TABLE incidents_fts USING fts5(
  symptom,
  root_cause,
  resolution,
  content='incidents',
  content_rowid='id',
  tokenize='unicode61'
);
--> statement-breakpoint

-- Keep the FTS index in sync with the base table.
CREATE TRIGGER incidents_ai AFTER INSERT ON incidents BEGIN
  INSERT INTO incidents_fts (rowid, symptom, root_cause, resolution)
  VALUES (new.id, new.symptom, new.root_cause, new.resolution);
END;
--> statement-breakpoint
CREATE TRIGGER incidents_ad AFTER DELETE ON incidents BEGIN
  INSERT INTO incidents_fts (incidents_fts, rowid, symptom, root_cause, resolution)
  VALUES ('delete', old.id, old.symptom, old.root_cause, old.resolution);
END;
--> statement-breakpoint
CREATE TRIGGER incidents_au AFTER UPDATE ON incidents BEGIN
  INSERT INTO incidents_fts (incidents_fts, rowid, symptom, root_cause, resolution)
  VALUES ('delete', old.id, old.symptom, old.root_cause, old.resolution);
  INSERT INTO incidents_fts (rowid, symptom, root_cause, resolution)
  VALUES (new.id, new.symptom, new.root_cause, new.resolution);
END;
