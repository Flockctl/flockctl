import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { SegmentToggle } from "@/components/design/SegmentToggle";
import { cn } from "@/lib/utils";

/**
 * TasksFilters — filter row for the `/tasks` page (slice 24/00 T01).
 *
 * Four pieces of state, each backed by the URL so reload / share /
 * back-button reproduce the same view exactly:
 *
 *   1. **Status** `<SegmentToggle>` — `All · Running · Pending ·
 *      Completed · Failed`. Drives `?status=`. The "All" segment is
 *      the canonical "no filter" value and removes the param entirely
 *      (so a clean `/tasks` URL stays clean — no `?status=all`).
 *
 *   2. **Project** `<select>` — drives `?project_id=`. Shows every
 *      project the parent passes in plus an `All projects` entry.
 *      Selecting `All projects` removes the param.
 *
 *   3. **Range** `<select>` — `24h · 7d · 30d · all`. Drives `?range=`.
 *      `all` is the default and removes the param (same logic as
 *      Status above).
 *
 *   4. **Search** input — debounced 200ms before being committed to
 *      `?q=`. Empty / whitespace-only drafts wipe the param. Mirror
 *      of {@link ../projects-components/ProjectsToolbar.useProjectsSearchQuery}
 *      to keep typing behaviour consistent across pages.
 *
 * Filtering is intentionally split:
 *   - `status`, `project_id`, `range` are server-driven (they map to
 *     existing `GET /tasks` filters in `src/routes/tasks/crud.ts`).
 *   - `q` is client-side narrowing on the current page — see
 *     {@link filterTasksByQuery}. The `/tasks` server endpoint does
 *     not accept a free-text `q` and the audit explicitly defers
 *     adding one (slice.md → "Audit findings → Current filter contract").
 */

// ─── URL contract ─────────────────────────────────────────────────────────────

export type TasksStatusFilter =
  | "all"
  | "running"
  | "pending"
  | "completed"
  | "failed";

export type TasksRangeFilter = "24h" | "7d" | "30d" | "all";

const STATUS_OPTIONS: ReadonlyArray<{ value: TasksStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
] as const;

const RANGE_OPTIONS: ReadonlyArray<{ value: TasksRangeFilter; label: string }> = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
] as const;

const ALLOWED_STATUS: ReadonlyArray<TasksStatusFilter> = STATUS_OPTIONS.map(
  (o) => o.value,
);
const ALLOWED_RANGE: ReadonlyArray<TasksRangeFilter> = RANGE_OPTIONS.map(
  (o) => o.value,
);

const STATUS_PARAM = "status";
const PROJECT_PARAM = "project_id";
const RANGE_PARAM = "range";
const QUERY_PARAM = "q";

const DEFAULT_STATUS: TasksStatusFilter = "all";
const DEFAULT_RANGE: TasksRangeFilter = "all";
const DEFAULT_DEBOUNCE_MS = 200;

function isTasksStatusFilter(v: unknown): v is TasksStatusFilter {
  return (
    typeof v === "string" &&
    (ALLOWED_STATUS as readonly string[]).includes(v)
  );
}

function isTasksRangeFilter(v: unknown): v is TasksRangeFilter {
  return (
    typeof v === "string" &&
    (ALLOWED_RANGE as readonly string[]).includes(v)
  );
}

// ─── URL-backed read hooks ────────────────────────────────────────────────────

/**
 * Read-only sister hook to {@link TasksFilters} for callers that need
 * the current status filter without rendering the bar (e.g. the page
 * shell deciding which `?status=` to forward to `useTasks`).
 *
 * Unknown values silently fall back to `'all'` rather than crashing —
 * an old tab on a deleted enum should not blank the page.
 */
export function useTasksStatusFilter(): TasksStatusFilter {
  const [params] = useSearchParams();
  const raw = params.get(STATUS_PARAM);
  return isTasksStatusFilter(raw) ? raw : DEFAULT_STATUS;
}

/**
 * Read-only sister hook for the active project filter.
 *
 * Returns `undefined` when no project is selected (so the call site
 * can pass it straight into `TaskFilters.project_id` without a
 * sentinel string round-trip).
 */
export function useTasksProjectFilter(): string | undefined {
  const [params] = useSearchParams();
  const raw = params.get(PROJECT_PARAM);
  return raw && raw.length > 0 ? raw : undefined;
}

/** Read-only sister hook for the active time-range filter. */
export function useTasksRangeFilter(): TasksRangeFilter {
  const [params] = useSearchParams();
  const raw = params.get(RANGE_PARAM);
  return isTasksRangeFilter(raw) ? raw : DEFAULT_RANGE;
}

/**
 * URL-backed search-query state. Mirrors
 * `useProjectsSearchQuery` deliberately — typing UX must be
 * identical across pages, and a single shared debounce window
 * (`200 ms`) is the contract.
 *
 * Returns:
 *   - `draft`        — what the input currently shows (uncommitted typing).
 *   - `query`        — what the URL holds (debounced commit).
 *   - `setDraft(v)`  — update the draft.
 */
export function useTasksSearchQuery(
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): { draft: string; query: string; setDraft: (next: string) => void } {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM) ?? "";

  const [draft, setDraftState] = useState<string>(urlQuery);

  // External URL changes (browser back, programmatic navigate) win over
  // the local draft, but only when the URL value actually moved. We
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

// ─── Client-side filter helper ────────────────────────────────────────────────

/**
 * Case-insensitive substring match on `id` AND `title`. Mirrors the
 * shape of {@link ../projects-components/ProjectsToolbar.filterProjectsByQuery}
 * so callers writing the same predicate twice can reach for a familiar
 * helper. Both fields are optional; rows missing either field still
 * match against whichever they do have.
 *
 * Empty / whitespace-only queries return all rows in their original
 * order (a non-mutating copy so callers can pipe straight into
 * `.map()` without worrying about aliasing).
 */
export function filterTasksByQuery<
  T extends { id?: string | null; title?: string | null },
>(rows: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const id = (row.id ?? "").toLowerCase();
    const title = (row.title ?? "").toLowerCase();
    return id.includes(trimmed) || title.includes(trimmed);
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface TasksFiltersProjectOption {
  id: string;
  name: string;
}

export interface TasksFiltersProps {
  /**
   * Projects to populate the project `<select>`. Empty / undefined
   * still renders the `All projects` entry so the bar layout is
   * stable while projects are loading.
   */
  projects?: ReadonlyArray<TasksFiltersProjectOption>;
  /**
   * Override the search debounce. Tests pin this to `0` (or use fake
   * timers) to keep timing deterministic; production uses 200 ms.
   */
  searchDebounceMs?: number;
  /** Fired with the committed (debounced, trimmed) search query. */
  onSearchChange?: (query: string) => void;
  /** Fired when the user picks a different status segment. */
  onStatusChange?: (status: TasksStatusFilter) => void;
  /** Fired when the user picks a different project (or clears it). */
  onProjectChange?: (projectId: string | undefined) => void;
  /** Fired when the user picks a different range. */
  onRangeChange?: (range: TasksRangeFilter) => void;
  className?: string;
  "data-testid"?: string;
}

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

const SELECT_CLASSES =
  "px-2.5 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none";

const ALL_PROJECTS_VALUE = "__all__";

export function TasksFilters({
  projects,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  onSearchChange,
  onStatusChange,
  onProjectChange,
  onRangeChange,
  className,
  "data-testid": testId,
}: TasksFiltersProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // ─── Status (?status=) ──────────────────────────────────────────────────
  const rawStatus = searchParams.get(STATUS_PARAM);
  const status: TasksStatusFilter = isTasksStatusFilter(rawStatus)
    ? rawStatus
    : DEFAULT_STATUS;

  const handleStatusChange = useCallback(
    (next: TasksStatusFilter) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === DEFAULT_STATUS) params.delete(STATUS_PARAM);
          else params.set(STATUS_PARAM, next);
          return params;
        },
        { replace: true },
      );
      onStatusChange?.(next);
    },
    [setSearchParams, onStatusChange],
  );

  // ─── Project (?project_id=) ─────────────────────────────────────────────
  const rawProject = searchParams.get(PROJECT_PARAM);
  const projectId =
    rawProject && rawProject.length > 0 ? rawProject : ALL_PROJECTS_VALUE;

  const handleProjectChange = useCallback(
    (next: string) => {
      const cleared = next === ALL_PROJECTS_VALUE;
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (cleared) params.delete(PROJECT_PARAM);
          else params.set(PROJECT_PARAM, next);
          return params;
        },
        { replace: true },
      );
      onProjectChange?.(cleared ? undefined : next);
    },
    [setSearchParams, onProjectChange],
  );

  // ─── Range (?range=) ────────────────────────────────────────────────────
  const rawRange = searchParams.get(RANGE_PARAM);
  const range: TasksRangeFilter = isTasksRangeFilter(rawRange)
    ? rawRange
    : DEFAULT_RANGE;

  const handleRangeChange = useCallback(
    (next: TasksRangeFilter) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === DEFAULT_RANGE) params.delete(RANGE_PARAM);
          else params.set(RANGE_PARAM, next);
          return params;
        },
        { replace: true },
      );
      onRangeChange?.(next);
    },
    [setSearchParams, onRangeChange],
  );

  // ─── Search (?q=, debounced) ────────────────────────────────────────────
  const { draft, query, setDraft } = useTasksSearchQuery(searchDebounceMs);

  // Mirror committed query changes to the parent. Skip the synthetic
  // mount-time emission when the URL is empty so consumers don't get a
  // spurious `""` event they didn't ask for.
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedRef.current === query) return;
    lastEmittedRef.current = query;
    onSearchChange?.(query);
  }, [query, onSearchChange]);

  const statusOptions = useMemo(() => [...STATUS_OPTIONS], []);
  const rangeOptions = useMemo(() => [...RANGE_OPTIONS], []);
  const projectOptions = projects ?? [];

  return (
    <div
      data-testid={testId ?? "tasks-filters"}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <SegmentToggle<TasksStatusFilter>
        options={statusOptions}
        value={status}
        onChange={handleStatusChange}
        aria-label="Task status"
        data-testid="tasks-status-toggle"
      />
      <select
        aria-label="Project"
        data-testid="tasks-project-select"
        value={projectId}
        onChange={(e) => handleProjectChange(e.target.value)}
        className={SELECT_CLASSES}
      >
        <option value={ALL_PROJECTS_VALUE}>All projects</option>
        {projectOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Time range"
        data-testid="tasks-range-select"
        value={range}
        onChange={(e) => {
          const next = e.target.value;
          if (isTasksRangeFilter(next)) handleRangeChange(next);
        }}
        className={SELECT_CLASSES}
      >
        {rangeOptions.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        role="searchbox"
        placeholder="Search tasks…"
        aria-label="Search tasks"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={SEARCH_INPUT_CLASSES}
        data-testid="tasks-search-input"
      />
    </div>
  );
}

export default TasksFilters;
