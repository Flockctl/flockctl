-- Per-scope gitignore toggles for the auto-managed Flockctl block.
--
-- `ensureGitignore()` (src/services/claude/skills-sync.ts) rewrites a marked
-- block inside <scope>/.gitignore with a fixed list of Flockctl-owned paths
-- (e.g. `.claude/skills/`, `.flockctl/.skills-reconcile`). These three flags
-- let users opt into ignoring the entire `.flockctl/` directory and/or the
-- root-level `TODO.md` / `AGENTS.md` (+ `CLAUDE.md`) files on a per-project
-- or per-workspace basis. Default 0 (= current behavior: nothing extra).
--
-- When gitignore_flockctl=1, `ensureGitignore()` drops the granular
-- `.flockctl/*` sub-paths from the block and emits a single `.flockctl/`
-- entry instead, so the same content is never listed twice.

ALTER TABLE projects ADD COLUMN gitignore_flockctl INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN gitignore_todo INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN gitignore_agents_md INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN gitignore_flockctl INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN gitignore_todo INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN gitignore_agents_md INTEGER DEFAULT 0 NOT NULL;
