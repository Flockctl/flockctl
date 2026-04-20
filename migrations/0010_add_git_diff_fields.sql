ALTER TABLE tasks ADD COLUMN git_commit_before TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN git_commit_after TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN git_diff_summary TEXT;
