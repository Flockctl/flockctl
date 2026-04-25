-- Structured spec fields attached to a task. All three are optional and
-- default to NULL on existing rows. `acceptance_criteria` holds a JSON string
-- array, `decision_table` holds a JSON object, `state_machine` holds raw YAML.
-- The per-plan `spec_required` flag is stored in plan YAML frontmatter
-- (plan-store), not here, to avoid a per-task override and keep UX simple.
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN decision_table TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN state_machine TEXT;
