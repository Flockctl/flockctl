import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useGitLog } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { GitTarget } from "./git-dropdown-button";
import { CommitRow } from "./CommitRow";

/**
 * Row count above which the commit list switches to a virtualised
 * renderer (audit-round-4 finding). Below this we keep the simple
 * `.map()` shape — easier to test, no measurable jank below ~100 rows.
 * Above it, "Load more" can accumulate thousands of rows over a long
 * session; virtualization keeps the DOM small regardless.
 */
const HISTORY_VIRTUALIZE_THRESHOLD = 100;

/**
 * Collapsible "History" section inside the Source Control panel.
 *
 * Behaviour:
 *   - Default collapsed. Expansion state persists in `localStorage`
 *     under {@link HISTORY_STORAGE_KEY} so a panel reload restores the
 *     user's last view without surprising them.
 *   - The infinite-query underneath is gated on `enabled = open` — we
 *     never spend a round-trip for a section the user hasn't asked to
 *     see. The hook's `enabled` then re-evaluates and fetches the first
 *     page on open.
 *   - Each row is { short_sha · subject · author · relative-time }. The
 *     subject is `truncate`d with a `title` tooltip that holds the full
 *     text. Author + ISO timestamp also expose tooltips for full info.
 *   - "Load more" surfaces while `next_cursor` is non-null. Clicking it
 *     advances the infinite query by one page; the button is replaced
 *     with a spinner while the fetch is in flight.
 *   - Click a row → navigate to the commit-detail tab. The deep-link
 *     shape (`/projects/:id/git/commit/:sha`) is wired in slice 01;
 *     this component is forward-compatible with whichever URL slice 01
 *     ships — we only own the navigation call.
 *
 * Test-id contract (in addition to the {@link CommitRow} ids):
 *   - `scm-history-toggle`       — disclosure trigger (also exposed by
 *                                   the parent panel for the collapsed
 *                                   default state — we re-emit it here
 *                                   when the section is mounted inline).
 *   - `scm-history`              — body container, rendered while open.
 *   - `scm-history-list`         — `<ul>` of rows.
 *   - `scm-history-empty`        — "No commits yet." copy on an empty repo.
 *   - `scm-history-error`        — inline error banner (failure path).
 *   - `scm-history-loading`      — first-page spinner.
 *   - `scm-history-load-more`    — Load-more button (visible while
 *                                   `next_cursor` is non-null).
 *   - `scm-history-loading-more` — spinner that replaces the button while
 *                                   the next page is in flight.
 */

/**
 * `localStorage` key for the open/closed flag. Keyed on `target.kind` +
 * `target.id` so different projects / workspaces don't fight over a
 * single global toggle. Stored as `"1"` / `"0"` to keep the read trivial.
 *
 * Kept exported so unit tests can clear / pre-seed the value
 * deterministically.
 */
export function historyStorageKey(target: GitTarget): string {
  return `flockctl.scm.history.open.${target.kind}.${target.id}`;
}

export const HISTORY_STORAGE_KEY_PREFIX = "flockctl.scm.history.open.";

/**
 * Default page size. Matches the server's own default; surfaces here as
 * a constant so tests can reason about page boundaries without a magic
 * number drifting between layers.
 */
export const DEFAULT_HISTORY_LIMIT = 30;

/**
 * Read the saved open/closed flag. Wrapped so SSR (or jsdom without a
 * `localStorage` shim) doesn't blow up — falls back to `false` (the
 * documented default).
 */
function readPersistedOpen(target: GitTarget): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(historyStorageKey(target)) === "1";
  } catch {
    return false;
  }
}

function writePersistedOpen(target: GitTarget, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(historyStorageKey(target), open ? "1" : "0");
  } catch {
    /* private-browsing / quota-exceeded — fail silently; the toggle
     * still works in-memory for the current session. */
  }
}

export interface HistoryListProps {
  target: GitTarget;
  /**
   * Override the page size. Tests pass a small value to exercise the
   * "load more" boundary without seeding 31+ commits.
   */
  limit?: number;
  /**
   * Optional override for the navigate handler. Production code lets
   * the component navigate via `react-router-dom`; tests can pass a
   * stub to assert on the routing call without mounting a router.
   */
  onSelectCommit?: (sha: string) => void;
}

export function HistoryList({
  target,
  limit = DEFAULT_HISTORY_LIMIT,
  onSelectCommit,
}: HistoryListProps) {
  // Initial state from localStorage. We do this in the lazy initializer
  // so the value is read exactly once per mount — re-renders shouldn't
  // re-hit storage.
  const [open, setOpen] = useState<boolean>(() => readPersistedOpen(target));
  const navigate = useNavigate();

  // Persist on every flip. We persist on every state change rather than
  // on a unmount-time effect so a hard reload mid-flip preserves the
  // user's choice.
  useEffect(() => {
    writePersistedOpen(target, open);
  }, [target, open]);

  // The hook is the data-pump. Disabled until the section is open so
  // we don't pay for a round-trip the user hasn't asked for.
  const scope = target.kind === "project" ? "projects" : "workspaces";
  const query = useGitLog(scope, String(target.id), {
    enabled: open,
    limit,
  });

  // Flatten the page list into a single commits array. `useMemo` keeps
  // the array reference stable across re-renders that don't add a page.
  const commits = useMemo(() => {
    if (!query.data) return [];
    return query.data.pages.flatMap((p) => p.commits);
  }, [query.data]);

  const reason =
    query.error && (query.error as Error & { reason?: string }).reason;

  // Single timestamp reading for the whole list — keeps relative labels
  // consistent across rows. We refresh it whenever the query reports
  // fresh data via `dataUpdatedAt` (React Query's monotonic timestamp of
  // the last successful fetch); relative labels then drift forward in
  // sync with the data they describe instead of recomputing on every
  // unrelated re-render. Tying the reading to `dataUpdatedAt` also
  // satisfies the "components must be idempotent" lint — the value is
  // stable for a given query state.
  const now = useMemo(() => {
    if (query.dataUpdatedAt > 0) return query.dataUpdatedAt;
    // Fallback for the closed / pre-first-fetch state where dataUpdatedAt
    // is still 0. The relative labels rendered against this fallback are
    // never visible to the user (the section is collapsed or showing the
    // loader), but TypeScript / the renderer still needs a number.
    // eslint-disable-next-line react-hooks/purity -- bootstrap-only fallback; never visible.
    return Date.now();
  }, [query.dataUpdatedAt]);

  const handleSelect = useCallback(
    (sha: string) => {
      if (onSelectCommit) {
        onSelectCommit(sha);
        return;
      }
      // Slice 01 owns the URL shape. We pick the canonical
      // `/{scope}/{id}/git/commit/{sha}` form — slice 01's tabs router
      // is documented to handle it, and a 404 for a sha-typo here is
      // a slice-01 concern, not ours.
      navigate(`/${scope}/${target.id}/git/commit/${sha}`);
    },
    [navigate, onSelectCommit, scope, target.id],
  );

  return (
    <div className="border-t">
      <button
        type="button"
        data-testid="scm-history-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden />
        )}
        <History className="h-3.5 w-3.5" aria-hidden />
        History
      </button>
      {open && (
        <div data-testid="scm-history" className="flex max-h-[40vh] flex-col">
          {/* Loading state — first page is in flight. */}
          {query.isLoading && (
            <div
              data-testid="scm-history-loading"
              className={cn(
                "flex items-center justify-center py-6 text-muted-foreground",
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}

          {/* Error state — server returned ok:false or fetch threw. */}
          {query.isError && !query.isLoading && (
            <p
              data-testid="scm-history-error"
              role="alert"
              className="px-3 py-3 text-xs text-destructive"
            >
              {historyErrorCopy(reason ?? null)}
            </p>
          )}

          {/* Happy path — list of rows + load-more. */}
          {!query.isLoading && !query.isError && (
            <>
              {commits.length === 0 ? (
                <p
                  data-testid="scm-history-empty"
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No commits yet.
                </p>
              ) : commits.length > HISTORY_VIRTUALIZE_THRESHOLD ? (
                <VirtualisedCommitList
                  commits={commits}
                  now={now}
                  onSelect={handleSelect}
                />
              ) : (
                <ul
                  data-testid="scm-history-list"
                  className="overflow-y-auto"
                >
                  {commits.map((commit) => (
                    <CommitRow
                      key={commit.sha}
                      commit={commit}
                      relativeTime={relativeFromEpochSeconds(commit.ts, now)}
                      isoTime={isoFromEpochSeconds(commit.ts)}
                      onClick={handleSelect}
                    />
                  ))}
                </ul>
              )}

              {/* Load more — only while the server says there is more
                  to walk. Spinner replaces it during fetch so the row
                  count doesn't shift mid-click. */}
              {query.hasNextPage && (
                <div className="border-t px-3 py-2">
                  {query.isFetchingNextPage ? (
                    <div
                      data-testid="scm-history-loading-more"
                      className="flex items-center justify-center"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs"
                      data-testid="scm-history-load-more"
                      onClick={() => query.fetchNextPage()}
                    >
                      Load more
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Virtualised commit list (audit-round-4) ────────────────────────────
//
// Only the visible viewport (+ overscan) is mounted in the DOM. We use
// `@tanstack/react-virtual` (already a dep used by chats / task logs /
// InlineDiff) and absolutely-position rows inside a phantom-height
// container. `measureElement` refines the per-row size estimate so
// subject-wrap lines don't make the scrollbar lie.

import type { GitLogCommit } from "@/lib/types/project";

function VirtualisedCommitList({
  commits,
  now,
  onSelect,
}: {
  commits: GitLogCommit[];
  now: number;
  /** Same signature as the static-path's `handleSelect` — takes the
   *  commit SHA so the parent can route to the commit-detail page. */
  onSelect: (sha: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 12,
  });
  return (
    <div
      ref={scrollRef}
      data-testid="scm-history-list"
      data-virtualised="true"
      className="overflow-y-auto"
      style={{ maxHeight: "60vh" }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vItem) => {
          const commit = commits[vItem.index];
          if (!commit) return null;
          return (
            <div
              key={commit.sha}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <CommitRow
                commit={commit}
                relativeTime={relativeFromEpochSeconds(commit.ts, now)}
                isoTime={isoFromEpochSeconds(commit.ts)}
                onClick={onSelect}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Format a unix-epoch-seconds timestamp as a coarse "Xs/m/h/d ago"
 * label. Mirrors the granularity of {@link timeAgo} in `lib/utils.ts`
 * but takes seconds (the format the server emits via `%at`) rather
 * than a date-string. Surfaced separately so the parent owns the
 * `Date.now()` reading and every row in a render shares one.
 */
export function relativeFromEpochSeconds(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const seconds = Math.floor(now / 1000 - ts);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * ISO-8601 stringifier for the row's `title` tooltip. The user gets the
 * exact author timestamp on hover without us pulling in a date-format
 * library.
 */
export function isoFromEpochSeconds(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts * 1000).toISOString();
}

function historyErrorCopy(reason: string | null): string {
  switch (reason) {
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Path no longer exists on disk.";
    case "bad_revision":
      return "Could not walk history (bad revision).";
    case "timeout":
      return "Loading history timed out.";
    default:
      return "Could not load commit history.";
  }
}
