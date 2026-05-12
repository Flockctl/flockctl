import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { gitStatusProject } from "@/lib/api/projects";
import { useWsConnected } from "@/lib/global-ws";
import type { GitStatusResult } from "@/lib/types/project";

/**
 * Single-character status code surfaced as a per-row badge on the file
 * tree. Derived from the `XY` porcelain pair (`index` + `worktree`)
 * with a fixed precedence so each path collapses to exactly one code:
 *
 *   - `??` — untracked (porcelain `? ?`).
 *   - `U`  — unmerged / conflicted (any `U` on either side, plus the
 *            symmetric `AA` / `DD` cases that porcelain uses for
 *            "both added" / "both deleted").
 *   - `M` / `A` / `D` — modified / added / deleted. Worktree wins over
 *            index when both are non-space, mirroring the convention
 *            used by VS Code's SCM gutter (the operator cares more
 *            about "what is on disk now" than "what is staged").
 *
 * Anything else (renames, copies, ignored, clean) returns `null` and
 * the row stays badge-less. The Map<path, status> never carries a
 * `null` entry — callers can treat membership as "has a badge".
 *
 * NOTE: this is intentionally a small subset of porcelain status. The
 * source-control rail's Commit dialog renders the full XY pair; the
 * tree only needs the coarse colour bucket.
 */
export type GitTreeStatus = "M" | "A" | "D" | "U" | "??";

/**
 * Track `document.hidden` as a piece of React state so consumers can
 * pause polling while the tab is in the background. The Page
 * Visibility API fires `visibilitychange` on hide *and* on show, so a
 * single listener covers both directions.
 *
 * SSR-safe: returns `true` (and never registers a listener) when
 * `document` is undefined, so a Vitest run that never mounts the
 * component path doesn't trip on `ReferenceError: document is not
 * defined`.
 */
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Map one porcelain `XY` pair to the coarse {@link GitTreeStatus}
 * bucket the tree badge renders. Pure helper; exported for the unit
 * test, which exercises the precedence rules without going through
 * React Query.
 */
export function deriveTreeStatus(
  index: string,
  worktree: string,
): GitTreeStatus | null {
  // Untracked — porcelain encodes both columns as `?`.
  if (index === "?" && worktree === "?") return "??";
  // Conflict — `U` on either side, or the symmetric AA / DD codes.
  if (
    index === "U" ||
    worktree === "U" ||
    (index === "A" && worktree === "A") ||
    (index === "D" && worktree === "D")
  ) {
    return "U";
  }
  // Otherwise prefer worktree status, fall back to index. " " (space)
  // means "no change on that side"; we only care when at least one
  // side is non-space.
  const code = worktree !== " " ? worktree : index;
  if (code === "M" || code === "A" || code === "D") return code;
  return null;
}

/**
 * Polled `git status` peek used by the file tree to badge changed
 * rows. Returns a `Map<path, GitTreeStatus>` rather than the raw
 * porcelain entries so {@link TreeNode} can do an O(1) lookup per row
 * without re-running the precedence logic.
 *
 * Polling cadence (live-or-poll, picked dynamically):
 *   - **WS connected:** `refetchInterval: false` — invalidations
 *     arrive via the `git-status-changed` handler in
 *     `lib/handlers/git-status-changed.ts`. The query refetches
 *     reactively only when something actually moved, so we don't
 *     porcelain every 5 s for nothing.
 *   - **WS disconnected (or socket not yet driven):** 30 s when the
 *     tab is visible. Slower than the original 5 s because the
 *     fallback only kicks in during a network blip — and a 30 s
 *     porcelain is cheap.
 *   - **Tab hidden:** paused entirely (`refetchInterval: false`); the
 *     {@link useDocumentVisibility} listener restarts the cadence on
 *     resume.
 *
 * The structured failure shape (`ok: false`) collapses to an empty
 * map — the tree just renders without badges rather than surfacing a
 * banner; the Commit dialog's `useGitStatusProject` is the place
 * that actually shows the failure copy.
 *
 * **Live wiring.** A parent component (typically Code mode) must mount
 * `useGitStatusChangedHandler(projectId)` for the WS path to drive
 * invalidations — this hook only reads connection state, it does not
 * itself open the socket.
 */
export function useGitStatusForTree(projectId: string) {
  const visible = useDocumentVisibility();
  const wsConnected = useWsConnected();
  // When the live channel is up the polling cadence is silenced —
  // the `git-status-changed` handler invalidates this same query key
  // on every server-pushed event. Otherwise fall back to a 30 s
  // visible-only poll.
  const refetchInterval = !visible
    ? false
    : wsConnected
      ? false
      : 30_000;
  return useQuery({
    queryKey: ["git-status-tree", projectId],
    queryFn: () => gitStatusProject(projectId),
    enabled: !!projectId,
    refetchInterval,
    // `select` runs on every cache read; keep the loop tight. The
    // returned Map is a fresh object per refetch — React Query's
    // structural sharing falls back to "always new" for non-JSON
    // values, which is fine: consumers just react to identity change.
    select: (res: GitStatusResult): Map<string, GitTreeStatus> => {
      if (!res.ok) return new Map();
      const out = new Map<string, GitTreeStatus>();
      for (const e of res.entries) {
        const s = deriveTreeStatus(e.index, e.worktree);
        if (s) out.set(e.path, s);
      }
      return out;
    },
  });
}
