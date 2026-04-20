-- Drop DB columns that duplicate .flockctl/config.yaml. Config lives in
-- the project repo so it can be shared via git; DB holds only
-- machine-local state. Any pre-existing DB values are copied into yaml
-- at boot by backfillProjectConfigsFromDb() before this migration runs.
ALTER TABLE projects DROP COLUMN model;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN planning_model;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN allowed_providers;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN base_branch;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN test_command;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN post_merge_verification_cmd;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN max_concurrent_tasks;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN budget_daily_usd;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN requires_approval;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN env_vars;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN disabled_skills;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN disabled_mcp_servers;
--> statement-breakpoint
ALTER TABLE projects DROP COLUMN permission_mode;
