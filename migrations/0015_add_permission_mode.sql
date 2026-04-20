ALTER TABLE workspaces ADD COLUMN permission_mode TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN permission_mode TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN permission_mode TEXT;
--> statement-breakpoint
ALTER TABLE chats ADD COLUMN permission_mode TEXT;
