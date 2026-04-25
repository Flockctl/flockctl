-- Per-session file-edit journal.
--
-- Replaces the `git diff` against the shared working tree (kept in
-- `tasks.git_diff_summary` + `git_commit_before`/`_after`) with a list of
-- `{ filePath, original, current }` entries built directly from Edit/Write/
-- MultiEdit tool inputs. This keeps each task's / chat's diff isolated from
-- unrelated working-tree dirt and from any parallel session running in the
-- same project. See `src/services/file-edit-journal.ts` for the payload
-- shape and the rationale; see CHANGELOG 0.x for the user-visible story.
--
-- The pre-existing git_* columns on `tasks` are intentionally retained for
-- legacy rows so task-detail can still render historical diffs; they are no
-- longer written to for new tasks.

ALTER TABLE tasks ADD COLUMN file_edits TEXT;--> statement-breakpoint
ALTER TABLE chats ADD COLUMN file_edits TEXT;
