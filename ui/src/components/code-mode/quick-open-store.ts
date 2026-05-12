/**
 * Quick-Open file index — a flat list of every project-relative file
 * path the operator can fuzzy-match against from the Cmd+P modal.
 *
 * Why a separate store from the file-tree's `useFsTree`?
 *   - The file-tree is *lazy* — it loads one directory level at a time
 *     so a deep project doesn't pay the round-trips up-front. Quick-Open
 *     wants the *whole* index so fzy can score across the entire repo
 *     in one pass.
 *   - The index is keyed on `projectId` so a project swap on
 *     `<ProjectCodeMode key={projectId}>` doesn't leak the prior
 *     project's paths through the modal.
 *   - We hold a `fetchedAt` timestamp so re-opening the modal within a
 *     30-second window reuses the cached snapshot — operators iterate
 *     on Cmd+P frequently, and a snapshot that's a few seconds stale is
 *     functionally fresh enough to pick a file. Beyond the window we
 *     refresh transparently in the background while still rendering the
 *     stale list so there is never a blank flash.
 *
 * The walker is **not** a real-time index — `fs.changed` frames don't
 * patch it. A renamed-on-disk file shows up the next time the cache
 * window expires; we treat the modal as a best-effort surface, not a
 * source-of-truth view. (The file-tree handles live updates already;
 * we trade a bit of staleness for one fewer subscription path.)
 *
 * Concurrency: the walker runs `WALKER_CONCURRENCY` directory listings
 * in parallel and stops descending into entries flagged `ignored:true`
 * by the daemon (gitignored / dotfiles already filtered server-side).
 * The cap protects the daemon from a fan-out storm on a deep repo.
 */

import { create } from "zustand";

import { fetchFsList } from "@/lib/api/fs";

/** Cache TTL — beyond this the next `requestIndex()` triggers a refresh. */
export const QUICK_OPEN_CACHE_TTL_MS = 30_000;

/** How many concurrent fs/list calls the walker runs at peak. */
const WALKER_CONCURRENCY = 6;

/**
 * Hard ceiling on the number of files we'll surface to the modal —
 * anything past this is silently dropped from the index. 50k is well
 * over what the spec's "50k entries" reference scenario asks for and
 * keeps the score loop bounded for very deep / generated trees.
 */
const MAX_INDEX_ENTRIES = 50_000;

export interface QuickOpenIndexState {
  /** Project id this index belongs to. `null` until the first request. */
  projectId: string | null;
  /** All file paths relative to the project root, deduped and unsorted. */
  paths: readonly string[];
  /** Epoch-ms timestamp of the most recent successful fetch; 0 when never. */
  fetchedAt: number;
  /** True while a walk is in flight. */
  isLoading: boolean;
  /** Last error code from a failed root listing, if any. */
  error: string | null;
}

export interface QuickOpenIndexStore extends QuickOpenIndexState {
  /**
   * Ensure an index is available for `projectId`. Reuses a cached
   * snapshot when the cache window hasn't expired; otherwise schedules
   * a walk in the background. Always resolves immediately — the
   * returned promise is for tests that want to await the walk
   * completion.
   */
  requestIndex: (projectId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Drop the index — used on project unmount. */
  clear: () => void;
  /** Test seam: replace the underlying lister. Production code never calls. */
  __setListerForTests: (
    fn: (projectId: string, path: string) => Promise<{ ok: true; entries: ReadonlyArray<{ name: string; type: "file" | "dir"; ignored: boolean; hasChildren?: boolean }>; truncated: boolean } | { ok: false; error_code: string }>,
  ) => void;
  /** Test seam: reset to initial state. */
  __resetForTests: () => void;
}

const initialState: QuickOpenIndexState = {
  projectId: null,
  paths: [],
  fetchedAt: 0,
  isLoading: false,
  error: null,
};

type Lister = (
  projectId: string,
  path: string,
) => Promise<
  | {
      ok: true;
      entries: ReadonlyArray<{
        name: string;
        type: "file" | "dir";
        ignored: boolean;
        hasChildren?: boolean;
      }>;
      truncated: boolean;
    }
  | { ok: false; error_code: string }
>;

const defaultLister: Lister = async (projectId, path) => {
  const res = await fetchFsList(projectId, path);
  if (res.ok) {
    return {
      ok: true,
      entries: res.entries.map((e) => ({
        name: e.name,
        type: e.type,
        ignored: e.ignored,
        hasChildren: e.hasChildren,
      })),
      truncated: res.truncated,
    };
  }
  return { ok: false, error_code: res.error_code };
};

/**
 * Walk the project's filesystem breadth-first, collecting every
 * non-ignored file path into a flat array. Bounded by `WALKER_CONCURRENCY`
 * outstanding listings and `MAX_INDEX_ENTRIES` total paths.
 *
 * Exported for the unit test that exercises the walk independently of
 * the Zustand store — passing in a fake lister is the cleanest way to
 * verify the BFS, the ignore-skip rule, and the cap.
 */
export async function walkProjectFiles(
  projectId: string,
  lister: Lister,
): Promise<{ paths: string[]; error: string | null }> {
  const collected: string[] = [];
  const queue: string[] = [""];
  let inFlight = 0;
  let firstError: string | null = null;

  return new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve({ paths: collected, error: firstError });
    };

    const pump = () => {
      // Drain pending dirs while we have headroom.
      while (
        inFlight < WALKER_CONCURRENCY &&
        queue.length > 0 &&
        collected.length < MAX_INDEX_ENTRIES
      ) {
        const dir = queue.shift()!;
        inFlight += 1;
        void lister(projectId, dir)
          .then((res) => {
            if (res.ok) {
              for (const entry of res.entries) {
                if (entry.ignored) continue;
                const childPath = dir
                  ? `${dir}/${entry.name}`
                  : entry.name;
                if (entry.type === "dir") {
                  queue.push(childPath);
                } else if (collected.length < MAX_INDEX_ENTRIES) {
                  collected.push(childPath);
                }
              }
            } else if (firstError === null && dir === "") {
              // Only the root failure is fatal — a permission error on a
              // sub-directory just leaves that subtree empty.
              firstError = res.error_code;
            }
          })
          .catch((err: unknown) => {
            if (firstError === null && dir === "") {
              firstError =
                err instanceof Error ? err.message : "fs_internal_error";
            }
          })
          .finally(() => {
            inFlight -= 1;
            if (queue.length === 0 && inFlight === 0) finish();
            else pump();
          });
      }
      // We may have hit the cap mid-drain; if nothing's outstanding,
      // resolve right away.
      if (inFlight === 0 && queue.length === 0) finish();
    };

    pump();
  });
}

let lister: Lister = defaultLister;

/**
 * Module-scoped guard so a duplicate `requestIndex` call (e.g. two
 * mounts firing simultaneously) coalesces onto a single in-flight walk
 * instead of issuing two parallel BFS passes that would race on the
 * `set()` calls below.
 */
let inFlightWalk: { projectId: string; promise: Promise<void> } | null = null;

export const useQuickOpenIndexStore = create<QuickOpenIndexStore>(
  (set, get) => ({
    ...initialState,

    requestIndex: async (
      projectId: string,
      opts: { force?: boolean } = {},
    ) => {
      const state = get();
      const now = Date.now();
      const fresh =
        state.projectId === projectId &&
        state.fetchedAt > 0 &&
        now - state.fetchedAt < QUICK_OPEN_CACHE_TTL_MS;

      if (!opts.force && fresh) {
        return;
      }

      // Coalesce concurrent requests for the same project.
      if (inFlightWalk && inFlightWalk.projectId === projectId) {
        await inFlightWalk.promise;
        return;
      }

      // Project swap: clear the prior index up-front so the modal
      // doesn't render last-project paths while the new walk runs.
      if (state.projectId !== projectId) {
        set({
          projectId,
          paths: [],
          fetchedAt: 0,
          error: null,
          isLoading: true,
        });
      } else {
        set({ isLoading: true, error: null });
      }

      const promise = walkProjectFiles(projectId, lister).then(
        ({ paths, error }) => {
          // Guard against a project swap landing while the walk was
          // running — the post-swap requestIndex already cleared the
          // state, and we mustn't smear stale paths over it.
          const cur = get();
          if (cur.projectId !== projectId) return;
          set({
            projectId,
            paths,
            fetchedAt: error ? 0 : Date.now(),
            isLoading: false,
            error,
          });
        },
      );

      inFlightWalk = { projectId, promise };
      try {
        await promise;
      } finally {
        if (inFlightWalk && inFlightWalk.projectId === projectId) {
          inFlightWalk = null;
        }
      }
    },

    clear: () => {
      set({ ...initialState });
    },

    __setListerForTests: (fn) => {
      lister = fn;
    },

    __resetForTests: () => {
      lister = defaultLister;
      inFlightWalk = null;
      set({ ...initialState });
    },
  }),
);
