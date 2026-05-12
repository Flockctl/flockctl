import type {
  GitCommitBody,
  GitCommitResult,
  GitPullResult,
  GitPushBody,
  GitPushResult,
  GitStatusResult,
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

/**
 * Stage and commit on the project's current branch. The mutation always
 * resolves with HTTP 200 — the outcome (success / failure-with-reason)
 * is encoded in the response body's discriminated `ok` field. See
 * {@link GitCommitResult} for the shape and `src/services/git-operations.ts`
 * for the full pre-flight contract (empty-message guard, detached-HEAD
 * refusal, path validation, empty-index detection).
 *
 * Body is mandatory: `message` (1-4096 bytes) and an optional `paths`
 * array (≤ 500 entries; omit for `git add -A`). The route enforces
 * those bounds via `gitCommitBodySchema` and returns 422 on violation —
 * a 422 surfaces as a thrown Error here, distinguishing it from the
 * structured 200/`ok:false` outcomes.
 */
export function gitCommitProject(
  projectId: string,
  body: GitCommitBody,
): Promise<GitCommitResult> {
  return apiFetch<GitCommitResult>(`/projects/${projectId}/git-commit`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Push the project's current branch to a single remote. Always resolves
 * with HTTP 200 on the wire — outcome encoded in the discriminated
 * `ok` field. See {@link GitPushResult} and `src/services/git-operations.ts`
 * for the full contract (auth handling, protected-branch refusal,
 * `--force-with-lease` semantics).
 *
 * Body is optional — empty `{}` means `{ remote: 'origin',
 * setUpstream: false, force: false }`. The backend schema is `.strict()`,
 * so passing unknown fields (e.g. `{ all: true }`) returns 422 and
 * surfaces as a thrown Error.
 */
export function gitPushProject(
  projectId: string,
  body: GitPushBody = {},
): Promise<GitPushResult> {
  return apiFetch<GitPushResult>(`/projects/${projectId}/git-push`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Read-only `git status` peek backing the Commit dialog's stage-selection
 * checklist. Always resolves with HTTP 200 — outcome encoded in the
 * discriminated `ok` field. Skips the audit log server-side: the dialog
 * fires this on every open, and audit-row noise from non-mutating reads
 * would drown the forensic signal in the `git_audit_log` table.
 */
export function gitStatusProject(projectId: string): Promise<GitStatusResult> {
  return apiFetch<GitStatusResult>(`/projects/${projectId}/git-status`);
}
