-- Persist AI key assignment on task templates
ALTER TABLE task_templates ADD COLUMN assigned_key_id INTEGER REFERENCES ai_provider_keys(id);
