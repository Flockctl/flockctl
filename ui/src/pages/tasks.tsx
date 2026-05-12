import { useEffect, useMemo, useState } from "react";

import {
  useCancelTask,
  useProjects,
  useTaskStats,
  useTasks,
} from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
import type { Task, TaskFilters } from "@/lib/types";
import { SectionHeader } from "@/components/design";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { ListChecks } from "lucide-react";

import {
  TasksFilters,
  filterTasksByQuery,
  useTasksProjectFilter,
  useTasksRangeFilter,
  useTasksSearchQuery,
  useTasksStatusFilter,
  type TasksRangeFilter,
  type TasksStatusFilter,
} from "./tasks-components/TasksFilters";
import { TasksTable } from "./tasks-components/TasksTable";
import {
  TasksBulkToolbar,
  summarize,
} from "./tasks-components/TasksBulkToolbar";
import type { BulkMutateResult } from "@/lib/bulk-mutate";
import { CreateTaskDialog } from "./tasks-components/tasks-table";

/**
 * `/tasks` page assembly (slice 24-00 T05).
 *
 * The slice's vertical bullet:
 *
 *   SectionHeader → TasksFilters → (TasksBulkToolbar when selection > 0)
 *                                                   → TasksTable
 *
 * is composed below from the M22+ flat-primitive widgets that prior tasks
 * built in isolation. The page itself is the integration: it owns the
 * URL-backed filter contract, the row-selection state for the bulk
 * toolbar, the per-row actions (cancel, rerun, copy-id), and the toast
 * surface that summarizes a bulk-mutate result.
 *
 * URL contract (mirrors `TasksFilters` audit findings):
 *   - `?status=all|running|pending|completed|failed`   — segment toggle
 *   - `?project_id=<id>`                                — project select
 *   - `?range=24h|7d|30d|all`                           — range select
 *   - `?q=<text>`                                       — debounced search
 *
 * Mapping into `TaskFilters` for `useTasks(...)`:
 *   - `status` collapses to a single backend status (the Flockctl enum is
 *     wider than the prototype's five-value table — `pending` maps to
 *     `queued` per the audit; everything else round-trips 1:1).
 *   - `range` maps to `created_after = now - <range>` so the backend can
 *     paginate against an indexed timestamp.
 *   - `q` is intentionally CLIENT-side only — `GET /tasks` does not accept
 *     a free-text param and the slice defers adding one.
 */

const PAGE_SIZE = 100;

interface BulkResultBanner {
  tone: "success" | "warning" | "error";
  message: string;
  expiresAt: number;
}

/**
 * Translate the URL `?status=` filter into the backend `TaskFilters.status`.
 * Returns `undefined` for `all` (no filter), and maps `pending` → `queued`
 * per the audit's StatusPill tone table.
 */
function statusUrlToBackend(value: TasksStatusFilter): TaskFilters["status"] {
  switch (value) {
    case "running":
      return "running";
    case "pending":
      return "queued";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "all":
    default:
      return undefined;
  }
}

const RANGE_TO_MS: Record<Exclude<TasksRangeFilter, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function rangeToCreatedAfter(value: TasksRangeFilter): string | undefined {
  if (value === "all") return undefined;
  const ms = RANGE_TO_MS[value];
  if (!ms) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

function buildFilters(
  status: TasksStatusFilter,
  projectId: string | undefined,
  range: TasksRangeFilter,
): TaskFilters {
  const filters: TaskFilters = {};
  const backendStatus = statusUrlToBackend(status);
  if (backendStatus) filters.status = backendStatus;
  if (projectId) filters.project_id = projectId;
  const after = rangeToCreatedAfter(range);
  if (after) filters.created_after = after;
  return filters;
}

function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Project name index keyed by id. Falls back to the raw id if a row's
 * `project_id` doesn't match any loaded workspace — happens when a project
 * is deleted but its tasks linger.
 */
function nameById<T extends { id: string; name: string }>(
  rows: ReadonlyArray<T> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows ?? []) map.set(r.id, r.name);
  return map;
}

export default function TasksPage() {
  // ─── URL filter contract (read-only sister hooks; the bar itself owns writes) ─
  const status = useTasksStatusFilter();
  const projectId = useTasksProjectFilter();
  const range = useTasksRangeFilter();
  const { query } = useTasksSearchQuery();

  // Derived backend filters memoized so a `Date.now()` recompute on every
  // render doesn't churn `useTasks`'s queryKey.
  const filters = useMemo(
    () => buildFilters(status, projectId, range),
    [status, projectId, range],
  );

  // ─── Data ──────────────────────────────────────────────────────────────────
  // WS-aware polling — see tasks-table.tsx for rationale.
  const taskRefetchInterval = useWsAwarePolling(10_000);
  const tasksQuery = useTasks(0, PAGE_SIZE, filters, {
    refetchInterval: taskRefetchInterval,
  });
  const projectsQuery = useProjects();
  const taskStatsQuery = useTaskStats();
  const cancelTask = useCancelTask();

  const projectNameIndex = useMemo(
    () => nameById(projectsQuery.data),
    [projectsQuery.data],
  );

  const tasks: Task[] = tasksQuery.data?.items ?? [];

  // Server-side filters narrow the rowset; `?q=` narrows further on the
  // client across id + (prompt|label) — TasksFilters exports the predicate
  // so the contract sits in one place.
  const filtered = useMemo(
    () =>
      filterTasksByQuery(
        tasks.map((t) => ({
          id: t.id,
          // The server doesn't carry a `title` field; the prompt is the
          // closest user-supplied string for substring search.
          title: t.prompt ?? "",
          raw: t,
        })),
        query,
      ),
    [tasks, query],
  );

  // ─── Memoised table row shape (audit-round-5) ───
  //
  // The previous render path inlined `filtered.map(...)` directly as
  // the `rows` prop on `<TasksTable>`, which broke referential
  // identity even when `filtered` was already memoised. With a
  // memoised row array, future `React.memo`-wrapped TasksTable would
  // skip work whenever none of the dependency inputs actually changed.
  const tableRows = useMemo(
    () =>
      filtered.map((row) => {
        const t = row.raw;
        const projectName = t.project_id
          ? projectNameIndex.get(t.project_id) ?? null
          : null;
        return {
          id: t.id,
          title:
            t.prompt && t.prompt.trim().length > 0
              ? t.prompt.split("\n")[0]!.slice(0, 120)
              : `Task ${t.id.slice(0, 8)}`,
          status: t.status,
          project: projectName ? { name: projectName } : undefined,
          created_at: t.created_at,
          // liveMetrics.total_cost_usd is only populated for currently-
          // running tasks (the executor only attaches it while a
          // worker is alive). For finished rows the canonical total
          // comes from `task.cost_usd`. Read live first, then fall
          // back to the persisted column.
          cost_usd: t.liveMetrics?.total_cost_usd ?? t.cost_usd ?? 0,
        };
      }),
    [filtered, projectNameIndex],
  );

  // ─── Selection state ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Drop selections that no longer exist in the rendered rowset (e.g. after
  // a filter change or a refetch hides a queued task that just transitioned
  // to running). Without this the toolbar would show "3 selected" even when
  // none of those rows are visible to act on.
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const visible = new Set(filtered.map((r) => r.id));
    const next = selectedIds.filter((id) => visible.has(id));
    if (next.length !== selectedIds.length) {
      setSelectedIds(next);
    }
  }, [filtered, selectedIds]);

  // Map id → status so the toolbar can light "Cancel queued" only when at
  // least one selected row is `queued`. Set.has lookup keeps this O(n+m) even
  // when both filtered + selection are large (e.g. WS updates during bulk
  // selection re-fire this memo).
  const selectedStatuses = useMemo(() => {
    const out: Record<string, string> = {};
    const selSet = new Set(selectedIds);
    for (const r of filtered) {
      if (selSet.has(r.id)) {
        out[r.id] = r.raw.status;
      }
    }
    return out;
  }, [filtered, selectedIds]);

  // ─── Bulk-result banner (lightweight stand-in for a global toaster) ───────
  const [banner, setBanner] = useState<BulkResultBanner | null>(null);
  const handleBulkResult = (
    action: "cancel_queued" | "mark_watched",
    result: BulkMutateResult<string>,
  ) => {
    const { tone, message } = summarize(action, result);
    setBanner({ tone, message, expiresAt: Date.now() + 4000 });
    if (action === "cancel_queued") {
      // Drop successfully-cancelled rows from the selection so the
      // toolbar's queued-count updates immediately. Set.has = O(1).
      const okSet = new Set(result.ok);
      setSelectedIds((prev) => prev.filter((id) => !okSet.has(id)));
    }
  };
  const handleCopyIds = (ids: string[]) => {
    setBanner({
      tone: "success",
      message: `Copied ${ids.length} id${ids.length === 1 ? "" : "s"} to clipboard`,
      expiresAt: Date.now() + 2500,
    });
  };
  useEffect(() => {
    if (!banner) return;
    const remaining = banner.expiresAt - Date.now();
    if (remaining <= 0) {
      setBanner(null);
      return;
    }
    const t = setTimeout(() => setBanner(null), remaining);
    return () => clearTimeout(t);
  }, [banner]);

  // ─── Header subtitle counts ───────────────────────────────────────────────
  const stats = taskStatsQuery.data;
  const activeCount =
    (stats?.queued ?? 0) +
    (stats?.assigned ?? 0) +
    (stats?.running ?? 0);
  // The backend's `done` count is "ever-completed" not "today"; we narrow to
  // today client-side from the in-window task list. The list is already
  // capped at PAGE_SIZE so this is a tight constant-time scan.
  const completedTodayCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (t.status === "done" || (t.status as string) === "completed") &&
          isToday(t.completed_at),
      ).length,
    [tasks],
  );
  const subtitle = stats
    ? `${activeCount} active · ${completedTodayCount} completed today`
    : undefined;

  // ─── Per-row action wiring ────────────────────────────────────────────────
  const handleRowCancel = async (id: string) => {
    try {
      await cancelTask.mutateAsync(id);
      setBanner({
        tone: "success",
        message: "Task cancelled",
        expiresAt: Date.now() + 2500,
      });
    } catch (err) {
      setBanner({
        tone: "error",
        message:
          err instanceof Error
            ? `Failed to cancel: ${err.message}`
            : "Failed to cancel task",
        expiresAt: Date.now() + 4000,
      });
    }
  };
  const handleRowCopyId = async (id: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      }
    } catch {
      /* fall through — banner still fires below */
    }
    setBanner({
      tone: "success",
      message: "Copied id to clipboard",
      expiresAt: Date.now() + 2000,
    });
  };

  const showLoading = tasksQuery.isLoading;
  const showError = !!tasksQuery.error;
  const showInitialEmpty =
    !showLoading && !showError && tasks.length === 0 && !hasActiveFilter(filters, query);
  const showFilteredEmpty =
    !showLoading && !showError && tasks.length === 0 && hasActiveFilter(filters, query);
  const showQueryNarrowedEmpty =
    !showLoading &&
    !showError &&
    tasks.length > 0 &&
    filtered.length === 0;

  // Project options for the filter select — sorted by name for determinism.
  const projectOptions = useMemo(
    () =>
      [...(projectsQuery.data ?? [])]
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectsQuery.data],
  );

  return (
    <div data-testid="tasks-page" className="max-w-7xl">
      <SectionHeader
        title="Tasks"
        subtitle={subtitle}
        action={<CreateTaskDialog />}
      />

      <div className="mb-3">
        <TasksFilters projects={projectOptions} />
      </div>

      {selectedIds.length > 0 && (
        <div className="mb-2">
          <TasksBulkToolbar
            selectedIds={selectedIds}
            selectedStatuses={selectedStatuses}
            onCancelQueued={(id) => cancelTask.mutateAsync(id)}
            onResult={handleBulkResult}
            onCopyIds={handleCopyIds}
            onClearSelection={() => setSelectedIds([])}
          />
        </div>
      )}

      {banner && (
        <div
          data-testid="tasks-bulk-banner"
          data-tone={banner.tone}
          role="status"
          aria-live="polite"
          className={
            banner.tone === "success"
              ? "mb-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : banner.tone === "warning"
                ? "mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                : "mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
          }
        >
          {banner.message}
        </div>
      )}

      {showLoading && (
        <div className="space-y-2" data-testid="tasks-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {showError && (
        <p className="text-destructive" data-testid="tasks-error">
          Failed to load tasks: {(tasksQuery.error as Error)?.message}
        </p>
      )}

      {showInitialEmpty && (
        <EmptyState
          icon={ListChecks}
          title="No tasks yet"
          description="Submit a task to start running prompts against a project."
          data-testid="tasks-empty-state"
        />
      )}

      {showFilteredEmpty && (
        <EmptyState
          icon={ListChecks}
          title="No tasks match your filters"
          description="Try widening the status or time range, or clearing the search."
          data-testid="tasks-filtered-empty-state"
        />
      )}

      {showQueryNarrowedEmpty && (
        <EmptyState
          icon={ListChecks}
          title="No tasks match your search"
          description="Nothing on this page matched your query — try a different search."
          data-testid="tasks-search-empty-state"
        />
      )}

      {!showLoading && !showError && filtered.length > 0 && (
        <TasksTable
          rows={tableRows}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onCancel={handleRowCancel}
          onCopyId={handleRowCopyId}
          data-testid="tasks-table"
        />
      )}
    </div>
  );
}

/**
 * True when the user has narrowed by anything other than the default page —
 * used to pick between the "no tasks yet" and "no tasks match filters" empty
 * states.
 */
function hasActiveFilter(filters: TaskFilters, query: string): boolean {
  if (filters.status) return true;
  if (filters.project_id) return true;
  if (filters.created_after) return true;
  if (query.trim().length > 0) return true;
  return false;
}
