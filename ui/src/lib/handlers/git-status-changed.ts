/**
 * git-status-changed handler — reacts to the coalesced
 * `git-status-changed` WebSocket frame for a given project and
 * invalidates the two queries the UI uses to read git state:
 *
 *   1. `["git-status-tree", projectId]` — the porcelain peek the file
 *      tree consumes for per-row badges (M / A / D / U / ??).
 *
 *   2. `gitBranchesQueryKey("projects", projectId)` — the BranchPicker's
 *      branch list, which embeds the current branch + ahead/behind.
 *
 * No per-file detail is on the wire — the server-side watcher
 * collapses any change to `.git/HEAD`, `.git/index`, or
 * `.git/refs/heads/*` into a single envelope. The UI's correct response
 * is "refetch both queries"; React Query handles the de-dupe if the
 * data hasn't actually moved.
 *
 * Architecture mirrors `fs-changed.ts`: a pure `applyGitStatusChanged`
 * helper drives the cache so the unit test can exercise it without
 * standing up a real socket, and a thin `useGitStatusChangedHandler`
 * hook wires `globalWs.subscribeGit` to the apply call.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { globalWs, type GitStatusChangedFrame } from "../global-ws";
import { gitBranchesQueryKey } from "../hooks/git-branches";

/**
 * Apply a single `git-status-changed` frame to the React Query cache.
 * Exported pure so the unit test can drive the cache directly without
 * touching `globalWs`.
 */
export function applyGitStatusChanged(
  qc: QueryClient,
  frame: GitStatusChangedFrame,
): void {
  // The tree's porcelain peek lives at this exact key — see
  // `useGitStatusForTree` in `lib/hooks/git-status-tree.ts`.
  qc.invalidateQueries({
    queryKey: ["git-status-tree", frame.projectId],
  });
  qc.invalidateQueries({
    queryKey: gitBranchesQueryKey("projects", frame.projectId),
  });
}

/**
 * React hook — wires the project's git subscription to the apply
 * function. Mount once per Code-mode tab; unmount on tab close.
 *
 * Re-subscribes if `projectId` changes (e.g. the user switches
 * projects without remounting the page shell).
 */
export function useGitStatusChangedHandler(
  projectId: string | null | undefined,
): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    const unsub = globalWs.subscribeGit(projectId, (frame) => {
      applyGitStatusChanged(qc, frame);
    });
    return unsub;
  }, [projectId, qc]);
}
