ALTER TABLE tasks ADD COLUMN requires_approval INTEGER DEFAULT 0;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN approval_status TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN approved_at TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN approval_note TEXT;
