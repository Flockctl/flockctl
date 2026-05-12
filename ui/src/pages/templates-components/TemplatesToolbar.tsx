import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * TemplatesToolbar — tag chips + per-page search input for `/templates`.
 *
 * The toolbar used to be chip-only — search lived only in the global ⌘K
 * palette. To match the rest of the library surfaces (Tasks, Projects,
 * Workspaces, Chats) every page now carries its own search input in the
 * toolbar row; ⌘K still works as the global cross-surface escape hatch.
 *
 *   1. **Tag filter** — `All`, then one chip per distinct tag the
 *      parent supplies. Active chip is encoded as `?tag=<slug>`; the
 *      canonical "All" state is the absence of the param so the URL
 *      stays clean (`/templates` rather than `/templates?tag=all`).
 *      Invalid `?tag=xxx` (stale slug, deleted tag) silently falls
 *      back to `all` plus a single `console.warn` for forensics.
 *
 *   2. **Search query** — typed into a native `<input>`, debounced 200 ms
 *      before being committed to `?q=` so a typing burst doesn't flood
 *      router state. Mirrors `useProjectsSearchQuery` /
 *      `useChatsSearchQuery` 1:1 so the typing UX is identical across
 *      pages.
 *
 * The component is presentational — it neither owns the template
 * rows nor fetches data. Parents read `tag` and `query` (via the
 * exported hooks or the `onTagChange` / `onSearchChange` callbacks)
 * and decide which rows to render. Centralising URL bookkeeping here
 * keeps the page free of `useSearchParams` boilerplate and lets us
 * test the URL contract in isolation.
 */

const TAG_PARAM = "tag";
const TAG_ALL = "all";
const QUERY_PARAM = "q";
const DEFAULT_DEBOUNCE_MS = 200;

const CHIP_BASE_CLASSES =
  "px-2.5 py-1 rounded-full text-[12.5px] cursor-pointer transition-colors";
const CHIP_ACTIVE_CLASSES = "bg-zinc-200 dark:bg-zinc-800 font-medium";
const CHIP_INACTIVE_CLASSES =
  "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600";

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

export const TEMPLATES_TAG_PARAM = TAG_PARAM;
export const TEMPLATES_TAG_ALL = TAG_ALL;

export interface TemplatesToolbarTag {
  /**
   * Stable identity used as the React key (often equal to `slug`).
   * Pass workspace `id` or any UUID for guaranteed stability across
   * re-orderings.
   */
  id: string | number;
  /** URL-safe slug — written to `?tag=` when active. */
  slug: string;
  /** Human-readable label rendered in the chip body. */
  name: string;
  /**
   * Optional count rendered after the label (e.g. `frontend 12`).
   * Omit for tags whose totals are noisy or expensive to compute.
   */
  count?: number;
}

/**
 * URL-backed tag-filter state for the `/templates` page.
 *
 * Returns the *resolved* tag (never an invalid URL value) plus a
 * setter that writes through to the URL with `replace: true` so
 * chip-clicking doesn't pollute browser history.
 *
 * `validValues` is the closed set of legal tag slugs; anything outside
 * it (including a stale slug for a tag the user has since deleted) is
 * treated as a fallback to `'all'`.  The fallback fires a single
 * `console.warn` per distinct invalid value so the UI can surface
 * forensics without spamming the console on every render.
 */
export function useTemplatesTagFilter(
  validValues: ReadonlyArray<string>,
): { tag: string; setTag: (next: string) => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(TAG_PARAM);

  const isInvalid =
    raw !== null && raw !== TAG_ALL && !validValues.includes(raw);
  const tag = raw === null || isInvalid ? TAG_ALL : raw;

  const lastWarnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isInvalid) return;
    if (lastWarnedRef.current === raw) return;
    lastWarnedRef.current = raw;
    console.warn(
      `[TemplatesToolbar] Invalid ?tag=${String(raw)}; falling back to '${TAG_ALL}'.`,
    );
  }, [raw, isInvalid]);

  const setTag = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          // Encode the canonical "All" state as the absence of the
          // param.  Two reasons: (a) `/templates` reads cleaner than
          // `/templates?tag=all`, and (b) the URL stays stable after
          // a "click All from another tag" round trip.
          if (next === TAG_ALL) params.delete(TAG_PARAM);
          else params.set(TAG_PARAM, next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { tag, setTag };
}

/**
 * Filter helper for the tag-chip predicate.  `tag === 'all'` returns
 * every row unchanged; otherwise the row is kept iff `row.tags`
 * contains the tag slug (case-insensitive).
 */
export function filterTemplatesByTag<T extends { tags?: ReadonlyArray<string> | null }>(
  rows: ReadonlyArray<T>,
  tag: string,
): T[] {
  if (tag === TAG_ALL || tag === "") return [...rows];
  const needle = tag.toLowerCase();
  return rows.filter((row) => {
    const tags = row.tags ?? [];
    return tags.some((t) => t.toLowerCase() === needle);
  });
}

/**
 * Case-insensitive substring match on a template's `name` and
 * `description`. Mirrors the predicate shape of
 * `filterProjectsByQuery` / `filterTasksByQuery` so the four library
 * surfaces all narrow rows identically.
 *
 * Empty / whitespace-only queries return all rows in their original
 * order (a non-mutating copy so callers can pipe straight into `.map()`
 * without worrying about aliasing).
 */
export function filterTemplatesByQuery<
  T extends { name?: string | null; description?: string | null },
>(rows: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const name = (row.name ?? "").toLowerCase();
    const description = (row.description ?? "").toLowerCase();
    return name.includes(trimmed) || description.includes(trimmed);
  });
}

/**
 * URL-backed `?q=` state for the `/templates` page with debounced
 * commit. Carbon-copy of the same hook in `ProjectsToolbar` /
 * `ChatsToolbar` / `WorkspacesGrid` so typing UX stays identical
 * across pages.
 *
 * Returns:
 *   - `draft`        — what the input currently shows (uncommitted typing).
 *   - `query`        — what the URL holds (debounced commit).
 *   - `setDraft(v)`  — update the draft. After `debounceMs`, the draft is
 *                      committed to URL `?q=` using `replace: true` so
 *                      back/forward isn't polluted.
 */
export function useTemplatesSearchQuery(
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): {
  draft: string;
  query: string;
  setDraft: (next: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM) ?? "";

  const [draft, setDraftState] = useState<string>(urlQuery);

  // External URL changes (browser back, programmatic navigate) win over
  // the local draft, but only when the URL value actually moved — we
  // never blow away an in-flight typing session.
  const lastUrlRef = useRef<string>(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastUrlRef.current) {
      lastUrlRef.current = urlQuery;
      setDraftState(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === urlQuery) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (trimmed) params.set(QUERY_PARAM, trimmed);
          else params.delete(QUERY_PARAM);
          return params;
        },
        { replace: true },
      );
      lastUrlRef.current = trimmed;
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs, setSearchParams, urlQuery]);

  const setDraft = useCallback((next: string) => {
    setDraftState(next);
  }, []);

  return { draft, query: urlQuery, setDraft };
}

interface ChipProps {
  active: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
}

function Chip({ active, label, onClick, testId }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        CHIP_BASE_CLASSES,
        active ? CHIP_ACTIVE_CLASSES : CHIP_INACTIVE_CLASSES,
      )}
    >
      {label}
    </button>
  );
}

export interface TemplatesToolbarProps {
  /**
   * Total template count rendered inside the `All <count>` chip.
   * Omit (or pass `undefined`) to render `All` without a count.
   */
  totalCount?: number;
  /**
   * Distinct tag list, in render order.  The parent decides ordering
   * (alphabetical, by frequency, etc.) — the component honours it.
   */
  tags?: ReadonlyArray<TemplatesToolbarTag>;
  /**
   * Fired with the resolved tag value whenever it changes.  Value is
   * either `'all'` or one of the slugs from `tags[]`.  Invalid URL
   * values are coerced to `'all'` before the callback fires —
   * consumers never see garbage.
   */
  onTagChange?: (tag: string) => void;
  /**
   * Fired with the committed (debounced, trimmed) search query whenever
   * it changes. The string is already trimmed.
   */
  onSearchChange?: (query: string) => void;
  /**
   * Override the search debounce. Tests pin this to `0` (or use fake
   * timers) to keep timing deterministic; production uses 200 ms.
   */
  searchDebounceMs?: number;
  className?: string;
  "data-testid"?: string;
}

export function TemplatesToolbar({
  totalCount,
  tags = [],
  onTagChange,
  onSearchChange,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  className,
  "data-testid": testId,
}: TemplatesToolbarProps) {
  // The valid-values allow-list rebuilds whenever the tag set changes.
  // `useMemo` keeps the array reference stable across unrelated renders
  // so the hook's effect doesn't fire spuriously.
  const validValues = useMemo(() => tags.map((t) => t.slug), [tags]);
  const { tag, setTag } = useTemplatesTagFilter(validValues);

  // Mirror tag changes to the parent.  Use a ref to skip the synthetic
  // re-emit on parent re-render — consumers only want the event when
  // the value actually moves.
  const lastEmittedTagRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedTagRef.current === tag) return;
    lastEmittedTagRef.current = tag;
    onTagChange?.(tag);
  }, [tag, onTagChange]);

  // Search wiring — same debounce contract as the rest of the library
  // surfaces. The committed query is mirrored to the parent via the
  // `onSearchChange` callback (gated by a ref so we don't emit a
  // synthetic `""` on mount).
  const { draft, query, setDraft } = useTemplatesSearchQuery(searchDebounceMs);
  const lastEmittedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedQueryRef.current === query) return;
    lastEmittedQueryRef.current = query;
    onSearchChange?.(query);
  }, [query, onSearchChange]);

  return (
    <div
      data-testid={testId ?? "templates-toolbar"}
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5",
        className,
      )}
    >
      <div
        className="flex items-center gap-1.5 flex-wrap"
        data-testid="templates-toolbar-chips"
      >
        <Chip
          active={tag === TAG_ALL}
          label={typeof totalCount === "number" ? `All ${totalCount}` : "All"}
          onClick={() => setTag(TAG_ALL)}
          testId="tag-chip-all"
        />
        {tags.map((t) => (
          <Chip
            key={String(t.id)}
            active={tag === t.slug}
            label={
              typeof t.count === "number" ? `${t.name} ${t.count}` : t.name
            }
            onClick={() => setTag(t.slug)}
            testId={`tag-chip-${t.slug}`}
          />
        ))}
      </div>

      {/* Right-aligned search input — matches the placement of the search
          input on the Tasks filter row (rightmost slot of the filter bar). */}
      <div className="ml-auto">
        <input
          type="text"
          role="searchbox"
          placeholder="Search templates…"
          aria-label="Search templates"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={SEARCH_INPUT_CLASSES}
          data-testid="templates-search-input"
        />
      </div>
    </div>
  );
}

export default TemplatesToolbar;
