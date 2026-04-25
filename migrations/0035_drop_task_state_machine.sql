-- Drop the task-level `state_machine` spec column. The column was a raw-YAML
-- free-text field whose only two consumers (a YAML DSL parser and a Vitest
-- harness generator) have been removed; shape-of-data contracts now live in
-- `.flockctl/state-machines/*.md` registries at the project level, not per
-- task. Existing rows lose their payload — the column was optional, so this
-- is a clean drop with no data rescue.
ALTER TABLE tasks DROP COLUMN state_machine;
