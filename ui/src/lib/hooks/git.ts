import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  gitDiscardProject,
  gitDiscardWorkspace,
  gitFetchProject,
  gitFetchWorkspace,
  type GitDiscardBody,
  type GitDiscardResult,
  type GitFetchBody,
  type GitFetchResult,
} from "../api/git";
import { fsListQueryKey, projectFileQueryKey, workspaceFileQueryKey } from "./fs";
import { queryKeys } from "./core";

/**
 * Mutation hooks for the source-control "Discard" and "Fetch" buttons.
 *
 * Both operations always resolve with HTTP 200 — the structured failure
 * shape (`ok: false, reason: ...`) flows through verbatim, so the caller
 * inspects `result.ok` to branch between toast copy variants. A 422
 * (malformed body) surfaces as a thrown Error and lands on `onError`.
 *
 * Cache invalidation policy:
 *   - **Discard success** — the working tree changed on disk. Invalidate
 *     `git-status` (the porcelain row vanishes), `projectTree` /
 *     `workspace` (the tree may decorate file rows by dirty state), and
 *     the per-file read caches keyed by the discarded paths so any open
 *     editor tab refetches its bytes. The fs-list cache is invalidated
 *     by parent dir prefix because we don't know which dirs the discard
 *     touched without re-walking — broad-prefix invalidate is correct
 *     and cheap (TanStack only refetches active queries).
 *   - **Fetch success** — only remote-tracking refs changed; the working
 *     tree is untouched. Invalidate `git-status` (so any ahead/behind
 *     header rerenders) and the project/workspace query (which carries
 *     branch + upstream tracking metadata), nothing else.
 *   - **Structured failure / network error** — invalidate `git-status`
 *     so the porcelain peek surfaces any side effects git may have
 *     made (partial discard / partial fetch are both possible). We do
 *     NOT invalidate file caches on failure — nothing changed on disk
 *     for the operator-visible fast path, and an over-eager refetch
 *     would just thrash.
 */

// --- Project mutations ----------------------------------------------------

export function useGitDiscardProject() {
  const queryClient = useQueryClient();
  return useMutation<
    GitDiscardResult,
    Error,
    { projectId: string; body: GitDiscardBody }
  >({
    mutationFn: ({ projectId, body }) => gitDiscardProject(projectId, body),
    onSuccess: (result, { projectId, body }) => {
      // Always invalidate the porcelain peek — it reflects the discard
      // outcome regardless of `ok`.
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectGitStatus(projectId),
      });
      if (!result.ok) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
      // Drop any cached file bytes for the paths we just reverted so an
      // open editor tab notices the on-disk change (the tab's reload
      // banner mirrors the sha-conflict path from M00 slice 01).
      for (const path of body.paths) {
        queryClient.invalidateQueries({
          queryKey: projectFileQueryKey(projectId, path),
        });
      }
      // The fs-list cache is keyed by directory path; we don't know which
      // dirs were touched without re-walking, so we drop everything for
      // this project. TanStack only refetches active queries — inactive
      // ones just lose their cached payload.
      queryClient.invalidateQueries({
        queryKey: ["fs-list", projectId],
      });
    },
  });
}

export function useGitFetchProject() {
  const queryClient = useQueryClient();
  return useMutation<
    GitFetchResult,
    Error,
    { projectId: string; body?: GitFetchBody }
  >({
    mutationFn: ({ projectId, body }) => gitFetchProject(projectId, body),
    onSuccess: (result, { projectId }) => {
      if (!result.ok) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectGitStatus(projectId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });
}

// --- Workspace mutations --------------------------------------------------

export function useGitDiscardWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<
    GitDiscardResult,
    Error,
    { workspaceId: string; body: GitDiscardBody }
  >({
    mutationFn: ({ workspaceId, body }) =>
      gitDiscardWorkspace(workspaceId, body),
    onSuccess: (result, { workspaceId, body }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceGitStatus(workspaceId),
      });
      if (!result.ok) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
      for (const path of body.paths) {
        queryClient.invalidateQueries({
          queryKey: workspaceFileQueryKey(workspaceId, path),
        });
      }
      // The fs-list query key is `["fs-list", projectId, path]` — we do
      // not have a workspace-fs-list equivalent yet (the workspace SCM
      // surface only mounts on the project tree today). Reserve the
      // slot so a future workspace tree picks it up via the same prefix
      // invalidate pattern used for projects.
      queryClient.invalidateQueries({ queryKey: fsListQueryKey(workspaceId, "") });
    },
  });
}

export function useGitFetchWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<
    GitFetchResult,
    Error,
    { workspaceId: string; body?: GitFetchBody }
  >({
    mutationFn: ({ workspaceId, body }) => gitFetchWorkspace(workspaceId, body),
    onSuccess: (result, { workspaceId }) => {
      if (!result.ok) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceGitStatus(workspaceId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
    },
  });
}
