ALTER TABLE workspaces ADD COLUMN disabled_skills TEXT;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN disabled_mcp_servers TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN disabled_skills TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN disabled_mcp_servers TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN disabled_skills TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN disabled_mcp_servers TEXT;
