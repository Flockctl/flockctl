import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";

import {
  fetchGitBranches,
  gitBranchDelete,
  gitCheckout,
  type GitBranchDeleteBody,
  type GitBranchDeleteResult,
  type GitBranchListResult,
  type GitCheckoutBody,
  type GitCheckoutResult,
} from "../api/git-branches";
import { useWsConnected } from "../global-ws";
import { queryKeys } from "./core";
import { gitLogQueryKey } from "./git-log";

/**
 * git-branches query + mutation hooks. Three operations, two surfaces
 * (project / workspace) — each surface gets a paired hook with the
 * right cache-invalidation policy:
 *
 *   • useGitBranches{Project,Workspace} — list query.
 *   • useGitCheckout{Project,Workspace} — switch / create branch.
 *     Invalidates: branches list, git-status (current branch + ahead/behind),
 *     git-log (history walks from new HEAD), tree (file rows decorate by
 *     dirty state).
 *   • useGitBranchDelete{Project,Workspace} — delete a local branch.
 *     Invalidates: branches list only — deleting a non-current branch
 *     does not touch the working tree, the porcelain, or the log walk
 *     from HEAD.
 *
 * Cache key shape: `[scope, entityId, "git-branches"]`. We don't extend
 * the central `queryKeys` table here because branches are a fairly local
 * concern — the BranchPicker is the only consumer today, and the rest
 * of the SCM panel reads `git-status` for the current-branch slice.
 *
 * Failure handling: list throws on `ok: false` so the picker surfaces the
 * error via `query.error`; checkout / delete return the discriminated
 * result verbatim so the caller can render reason-specific copy
 * (`dirty_working_tree` → "commit or stash first" hint).
 */

export function gitBranchesQueryKey(
  scope: "projects" | "workspaces",
  entityId: string,
) {
  return [scope, entityId, "git-branches"] as const;
}

interface UseGitBranchesOptions {
  enabled?: boolean;
  staleTime?: number;
}

function useGitBranches(
  scope: "projects" | "workspaces",
  entityId: string,
  options: UseGitBranchesOptions = {},
) {
  const { enabled = true, staleTime = 0 } = options;
  return useQuery<GitBranchListResult, Error, GitBranchListResult>({
    queryKey: gitBranchesQueryKey(scope, entityId),
    queryFn: async () => {
      const result = await fetchGitBranches(scope, entityId);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        const detail = result.message ? ` (${result.message})` : "";
        const err = new Error(`git-branches failed: ${reason}${detail}`);
        (err as Error & { reason?: string }).reason = reason;
        throw err;
      }
      return result;
    },
    enabled: enabled && !!entityId,
    staleTime,
  } satisfies UseQueryOptions<GitBranchListResult, Error, GitBranchListResult>);
}

export function useGitBranchesProject(
  projectId: string,
  options: UseGitBranchesOptions = {},
) {
  // When the live `git-status-changed` channel is connected we keep the
  // list "fresh" (staleTime: 0 keeps the on-mount refetch contract for
  // the BranchPicker); when it's down we let React Query treat the
  // result as fresh for 30 s so we don't accidentally hammer the
  // endpoint on focus refetches while the socket is reconnecting.
  const wsConnected = useWsConnected();
  const fallbackStale = wsConnected ? 0 : 30_000;
  const merged: UseGitBranchesOptions = {
    staleTime: fallbackStale,
    ...options,
  };
  return useGitBranches("projects", projectId, merged);
}

export function useGitBranchesWorkspace(
  workspaceId: string,
  options: UseGitBranchesOptions = {},
) {
  return useGitBranches("workspaces", workspaceId, options);
}

// ─── Checkout ─────────────────────────────────────────────────────────────

export function useGitCheckoutProject() {
  const qc = useQueryClient();
  return useMutation<
    GitCheckoutResult,
    Error,
    { projectId: string; body: GitCheckoutBody }
  >({
    mutationFn: ({ projectId, body }) => gitCheckout("projects", projectId, body),
    onSuccess: (result, { projectId }) => {
      // Always refresh branches — the list answers "which branch is
      // current", which flips on every successful checkout. We also
      // invalidate on failure (e.g. dirty_working_tree) because the
      // server may have made partial progress; the porcelain peek is
      // cheap and a safer default than skipping.
      qc.invalidateQueries({ queryKey: gitBranchesQueryKey("projects", projectId) });
      qc.invalidateQueries({ queryKey: queryKeys.projectGitStatus(projectId) });
      if (!result.ok) return;
      // Successful checkout → HEAD moved, git log + tree must refetch.
      qc.invalidateQueries({ queryKey: gitLogQueryKey("projects", projectId) });
      qc.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
    },
  });
}

export function useGitCheckoutWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    GitCheckoutResult,
    Error,
    { workspaceId: string; body: GitCheckoutBody }
  >({
    mutationFn: ({ workspaceId, body }) =>
      gitCheckout("workspaces", workspaceId, body),
    onSuccess: (result, { workspaceId }) => {
      qc.invalidateQueries({
        queryKey: gitBranchesQueryKey("workspaces", workspaceId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.workspaceGitStatus(workspaceId) });
      if (!result.ok) return;
      qc.invalidateQueries({ queryKey: gitLogQueryKey("workspaces", workspaceId) });
      qc.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────

export function useGitBranchDeleteProject() {
  const qc = useQueryClient();
  return useMutation<
    GitBranchDeleteResult,
    Error,
    { projectId: string; branch: string; body?: GitBranchDeleteBody }
  >({
    mutationFn: ({ projectId, branch, body }) =>
      gitBranchDelete("projects", projectId, branch, body),
    onSuccess: (result, { projectId }) => {
      // Even structured failures (e.g. `not_fully_merged`) want a
      // refresh — the operator may have force-deleted a sibling in the
      // meantime, and the list is what they read next.
      qc.invalidateQueries({ queryKey: gitBranchesQueryKey("projects", projectId) });
      // No further invalidates: deleting a non-current branch does not
      // touch the working tree, the porcelain, or the HEAD-rooted log
      // walk. The current-branch case is rejected upstream by git
      // itself (`git_cannot_delete_current_branch`).
      void result;
    },
  });
}

export function useGitBranchDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    GitBranchDeleteResult,
    Error,
    { workspaceId: string; branch: string; body?: GitBranchDeleteBody }
  >({
    mutationFn: ({ workspaceId, branch, body }) =>
      gitBranchDelete("workspaces", workspaceId, branch, body),
    onSuccess: (_result, { workspaceId }) => {
      qc.invalidateQueries({
        queryKey: gitBranchesQueryKey("workspaces", workspaceId),
      });
    },
  });
}
