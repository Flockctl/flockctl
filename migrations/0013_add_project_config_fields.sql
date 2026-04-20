-- Add project-level configuration fields to support database-driven config
ALTER TABLE projects ADD COLUMN planning_model TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN test_command TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN default_timeout_seconds INTEGER;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN max_concurrent_tasks INTEGER;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN budget_daily_usd REAL;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN env_vars TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN requires_approval INTEGER DEFAULT 0;
