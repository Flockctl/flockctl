import { apiFetch } from "./core";

// --- TODO.md (per-project and per-workspace user notes) ---
// Plain Markdown file stored at the root of the project/workspace directory.
// Unlike AGENTS.md there is no reconciler — what you save is what agents see.

export interface TodoFileResponse {
  /** File contents. Empty string when the file does not exist yet or the
   *  owning entity has no filesystem path recorded. */
  content: string;
  /** Absolute path to TODO.md on disk. Empty string when the entity has no
   *  path (e.g. a project row created without a directory). */
  path: string;
}

export function fetchProjectTodo(projectId: string): Promise<TodoFileResponse> {
  return apiFetch(`/projects/${projectId}/todo`, { rawKeys: true });
}

export function updateProjectTodo(
  projectId: string,
  content: string,
): Promise<TodoFileResponse> {
  return apiFetch(`/projects/${projectId}/todo`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}

export function fetchWorkspaceTodo(workspaceId: string): Promise<TodoFileResponse> {
  return apiFetch(`/workspaces/${workspaceId}/todo`, { rawKeys: true });
}

export function updateWorkspaceTodo(
  workspaceId: string,
  content: string,
): Promise<TodoFileResponse> {
  return apiFetch(`/workspaces/${workspaceId}/todo`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}
