import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * FilterChips — workspace-scope filter row for `/projects` (slice
 * 23-02 T03).
 *
 * Three responsibilities, one place:
 *
 *   1. **Render the chip row.** `All <total>`, then one chip per
 *      workspace (`<ws.name> <count>`), then `Standalone <count>`.
 *      Active chip is `bg-zinc-200 dark:bg-zinc-800 font-medium`;
 *      inactive chips use `hover:bg-zinc-100 dark:hover:bg-zinc-800
 *      text-zinc-600`.
 *
 *   2. **Anchor the filter to the URL.** `?filter=` is the source of
 *      truth so reload / share / back-button stay in sync. Allowed
 *      values: `all` (also encoded as the absence of the param to
 *      keep the canonical URL clean), `standalone`, or any of the
 *      workspace slugs the parent passes in. Invalid values fall
 *      back to `all` and emit a single `console.warn` so a stale
 *      bookmark doesn't crash the page (see the slice's failure-mode
 *      contract: `Invalid ?filter=xxx → falls back to 'all' +
 *      console.warn`).
 *
 *   3. **Group-by dropdown placeholder.** Per slice spec only
 *      `By workspace` exists today — render a non-functional pill
 *      labelled `By workspace ▾` so the visual position is reserved
 *      for future modes (by-status, by-recent, etc.).
 *
 * The component is intentionally presentational + URL-bound — it
 * neither owns the project list nor knows how to filter it. The
 * parent reads `filter` (via {@link useProjectsFilter} or the
 * `onFilterChange` callback) and decides which projects to render.
 * Centralising URL bookkeeping here keeps the page free of
 * `useSearchParams` boilerplate and lets us test the URL contract in
 * isolation.
 */

export const FILTER_PARAM = "filter";
export const FILTER_ALL = "all";
export const FILTER_STANDALONE = "standalone";

export interface FilterChipsWorkspace {
  /** Stable identity from the workspace row. Used as the React key. */
  id: string | number;
  /** Human-readable name; rendered inside the chip. */
  name: string;
  /**
   * URL-safe slug. The component does NOT slugify the name itself —
   * the parent owns slug derivation so the chip values stay in sync
   * with the rest of the routing layer (e.g. `/projects?filter=work`
   * matching `/workspaces/work`).
   */
  slug: string;
  /** Project count to render after the workspace name. */
  count: number;
}

export interface FilterChipsProps {
  /** Number rendered inside the `All <count>` chip. */
  totalCount: number;
  /** Number rendered inside the `Standalone <count>` chip. */
  standaloneCount: number;
  /**
   * Workspace chips, in render order. The parent decides ordering
   * (alphabetical, by activity, etc.) — the component honours it.
   */
  workspaces: ReadonlyArray<FilterChipsWorkspace>;
  /**
   * Fired with the resolved filter value whenever it changes. The
   * value is one of: `'all'`, `'standalone'`, or a workspace slug
   * from `workspaces[]`. Invalid URL values are coerced to `'all'`
   * before the callback fires — consumers never see garbage.
   */
  onFilterChange?: (filter: string) => void;
  className?: string;
  "data-testid"?: string;
}

const CHIP_BASE_CLASSES =
  "px-2.5 py-1 rounded-full text-[12.5px] cursor-pointer transition-colors";
const CHIP_ACTIVE_CLASSES = "bg-zinc-200 dark:bg-zinc-800 font-medium";
const CHIP_INACTIVE_CLASSES =
  "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600";

const GROUP_BY_BUTTON_CLASSES =
  "ml-auto px-2.5 py-1 rounded-full text-[12.5px] text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-100 disabled:cursor-default flex items-center gap-1";

/**
 * URL-backed filter state for the `/projects` page.
 *
 * Returns the *resolved* filter (never an invalid URL value) plus a
 * setter that writes through to the URL with `replace: true` so
 * chip-clicking doesn't pollute browser history.
 *
 * `validValues` is the closed set of legal filter strings; anything
 * outside it (including a stale slug for a workspace the user has
 * since deleted) is treated as a fallback to `'all'`. The fallback
 * fires a single `console.warn` per distinct invalid value so the
 * UI can surface forensics without spamming the console on every
 * render.
 */
export function useProjectsFilter(
  validValues: ReadonlyArray<string>,
): { filter: string; setFilter: (next: string) => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(FILTER_PARAM);

  // Membership check: `all` is implicit when the param is absent, so
  // it's always valid; anything else has to be in the parent-supplied
  // allow-list.
  const isInvalid =
    raw !== null && raw !== FILTER_ALL && !validValues.includes(raw);
  const filter = raw === null || isInvalid ? FILTER_ALL : raw;

  // Warn once per distinct invalid value rather than on every render.
  // We track the last raw string we warned about so a flickering
  // re-render doesn't trigger a console spam.
  const lastWarnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isInvalid) return;
    if (lastWarnedRef.current === raw) return;
    lastWarnedRef.current = raw;
    console.warn(
      `[FilterChips] Invalid ?filter=${String(raw)}; falling back to '${FILTER_ALL}'.`,
    );
  }, [raw, isInvalid]);

  const setFilter = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          // Encode the canonical "All" state as the absence of the
          // param. Two reasons: (a) `/projects` reads cleaner than
          // `/projects?filter=all`, and (b) the URL stays stable after
          // a "click All from another filter" round trip.
          if (next === FILTER_ALL) params.delete(FILTER_PARAM);
          else params.set(FILTER_PARAM, next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { filter, setFilter };
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

export function FilterChips({
  totalCount,
  standaloneCount,
  workspaces,
  onFilterChange,
  className,
  "data-testid": testId,
}: FilterChipsProps) {
  // The valid-values allow-list rebuilds whenever the workspace set
  // changes (creation/deletion). `useMemo` keeps the array reference
  // stable across unrelated renders so the hook's effect doesn't fire
  // spuriously.
  const validValues = useMemo(
    () => [
      FILTER_ALL,
      FILTER_STANDALONE,
      ...workspaces.map((w) => w.slug),
    ],
    [workspaces],
  );
  const { filter, setFilter } = useProjectsFilter(validValues);

  // Mirror committed filter changes to the parent. Use a ref to skip
  // the synthetic re-emit on parent re-render — consumers only want
  // the event when the value actually moves.
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedRef.current === filter) return;
    lastEmittedRef.current = filter;
    onFilterChange?.(filter);
  }, [filter, onFilterChange]);

  return (
    <div
      data-testid={testId ?? "projects-filter-chips"}
      className={cn("flex items-center gap-2", className)}
    >
      <span className="text-[12px] text-zinc-500">Filter:</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip
          active={filter === FILTER_ALL}
          label={`All ${totalCount}`}
          onClick={() => setFilter(FILTER_ALL)}
          testId="filter-chip-all"
        />
        {workspaces.map((w) => (
          <Chip
            key={String(w.id)}
            active={filter === w.slug}
            label={`${w.name} ${w.count}`}
            onClick={() => setFilter(w.slug)}
            testId={`filter-chip-${w.slug}`}
          />
        ))}
        <Chip
          active={filter === FILTER_STANDALONE}
          label={`Standalone ${standaloneCount}`}
          onClick={() => setFilter(FILTER_STANDALONE)}
          testId="filter-chip-standalone"
        />
      </div>
      <button
        type="button"
        disabled
        aria-label="Group by"
        title="Grouping options coming soon"
        data-testid="projects-group-by"
        className={GROUP_BY_BUTTON_CLASSES}
      >
        By workspace ▾
      </button>
    </div>
  );
}

export default FilterChips;
