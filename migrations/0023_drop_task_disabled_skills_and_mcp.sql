-- Task-level disable lists removed: skills/MCP disables now only exist at
-- workspace/project level where they feed the reconciler's view manifest.
ALTER TABLE tasks DROP COLUMN disabled_skills;
--> statement-breakpoint
ALTER TABLE tasks DROP COLUMN disabled_mcp_servers;
