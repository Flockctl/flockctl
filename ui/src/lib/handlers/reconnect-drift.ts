/**
 * reconnect-drift handler — runs a per-tab sha refresh whenever the
 * shared WebSocket flips from disconnected → connected after a drop.
 *
 * **Why this is needed.** Live `fs.changed` frames cover the steady
 * state, but anything that landed on disk while the socket was offline
 * is invisible to the editor: there was no frame to drive the cache
 * invalidation, no banner to surface a dirty-vs-disk conflict. On
 * reconnect we'd otherwise quietly serve stale content out of the
 * React Query cache and the held-sha tracker.
 *
 * **What it does.** On every reconnect:
 *
 *   1. Invalidate the project's `git-status-tree` and `git-branches`
 *      queries once at the start. These are the two coalesced views
 *      the file tree + branch picker rely on, and a single invalidate
 *      is cheap regardless of whether they actually drifted.
 *
 *   2. Walk every open tab in `tabStore` and, for each `kind === "file"`
 *      tab, fetch the current sha via the project's fs/file endpoint.
 *      The walk is bounded to **4 concurrent fetches** by a tiny p-limit
 *      helper — enough to keep the daemon responsive without serialising
 *      the refresh on a slow link.
 *
 *   3. Compare the fresh sha against the held sha (read from the
 *      editor-tabs store, keyed by path):
 *        - same → noop.
 *        - drift + clean buffer → silently update buffer + heldSha via
 *          `useEditorTabsStore.setBuffer`. No banner.
 *        - drift + dirty buffer → raise a `{ kind: "changed", currentSha }`
 *          banner against the polymorphic-shell tab id.
 *        - file vanished (`fs_not_found`) → raise a `{ kind: "deleted" }`
 *          banner against the same tab id.
 *
 *   4. Diff tabs (`kind === "diff"`) are intentionally NOT walked. Their
 *      content is fully derived from server-side state that the
 *      `git-status-tree` invalidation already marks stale; the next
 *      mount of the diff query refetches.
 *
 * Network errors during the per-tab fetch are swallowed — the reconnect
 * itself proves the socket is back, and a transient hiccup against
 * fs/file should not leak per-tab error toasts. The next reconnect (or
 * a live `fs.changed` frame) will reconcile.
 *
 * **Tied to the global ws singleton.** The hook subscribes to
 * `globalWs.subscribeReconnect`, an edge-triggered event that does NOT
 * fire on the very first connect after process boot — there's no
 * "drift" relative to nothing.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { globalWs } from "../global-ws";
import { fetchProjectFile, type FsReadResponse } from "../api/fs";
import { gitBranchesQueryKey } from "../hooks/git-branches";
import {
  tabStore,
  useEditorTabsStore,
  type Tab,
} from "@/components/code-mode/tab-store";

/**
 * Tiny p-limit-style concurrency cap. Returns a function that wraps
 * `task` in a promise which resolves when an internal slot is free.
 * Production code uses `concurrency = 4`; tests can pin it to `1` for
 * deterministic ordering.
 *
 * Kept intentionally bare (no abort, no priority, no queue stats) — the
 * only consumer is the reconnect-drift walk. Importing `p-limit` for
 * twenty lines of behaviour would mean another dependency for the UI
 * bundle.
 */
export function makeLimit(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (concurrency < 1) throw new Error("concurrency must be >= 1");
  let active = 0;
  const queue: Array<() => void> = [];
  function release(): void {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        task().then(
          (value) => {
            release();
            resolve(value);
          },
          (err) => {
            release();
            reject(err);
          },
        );
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** Default concurrency cap for the production reconnect-drift walk. */
export const DRIFT_CONCURRENCY = 4;

/**
 * Resolve the per-tab held sha + dirty flag from the editor-tabs store.
 * Returns `null` when no editor buffer is open against the tab's path
 * (e.g. a freshly-restored `tabStore` entry whose Monaco hasn't mounted
 * yet) — the caller treats that as "skip, nothing to compare".
 */
function lookupEditorState(
  path: string,
): { editorTabId: string; heldSha: string; dirty: boolean } | null {
  const tabs = useEditorTabsStore.getState().tabs;
  const ed = tabs.find((t) => t.path === path);
  if (!ed) return null;
  return { editorTabId: ed.id, heldSha: ed.heldSha, dirty: ed.dirty };
}

/**
 * Apply a single tab's drift result. Pure with respect to React — the
 * caller passes the latest `FsReadResponse`; we only touch the
 * `tabStore` (banner) and the editor-tabs store (silent buffer update).
 *
 * Exported so the unit test can drive the cases directly without
 * standing up `fetchProjectFile`.
 */
export function applyDriftResult(tab: Tab, fresh: FsReadResponse): void {
  if (tab.kind !== "file") return;
  const ed = lookupEditorState(tab.path);

  if (!fresh.ok) {
    if (fresh.error_code === "fs_not_found") {
      tabStore.setBanner(tab.id, { kind: "deleted" });
    }
    // Other failure codes (binary, too_large, permission_denied, ...)
    // aren't drift — surface them only if/when the user navigates back
    // to the tab; the next live read will produce a precise UX.
    return;
  }

  // Partial reads don't ship from the drift walk (we never request a
  // range), but TypeScript needs the union narrowed. A `partial: true`
  // body would imply a stale request from a different code path —
  // treat it as no-op rather than fabricating a bogus full sha.
  if ("partial" in fresh && fresh.partial === true) return;

  if (!ed) return; // editor not mounted; nothing to reconcile.

  if (fresh.sha === ed.heldSha) return; // no drift.

  if (!ed.dirty) {
    // Clean buffer — silently roll forward. The editor's Monaco model
    // picks up the new content on the next render via the buffer +
    // heldSha sync point.
    useEditorTabsStore.getState().setBuffer(ed.editorTabId, fresh.content, fresh.sha);
    return;
  }

  // Dirty buffer — surface a banner the user must dismiss. We carry the
  // disk's current sha so a Reload click can short-circuit a re-read.
  tabStore.setBanner(tab.id, { kind: "changed", currentSha: fresh.sha });
}

/**
 * Walk every open tab and reconcile shas. Exported pure so the unit
 * test can swap a fake fetcher in without touching the network.
 *
 * @param qc           React Query client whose caches we invalidate.
 * @param projectIds   Project ids to invalidate `git-status-tree` /
 *                     `git-branches` for. Pass the union of every
 *                     project that has at least one open file tab —
 *                     callers typically derive this from `tabStore`.
 * @param fetcher      Used to fetch the latest sha for a single
 *                     `(projectId, path)` pair. Defaults to
 *                     `fetchProjectFile` in production; tests inject a
 *                     deterministic stub.
 * @param concurrency  Concurrency cap for the per-tab fetch. Defaults
 *                     to {@link DRIFT_CONCURRENCY}.
 */
export async function runDriftCheck(
  qc: QueryClient,
  options: {
    projectIds?: Iterable<string>;
    fetcher?: (projectId: string, path: string) => Promise<FsReadResponse>;
    concurrency?: number;
  } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetchProjectFile;
  const concurrency = options.concurrency ?? DRIFT_CONCURRENCY;
  const tabs = tabStore.getState().tabs;

  // Derive the project-id set from open file tabs if the caller didn't
  // pass one — keeps the hook layer thin (it doesn't have to care
  // about which projects own which tabs).
  const projectIds = new Set<string>(options.projectIds ?? []);
  if (!options.projectIds) {
    for (const t of tabs) {
      if (t.kind === "file") projectIds.add(t.projectId);
    }
  }

  // 1. Coalesced cache invalidations — once per project at the start.
  for (const projectId of projectIds) {
    qc.invalidateQueries({ queryKey: ["git-status-tree", projectId] });
    qc.invalidateQueries({ queryKey: gitBranchesQueryKey("projects", projectId) });
  }

  // 2. Per-tab sha refresh under a concurrency cap.
  const limit = makeLimit(concurrency);
  await Promise.all(
    tabs.map((tab) =>
      limit(async () => {
        if (tab.kind !== "file") return;
        try {
          const fresh = await fetcher(tab.projectId, tab.path);
          applyDriftResult(tab, fresh);
        } catch {
          // Network error during the drift walk — the WS reconnect
          // itself proves we're back online, so we expect the next
          // live `fs.changed` frame to reconcile this tab. Swallowing
          // the error keeps the walk going for sibling tabs.
        }
      }),
    ),
  );
}

/**
 * React hook — wires `globalWs.subscribeReconnect` to a {@link runDriftCheck}
 * call. Mount once at the Code-mode shell level (the hook is cheap and
 * idempotent — multiple mounts each subscribe a listener; the
 * runDriftCheck side effect is module-level via `tabStore`).
 *
 * The hook does NOT subscribe to `globalWs` for any project topic — it
 * only listens for connection-state edges. Mounting it on a page that
 * never opens a tab is harmless (the walk is over an empty list).
 */
export function useReconnectDriftHandler(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = globalWs.subscribeReconnect(() => {
      // Fire and forget — errors inside `runDriftCheck` are already
      // swallowed at the per-tab level, and a top-level rejection
      // (e.g. invalid query key) is non-fatal for the rest of the UI.
      void runDriftCheck(qc);
    });
    return unsub;
  }, [qc]);
}
