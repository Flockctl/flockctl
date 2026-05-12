import { apiFetch } from "./core";

/**
 * Git discard / fetch API client.
 *
 * Both endpoints back the source-control rail: per-row "Discard" reverts
 * uncommitted changes for one or more tracked paths via
 * `git checkout -- <paths…>`, and the header "Fetch" button refreshes
 * remote-tracking refs without merging.
 *
 * Wire contract mirrors the rest of the git surface:
 *   - HTTP 200 always, even on structured failure. Outcome is encoded in
 *     the discriminated `ok` field; callers branch on `result.ok` rather
 *     than catching exceptions.
 *   - 422 is reserved for malformed bodies (`paths` empty / over the cap,
 *     unknown remote shape) — those surface as a thrown Error from
 *     {@link apiFetch}.
 *
 * Response keys arrive snake_cased after `toSnakeKeys` runs in `apiFetch`,
 * so `filesDiscarded` on the server becomes `files_discarded` here. The
 * types below match the on-the-wire shape — same precedent as
 * `GitCommitSuccess.files_committed`.
 */

// --- Discard ---------------------------------------------------------------

export type GitDiscardReason =
  | "ok"
  | "no_paths"
  | "invalid_path"
  | "path_outside_repo"
  | "unknown_path"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitDiscardSuccess {
  ok: true;
  /** Number of paths git was asked to revert. */
  files_discarded: number;
  reason?: "ok";
}

export interface GitDiscardFailure {
  ok: false;
  reason: GitDiscardReason;
  message?: string;
  stderr?: string;
}

export type GitDiscardResult = GitDiscardSuccess | GitDiscardFailure;

export interface GitDiscardBody {
  /** Repo-relative paths to revert. Server caps the list at 500 entries. */
  paths: string[];
}

export function gitDiscardProject(
  projectId: string,
  body: GitDiscardBody,
): Promise<GitDiscardResult> {
  return apiFetch<GitDiscardResult>(`/projects/${projectId}/git-discard`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function gitDiscardWorkspace(
  workspaceId: string,
  body: GitDiscardBody,
): Promise<GitDiscardResult> {
  return apiFetch<GitDiscardResult>(`/workspaces/${workspaceId}/git-discard`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Fetch -----------------------------------------------------------------

export type GitFetchReason =
  | "ok"
  | "auth_failed"
  | "network_error"
  | "invalid_remote"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitFetchSuccess {
  ok: true;
  remote: string;
  reason?: "ok";
}

export interface GitFetchFailure {
  ok: false;
  remote?: string;
  reason: GitFetchReason;
  message?: string;
  stderr?: string;
}

export type GitFetchResult = GitFetchSuccess | GitFetchFailure;

export interface GitFetchBody {
  /** Defaults to `origin` server-side when omitted. */
  remote?: string;
}

export function gitFetchProject(
  projectId: string,
  body: GitFetchBody = {},
): Promise<GitFetchResult> {
  return apiFetch<GitFetchResult>(`/projects/${projectId}/git-fetch`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function gitFetchWorkspace(
  workspaceId: string,
  body: GitFetchBody = {},
): Promise<GitFetchResult> {
  return apiFetch<GitFetchResult>(`/workspaces/${workspaceId}/git-fetch`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
