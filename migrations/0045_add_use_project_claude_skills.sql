-- Per-project opt-in flag for honoring `<project>/.claude/skills/` as a skill source.
--
-- When `use_project_claude_skills = 1`, `resolveSkillsForProject()`
-- (src/services/skills.ts) walks the project's own `.claude/skills/<name>/SKILL.md`
-- files, treats each as a `level='project'` skill that overrides any same-name
-- entry from global / workspace / `.flockctl/skills/`, and marks them as
-- "locked on" — the per-project `disabledSkills` list cannot turn them off.
--
-- Default 0 (= legacy behaviour): the project's `.claude/skills/` directory
-- is treated as a Flockctl-managed symlink farm only, not as a skill source.
--
-- Stored on `projects` rather than `.flockctl/config.json` because the flag
-- governs which skills the agent sees on this machine — losing that decision
-- to a stale config file checkout would silently change agent behaviour. DB
-- semantics also let the create dialog set it atomically alongside the row.

ALTER TABLE projects ADD COLUMN use_project_claude_skills INTEGER DEFAULT 0 NOT NULL;
