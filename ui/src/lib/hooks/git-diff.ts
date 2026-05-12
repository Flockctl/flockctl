import { useQuery } from "@tanstack/react-query";
import {
  fetchGitDiffWithContents,
  type GitDiffMode,
  type GitDiffWithContentsResult,
} from "../api/git-diff";

/**
 * Code-mode diff-tab hook. Wraps the contents-aware diff endpoint in
 * `useQuery` so a re-mounted DiffTabContent instantly hits cache and
 * the underlying SHA / mode change re-fires without manual plumbing.
 *
 * Cache key shape mirrors `useGitShow`:
 *   `[scope, entityId, "git-diff", path, mode]`
 * with `mode` collapsed to a stable string so React Query's structural
 * comparator hits — passing the raw mode object as a key segment would
 * miss because its property order isn't normalised across call sites.
 *
 * Failure mode: unlike `useGitShow`, we DO NOT throw on `ok: false`
 * because the diff-tab consumer wants to render a meaningful fallback
 * (operator-friendly copy keyed off `reason`) rather than swap to a
 * generic error banner. Callers inspect `query.data.ok` directly.
 *
 * Disabled when `entityId` or `path` is empty so the parent can flip
 * targets without juggling conditional rendering.
 */
export function gitDiffQueryKey(
  scope: "projects" | "workspaces",
  entityId: string,
  path: string,
  mode: GitDiffMode,
) {
  // `mode` is reduced to its canonical string so React Query's deep
  // comparator (which is structural, not reference-equal) collapses
  // semantically-equal keys regardless of property order.
  const modeKey = mode.staged === true
    ? "staged"
    : mode.base !== undefined && mode.head !== undefined
      ? `${mode.base}..${mode.head}`
      : "working";
  return [scope, entityId, "git-diff", path, modeKey] as const;
}

export function useGitDiff(
  scope: "projects" | "workspaces",
  entityId: string,
  path: string,
  mode: GitDiffMode = {},
) {
  return useQuery<GitDiffWithContentsResult, Error>({
    queryKey: gitDiffQueryKey(scope, entityId, path, mode),
    queryFn: () =>
      fetchGitDiffWithContents(scope, entityId, {
        path,
        ...mode,
      }),
    enabled: !!entityId && !!path,
    // The diff-tab payload is stable for committed history (`base..head`),
    // but for `staged` / `working` modes the underlying disk state can
    // change at any time. We intentionally keep `staleTime` low (the
    // default) so a focus regrab refetches — the SCM panel's manual
    // refresh button also invalidates this key for an explicit refresh.
  });
}
