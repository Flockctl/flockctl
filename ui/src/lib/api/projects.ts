import type {
  GitPullResult,
  PaginatedResponse,
  Project,
  ProjectAllowedKeys,
  ProjectCreate,
  ProjectScan,
  ProjectUpdate,
} from "../types";
import { apiFetch } from "./core";

export function fetchProjects(): Promise<Project[]> {
  return apiFetch<PaginatedResponse<Project>>("/projects").then((r) => r.items);
}

export function fetchProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`);
}

export function createProject(data: ProjectCreate): Promise<Project> {
  return apiFetch<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function scanProjectPath(path: string): Promise<ProjectScan> {
  return apiFetch<ProjectScan>("/projects/scan", {
    method: "POST",
    body: JSON.stringify({ path }),
    rawKeys: true,
  });
}

export function updateProject(
  id: string,
  data: ProjectUpdate,
): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
}

/**
 * Fetch the effective AI-key allow-list for a project, with workspace → project
 * inheritance resolved server-side. Returns `allowedKeyIds: null` when no
 * restriction is configured (all active keys are permitted).
 */
export function fetchProjectAllowedKeys(
  projectId: string,
): Promise<ProjectAllowedKeys> {
  return apiFetch<ProjectAllowedKeys>(`/projects/${projectId}/allowed-keys`);
}

/**
 * Run `git pull --ff-only` against the project's local clone and return a
 * structured result. Always resolves with HTTP 200 on the wire — the
 * outcome (success / failure-with-reason) is encoded in the response
 * body's discriminated `ok` field. See {@link GitPullResult} for the
 * shape and `src/services/git-operations.ts` for the full contract.
 *
 * Pre-flight guardrails enforced server-side: project must be a git
 * repo, current branch must have an upstream, and the working tree must
 * be clean. Pull strategy is hardcoded to fast-forward only — diverged
 * branches return `reason: "non_fast_forward"` so the user can resolve
 * the merge / rebase in a terminal where they have proper tooling.
 */
export function gitPullProject(projectId: string): Promise<GitPullResult> {
  return apiFetch<GitPullResult>(`/projects/${projectId}/git-pull`, {
    method: "POST",
  });
}
