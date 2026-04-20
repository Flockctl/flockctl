-- Drop workspace DB columns that duplicate <workspace>/.flockctl/config.yaml.
-- Values are copied into yaml at boot by backfillWorkspaceConfigsFromDb()
-- before this migration runs.
ALTER TABLE workspaces DROP COLUMN disabled_skills;
--> statement-breakpoint
ALTER TABLE workspaces DROP COLUMN disabled_mcp_servers;
--> statement-breakpoint
ALTER TABLE workspaces DROP COLUMN permission_mode;
