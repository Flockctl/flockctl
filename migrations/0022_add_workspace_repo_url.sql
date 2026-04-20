-- Track the origin git URL of a workspace so workspaces can be shared with
-- collaborators (auto-detected from `git remote get-url origin` on creation,
-- or set explicitly via API).
ALTER TABLE workspaces ADD COLUMN repo_url TEXT;
