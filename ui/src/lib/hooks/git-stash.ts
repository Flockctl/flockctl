import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";

import {
  fetchGitStashList,
  gitStashDrop,
  gitStashPop,
  gitStashPush,
  type GitStashListResult,
  type GitStashPopBody,
  type GitStashPopResult,
  type GitStashPushBody,
  type GitStashPushResult,
  type GitStashDropResult,
} from "../api/git-stash";
import { fsListQueryKey, projectFileQueryKey, workspaceFileQueryKey } from "./fs";
import { queryKeys } from "./core";

/**
 * git-stash query + mutation hooks. Four operations, two surfaces
 * (project / workspace) — paired hooks with the right cache-invalidation
 * policy.
 *
 *   • useGitStashList{Project,Workspace} — list query.
 *   • useGitStashPush{Project,Workspace} — snapshot working tree onto
 *     the stack. On success: working tree changed (entries vanish) and a
 *     new stash entry exists. Invalidates: stash list, git-status,
 *     project tree, file caches (caller can pass affected paths).
 *   • useGitStashPop{Project,Workspace}  — apply + drop. On success:
 *     working tree changed (the stashed delta lands back), entry gone
 *     from the stack. On `git_stash_pop_conflict`: the entry STAYS on
 *     the stack and the working tree carries unresolved conflicts; the
 *     UI should still refresh both. Invalidates: stash list, git-status,
 *     tree, file caches.
 *   • useGitStashDrop{Project,Workspace} — forget a single entry.
 *     Working tree is untouched; only the stash list changes.
 *
 * Cache key shape: `[scope, entityId, "git-stash"]`. Mirrors the
 * branches hook — the StashSection is the only consumer today.
 */

export function gitStashQueryKey(
  scope: "projects" | "workspaces",
  entityId: string,
) {
  return [scope, entityId, "git-stash"] as const;
}

interface UseGitStashListOptions {
  enabled?: boolean;
  staleTime?: number;
}

function useGitStashList(
  scope: "projects" | "workspaces",
  entityId: string,
  options: UseGitStashListOptions = {},
) {
  const { enabled = true, staleTime = 0 } = options;
  return useQuery<GitStashListResult, Error, GitStashListResult>({
    queryKey: gitStashQueryKey(scope, entityId),
    queryFn: async () => {
      const result = await fetchGitStashList(scope, entityId);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        const detail = result.message ? ` (${result.message})` : "";
        const err = new Error(`git-stash-list failed: ${reason}${detail}`);
        (err as Error & { reason?: string }).reason = reason;
        throw err;
      }
      return result;
    },
    enabled: enabled && !!entityId,
    staleTime,
  } satisfies UseQueryOptions<GitStashListResult, Error, GitStashListResult>);
}

export function useGitStashListProject(
  projectId: string,
  options: UseGitStashListOptions = {},
) {
  return useGitStashList("projects", projectId, options);
}

export function useGitStashListWorkspace(
  workspaceId: string,
  options: UseGitStashListOptions = {},
) {
  return useGitStashList("workspaces", workspaceId, options);
}

// ─── Push ─────────────────────────────────────────────────────────────────

export function useGitStashPushProject() {
  const qc = useQueryClient();
  return useMutation<
    GitStashPushResult,
    Error,
    { projectId: string; body?: GitStashPushBody }
  >({
    mutationFn: ({ projectId, body }) => gitStashPush("projects", projectId, body),
    onSuccess: (result, { projectId }) => {
      // Always refresh the stash list — even a `nothing_to_stash` no-op
      // is a valid outcome the operator wants to see.
      qc.invalidateQueries({ queryKey: gitStashQueryKey("projects", projectId) });
      qc.invalidateQueries({ queryKey: queryKeys.projectGitStatus(projectId) });
      if (!result.ok) return;
      // Working tree is reset to HEAD on a real stash — every file row in
      // the tree may have changed. Drop the broad caches.
      qc.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
      qc.invalidateQueries({ queryKey: ["fs-list", projectId] });
    },
  });
}

export function useGitStashPushWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    GitStashPushResult,
    Error,
    { workspaceId: string; body?: GitStashPushBody }
  >({
    mutationFn: ({ workspaceId, body }) =>
      gitStashPush("workspaces", workspaceId, body),
    onSuccess: (result, { workspaceId }) => {
      qc.invalidateQueries({
        queryKey: gitStashQueryKey("workspaces", workspaceId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.workspaceGitStatus(workspaceId),
      });
      if (!result.ok) return;
      qc.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
      qc.invalidateQueries({ queryKey: fsListQueryKey(workspaceId, "") });
    },
  });
}

// ─── Pop ──────────────────────────────────────────────────────────────────

export function useGitStashPopProject() {
  const qc = useQueryClient();
  return useMutation<
    GitStashPopResult,
    Error,
    { projectId: string; body: GitStashPopBody; affectedPaths?: string[] }
  >({
    mutationFn: ({ projectId, body }) => gitStashPop("projects", projectId, body),
    onSuccess: (_result, { projectId, affectedPaths }) => {
      // Invalidate broad caches regardless of `ok` — on conflict the
      // working tree still has unresolved markers the user needs to see.
      qc.invalidateQueries({ queryKey: gitStashQueryKey("projects", projectId) });
      qc.invalidateQueries({ queryKey: queryKeys.projectGitStatus(projectId) });
      qc.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
      qc.invalidateQueries({ queryKey: ["fs-list", projectId] });
      if (affectedPaths) {
        for (const path of affectedPaths) {
          qc.invalidateQueries({ queryKey: projectFileQueryKey(projectId, path) });
        }
      }
    },
  });
}

export function useGitStashPopWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    GitStashPopResult,
    Error,
    { workspaceId: string; body: GitStashPopBody; affectedPaths?: string[] }
  >({
    mutationFn: ({ workspaceId, body }) =>
      gitStashPop("workspaces", workspaceId, body),
    onSuccess: (_result, { workspaceId, affectedPaths }) => {
      qc.invalidateQueries({
        queryKey: gitStashQueryKey("workspaces", workspaceId),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.workspaceGitStatus(workspaceId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
      qc.invalidateQueries({ queryKey: fsListQueryKey(workspaceId, "") });
      if (affectedPaths) {
        for (const path of affectedPaths) {
          qc.invalidateQueries({
            queryKey: workspaceFileQueryKey(workspaceId, path),
          });
        }
      }
    },
  });
}

// ─── Drop ─────────────────────────────────────────────────────────────────

export function useGitStashDropProject() {
  const qc = useQueryClient();
  return useMutation<
    GitStashDropResult,
    Error,
    { projectId: string; ref: string }
  >({
    mutationFn: ({ projectId, ref }) => gitStashDrop("projects", projectId, ref),
    onSuccess: (_result, { projectId }) => {
      // Drop only changes the stash list — working tree is untouched.
      qc.invalidateQueries({ queryKey: gitStashQueryKey("projects", projectId) });
    },
  });
}

export function useGitStashDropWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    GitStashDropResult,
    Error,
    { workspaceId: string; ref: string }
  >({
    mutationFn: ({ workspaceId, ref }) =>
      gitStashDrop("workspaces", workspaceId, ref),
    onSuccess: (_result, { workspaceId }) => {
      qc.invalidateQueries({
        queryKey: gitStashQueryKey("workspaces", workspaceId),
      });
    },
  });
}
