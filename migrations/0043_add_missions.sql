-- Missions + Mission Events: supervisor-loop primitives.
--
-- Why two tables, not one: a mission is the long-lived "why" (objective,
-- budget, autonomy) that owns a tree of milestones / slices / tasks, and
-- mission_events is its append-only timeline (proposals, observations,
-- budget warnings, terminal states). Splitting reads keeps the hot-path
-- supervisor query — "give me the latest N events for mission X" — off
-- the wide row that holds the prompt-template version and budget totals.
--
-- `missions.id` is TEXT (not autoincrement INTEGER) because slice 11/00
-- threads `mission_id` through milestone YAML frontmatter on disk, and a
-- short slug-shaped id avoids leaking sequential row numbers into a file
-- format users hand-edit. CHECK constraints close the `status` and
-- `autonomy` enums at the DB layer so a stale supervisor binary cannot
-- silently insert an unknown lifecycle value and corrupt the state
-- machine. Budget CHECKs (> 0) make "unbounded mission" representationally
-- impossible — the supervisor must have a stop condition.
--
-- `missions.project_id` cascades on project delete: an abandoned project
-- should never leave orphan missions advancing budgets in the background.
-- `mission_events.mission_id` cascades on mission delete: history travels
-- with the mission (the table is not a system audit log; that is `usage`).
--
-- Timestamps are INTEGER `unixepoch()` rather than the project-wide
-- TEXT `datetime('now')` default because the supervisor's hot-path
-- timeline scan needs cheap integer comparisons, and the slice 03 edge
-- test pins a 10k-event timeline scan under 50ms.
--
-- The (mission_id, created_at DESC) compound index is required for the
-- "latest N events" reverse-chronological scan. SQLite supports DESC in
-- index column lists; the optimizer will use it for ORDER BY DESC + LIMIT
-- without an explicit sort step.
--
-- Rollback (see drizzle_rollback test): DROP both tables in reverse FK
-- order — mission_events first, then missions. Milestones survive because
-- the milestone.mission_id column is added in a separate migration (task
-- 02 in this milestone) with ON DELETE SET NULL, so deleting a mission
-- before rollback leaves the milestone rows intact with mission_id NULL.

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  autonomy TEXT NOT NULL DEFAULT 'suggest',
  budget_tokens INTEGER NOT NULL,
  budget_usd_cents INTEGER NOT NULL,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  spent_usd_cents INTEGER NOT NULL DEFAULT 0,
  supervisor_prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT missions_status_check
    CHECK (status IN ('drafting','active','paused','completed','failed','aborted')),
  CONSTRAINT missions_autonomy_check
    CHECK (autonomy IN ('manual','suggest','auto')),
  CONSTRAINT missions_budget_tokens_check
    CHECK (budget_tokens > 0),
  CONSTRAINT missions_budget_usd_cents_check
    CHECK (budget_usd_cents > 0)
);
--> statement-breakpoint
CREATE INDEX idx_missions_project ON missions (project_id);
--> statement-breakpoint

CREATE TABLE mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT mission_events_kind_check
    CHECK (kind IN (
      'plan_proposed','task_observed','remediation_proposed',
      'remediation_approved','remediation_dismissed',
      'budget_warning','budget_exceeded','depth_exceeded',
      'no_action','objective_met','stalled','heartbeat','paused'
    ))
);
--> statement-breakpoint
CREATE INDEX idx_mission_events_mission_created
  ON mission_events (mission_id, created_at DESC);
