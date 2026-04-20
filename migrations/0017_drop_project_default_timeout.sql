-- Drop projects.default_timeout_seconds — this field is stored in
-- .flockctl/config.yaml (portable across machines via git). Keeping a
-- duplicate DB column caused split-brain where UI saved one value and
-- the executor read a stale one.
ALTER TABLE projects DROP COLUMN default_timeout_seconds;
