import type { GitShowResult } from "../types";
import { apiFetch } from "./core";

/**
 * git-show API client — single-commit detail walk for a project or
 * workspace. Backed by `GET /:scope/:id/git-show?sha=<sha>` (the
 * project + workspace routers share the `makeGitRouteHandlers` factory;
 * the response shape is identical on both surfaces).
 *
 * Returns the commit metadata + a flat file list with status (M/A/D/R/C)
 * and per-file added / removed counts. The server runs three fixed
 * `git show` invocations (metadata + name-status + numstat) — the
 * expensive patch body is NEVER fetched here. Per-file diffs are fetched
 * lazily by the existing `/git-diff?base=<sha>~1&head=<sha>&path=<p>`
 * endpoint as the user clicks files in the UI.
 *
 * For the initial commit (no parent), callers should pass git's
 * well-known empty-tree SHA (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`)
 * as the diff `base`.
 *
 * Always resolves with HTTP 200 on the wire — outcome (success / failure)
 * is encoded in the body's discriminated `ok` field. The hook layer
 * (`useGitShow`) surfaces failure via `query.error` by throwing on
 * `ok: false`.
 */
export function fetchGitShow(
  scope: "projects" | "workspaces",
  entityId: string,
  sha: string,
): Promise<GitShowResult> {
  const qs = new URLSearchParams({ sha });
  return apiFetch<GitShowResult>(
    `/${scope}/${entityId}/git-show?${qs.toString()}`,
  );
}

/**
 * git's well-known empty-tree SHA. Pass this as the diff `base` when
 * displaying per-file diffs for the initial commit (which has no
 * parent — `<sha>~1` would 404 against git's bad-revision classifier).
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// --- git-diff (per-file diff for the commit-detail tab) ----------------
//
// Mirrors `RunGitDiffResult` in `src/services/git-operations.ts`. The
// commit-detail tab fetches one of these per file the user clicks in
// the left list — the M02 endpoint is reused as-is. We define the
// minimum fetcher + types here rather than coupling to a future
// generic git-diff client (which may sprout `staged` / working-tree
// modes the commit-detail flow doesn't need).

export type GitDiffStatus = "M" | "A" | "D" | "R" | "C" | "binary" | "unchanged";

export type GitDiffReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "git_patch_too_large"
  | "timeout"
  | "unknown";

export interface GitDiffSuccess {
  ok: true;
  patch: string;
  base: string | null;
  head: string | null;
  status: GitDiffStatus;
  old_path?: string;
  new_path?: string;
  size: number;
  reason: "ok";
}

export interface GitDiffFailure {
  ok: false;
  reason: GitDiffReason;
  message?: string;
  stderr?: string;
  size?: number;
  hint?: string;
}

export type GitDiffResult = GitDiffSuccess | GitDiffFailure;

/**
 * Fetch the per-file diff between two commits. The commit-detail tab
 * always passes `base=<sha>~1` and `head=<sha>` (or
 * `base=<EMPTY_TREE_SHA>` for the initial commit).
 */
export function fetchGitDiff(
  scope: "projects" | "workspaces",
  entityId: string,
  params: { path: string; base: string; head: string },
): Promise<GitDiffResult> {
  const qs = new URLSearchParams({
    path: params.path,
    base: params.base,
    head: params.head,
  });
  return apiFetch<GitDiffResult>(
    `/${scope}/${entityId}/git-diff?${qs.toString()}`,
  );
}
