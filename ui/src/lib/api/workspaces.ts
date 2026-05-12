import type {
  GitCommitBody,
  GitCommitResult,
  GitPullResult,
  GitPushBody,
  GitPushResult,
  GitStatusResult,
  PaginatedResponse,
  Workspace,
  WorkspaceAllowedKeys,
  WorkspaceCreate,
  WorkspaceUpdate,
  WorkspaceWithProjects,
  WorkspaceProject,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
} from "../types";
import { apiFetch } from "./core";

export function fetchWorkspaces(): Promise<Workspace[]> {
  return apiFetch<PaginatedResponse<Workspace>>("/workspaces").then((r) => r.items);
}

export function fetchWorkspace(id: string): Promise<WorkspaceWithProjects> {
  return apiFetch<WorkspaceWithProjects>(`/workspaces/${id}`);
}

export function createWorkspace(data: WorkspaceCreate): Promise<Workspace> {
  return apiFetch<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateWorkspace(
  id: string,
  data: WorkspaceUpdate,
): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiFetch<void>(`/workspaces/${id}`, { method: "DELETE" });
}

export function addProjectToWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceProject> {
  return apiFetch<WorkspaceProject>(
    `/workspaces/${workspaceId}/projects?project_id=${encodeURIComponent(projectId)}`,
    { method: "POST" },
  );
}

export function removeProjectFromWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<void> {
  return apiFetch<void>(`/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "DELETE",
  });
}

export function fetchWorkspaceDashboard(workspaceId: string): Promise<WorkspaceDashboard> {
  return apiFetch<WorkspaceDashboard>(`/workspaces/${workspaceId}/dashboard`);
}

export function fetchWorkspaceDependencyGraph(workspaceId: string): Promise<WorkspaceDependencyGraph> {
  return apiFetch<WorkspaceDependencyGraph>(`/workspaces/${workspaceId}/dependency-graph`);
}

/**
 * Fetch the effective AI-key allow-list for a workspace. Used by the chat
 * key picker on workspace-only chats (started from the workspace page) so
 * the dropdown is filtered the same way it is for project-scoped chats.
 *
 * Returns `allowedKeyIds: null` when no restriction is configured (any
 * active key may be used).
 */
export function fetchWorkspaceAllowedKeys(
  workspaceId: string,
): Promise<WorkspaceAllowedKeys> {
  return apiFetch<WorkspaceAllowedKeys>(`/workspaces/${workspaceId}/allowed-keys`);
}

/**
 * Run `git pull --ff-only` against the workspace's local clone and return
 * a structured result. Direct mirror of {@link gitPullProject} — same
 * always-200 wire contract, same `GitPullResult` discriminated union, same
 * server-side pre-flight guardrails (workspace must be a git repo, branch
 * must have an upstream, working tree must be clean). See
 * `src/services/git-operations.ts` for the full contract.
 */
export function gitPullWorkspace(workspaceId: string): Promise<GitPullResult> {
  return apiFetch<GitPullResult>(`/workspaces/${workspaceId}/git-pull`, {
    method: "POST",
  });
}

/**
 * Stage and commit on the workspace's current branch. Direct mirror of
 * {@link gitCommitProject} — always resolves with HTTP 200 (outcome
 * encoded in `GitCommitResult.ok`), and the route enforces the same
 * `gitCommitBodySchema` bounds (`message` 1-4096 bytes, `paths` ≤ 500),
 * so a 422 still surfaces as a thrown Error.
 */
export function gitCommitWorkspace(
  workspaceId: string,
  body: GitCommitBody,
): Promise<GitCommitResult> {
  return apiFetch<GitCommitResult>(`/workspaces/${workspaceId}/git-commit`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Push the workspace's current branch to a single remote. Direct mirror
 * of {@link gitPushProject} — always resolves with HTTP 200 (outcome
 * encoded in `GitPushResult.ok`), empty `{}` body lets the backend apply
 * `{ remote: 'origin', setUpstream: false, force: false }`, and the
 * `.strict()` schema rejects unknown fields with 422 (thrown Error).
 */
export function gitPushWorkspace(
  workspaceId: string,
  body: GitPushBody = {},
): Promise<GitPushResult> {
  return apiFetch<GitPushResult>(`/workspaces/${workspaceId}/git-push`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Read-only `git status` peek for the workspace's local clone. Direct
 * mirror of {@link gitStatusProject} — backs the Commit dialog's
 * stage-selection checklist when the dialog is mounted on the
 * workspace-detail surface. Always resolves with HTTP 200 (outcome
 * encoded in the discriminated `ok` field) and is excluded from the
 * git-audit log server-side: a non-mutating peek fired on every dialog
 * open would otherwise drown the forensic signal in the audit table.
 */
export function gitStatusWorkspace(workspaceId: string): Promise<GitStatusResult> {
  return apiFetch<GitStatusResult>(`/workspaces/${workspaceId}/git-status`);
}
