/**
 * QuickOpen — VSCode-style Cmd+P modal for jumping to a file by fuzzy
 * name match. Mounts on the project-detail Code-mode shell; renders
 * nothing while closed.
 *
 * Behaviour contract (matches the slice spec):
 *   - Empty input  → top 100 paths in case-insensitive alphabetical order.
 *   - Non-empty    → fzy-scored, top 100 entries (zero-score rows dropped).
 *   - ↑/↓          → move the selection. Wraps at the ends.
 *   - Enter        → `tabStore.openTab(selected.path)` and close.
 *                    Note: the on-screen contract says "openTab(selected.path)"
 *                    — the editor-tabs reducer takes a path and dedupes
 *                    by path so pressing Enter on an already-open file
 *                    just focuses its tab.
 *   - Esc          → close, no-op.
 *
 * Visual structure:
 *
 *     ┌──────────────────────────────────────────┐
 *     │ [search input ↩ Enter to open]           │
 *     ├──────────────────────────────────────────┤
 *     │ src/foo/bar.ts          (monospace, dim) │
 *     │ src/baz.ts                               │
 *     │ …up to 100 rows…                         │
 *     ├──────────────────────────────────────────┤
 *     │ <empty-state when 0 matches>             │
 *     └──────────────────────────────────────────┘
 *
 * Test-id contract:
 *   - `quick-open-dialog`     — root dialog content.
 *   - `quick-open-input`      — the search <input>.
 *   - `quick-open-list`       — wrapper around the result rows.
 *   - `quick-open-row`        — each result row; `data-path` carries the
 *                                full project-relative path. `data-active`
 *                                is `"true"` on the highlighted row.
 *   - `quick-open-empty`      — empty-state placeholder when no matches.
 *   - `quick-open-loading`    — placeholder while the index is empty
 *                                AND the walk is in flight.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hasMatch, score, SCORE_MIN } from "fzy.js";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { useEditorTabsStore } from "./tab-store";
import { useQuickOpenIndexStore } from "./quick-open-store";

/** How many results to surface — both empty-input and fuzzy paths share this. */
export const QUICK_OPEN_RESULT_CAP = 100;

export interface QuickOpenProps {
  /** Project the modal is operating on; required to fetch the index. */
  projectId: string;
  /** Whether the modal is mounted/visible. */
  open: boolean;
  /** Fired when the modal asks to be dismissed (Esc, backdrop, Enter). */
  onOpenChange: (next: boolean) => void;
}

/**
 * Score and sort the index against the query. Pure — exported so the
 * unit test can verify the ranking contract without rendering the
 * dialog.
 */
export function rankPaths(
  paths: readonly string[],
  query: string,
  cap: number = QUICK_OPEN_RESULT_CAP,
): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // Empty query: alpha-sort, case-insensitive. Stable on equal keys
    // (sort() is stable in V8) so the order is deterministic for
    // snapshot comparisons.
    return [...paths]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .slice(0, cap);
  }
  // fzy.js scores `(needle, haystack)` — argument order mirrors the C
  // `fzy` binary, NOT JavaScript's `String#includes`. We pre-filter
  // with the cheap `hasMatch` so the more expensive DP scorer doesn't
  // run on the >99% of haystacks that can't possibly match.
  const scored: Array<{ path: string; score: number; idx: number }> = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    if (!hasMatch(trimmed, path)) continue;
    const s = score(trimmed, path);
    if (s === SCORE_MIN) continue;
    scored.push({ path, score: s, idx: i });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return scored.slice(0, cap).map((r) => r.path);
}

export function QuickOpen({
  projectId,
  open,
  onOpenChange,
}: QuickOpenProps) {
  const paths = useQuickOpenIndexStore((s) => s.paths);
  const isLoading = useQuickOpenIndexStore((s) => s.isLoading);
  const requestIndex = useQuickOpenIndexStore((s) => s.requestIndex);

  const openEditorTab = useEditorTabsStore((s) => s.open);

  // Pre-fetch the index on Code mode mount (in the background). The
  // store is responsible for cache-window dedup — calling `requestIndex`
  // on every QuickOpen mount when the index is fresh is a no-op.
  useEffect(() => {
    if (!projectId) return;
    void requestIndex(projectId);
    // We deliberately depend on `projectId` only — `requestIndex` is a
    // stable Zustand reference, and re-firing on its identity would
    // double-fetch on every render.
  }, [projectId, requestIndex]);

  // On modal open, refresh if the cache has aged past the TTL. The
  // store dedupes internally; we just unconditionally call.
  useEffect(() => {
    if (!open || !projectId) return;
    void requestIndex(projectId);
  }, [open, projectId, requestIndex]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset query + selection on each open so a re-open never inherits a
  // stale state from the prior invocation.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const results = useMemo(() => rankPaths(paths, query), [paths, query]);

  // Clamp the active index whenever the result list shrinks. Without
  // this, deleting a character that pruned the list to 3 rows would
  // leave a stale index pointing past the end.
  useEffect(() => {
    if (results.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((cur) => {
      if (cur < 0) return 0;
      if (cur >= results.length) return results.length - 1;
      return cur;
    });
  }, [results.length]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const commit = useCallback(
    (path: string) => {
      openEditorTab(path);
      onOpenChange(false);
    },
    [openEditorTab, onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (results.length === 0) return;
        setActiveIndex((cur) => (cur + 1) % results.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (results.length === 0) return;
        setActiveIndex((cur) =>
          cur <= 0 ? results.length - 1 : cur - 1,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const target = results[activeIndex];
        if (target) commit(target);
        return;
      }
      // Esc bubbles to Radix and closes the dialog naturally — no-op
      // here so we don't pre-empt that path.
    },
    [results, activeIndex, commit],
  );

  // Auto-scroll the active row into view. Using `block: "nearest"` so
  // the list doesn't yank when an off-screen row is selected via
  // arrow keys but stays put when the operator clicks an in-view row.
  // jsdom does not implement `scrollIntoView`, so guard the call —
  // the unit tests would otherwise crash on every selection move.
  useEffect(() => {
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-quick-open-index="${activeIndex}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="quick-open-dialog"
        // Hide the X close button — the modal is keyboard-driven and
        // the X slot would just consume vertical space.
        showCloseButton={false}
        // VSCode's quick-open is wider than the default sm:max-w-sm.
        // 600px lines up with most editor layouts and gives enough room
        // for two-column path display.
        className="top-[20%] max-w-[600px] gap-0 p-0 sm:max-w-[600px]"
        onOpenAutoFocus={(e) => {
          // Radix tries to focus the first focusable child; we want the
          // input every time so the operator can type immediately.
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {/* Both required by Radix for a11y; visually hidden so they
            don't add to the dialog chrome. */}
        <DialogTitle className="sr-only">Quick open file</DialogTitle>
        <DialogDescription className="sr-only">
          Type to fuzzy-find a file in this project. Enter to open, Esc
          to dismiss.
        </DialogDescription>
        <div className="border-b">
          <input
            ref={inputRef}
            data-testid="quick-open-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Search files by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "h-11 w-full bg-transparent px-3 text-sm outline-none",
              "placeholder:text-muted-foreground",
            )}
          />
        </div>
        <div
          ref={listRef}
          data-testid="quick-open-list"
          className="max-h-[360px] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            paths.length === 0 && isLoading ? (
              <div
                data-testid="quick-open-loading"
                className="px-3 py-6 text-center text-xs text-muted-foreground"
              >
                Indexing project files…
              </div>
            ) : (
              <div
                data-testid="quick-open-empty"
                className="px-3 py-6 text-center text-xs text-muted-foreground"
              >
                {query.trim().length === 0
                  ? "No files in project."
                  : "No matches."}
              </div>
            )
          ) : (
            results.map((path, idx) => (
              <button
                key={path}
                type="button"
                data-testid="quick-open-row"
                data-path={path}
                data-quick-open-index={idx}
                data-active={idx === activeIndex ? "true" : "false"}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => commit(path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                  "outline-none",
                  idx === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
              >
                <PathLabel path={path} />
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Render `path` as `<basename>  <dirname>` so the basename — what the
 * operator typed — is the visual focus and the directory drops back in
 * a dim secondary tier. For root-level files there's no directory so
 * we just render the basename.
 */
function PathLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  return (
    <>
      <span className="truncate font-mono">{name}</span>
      {dir && (
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {dir}
        </span>
      )}
    </>
  );
}
