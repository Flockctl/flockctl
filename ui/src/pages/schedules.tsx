import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useSchedules,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
  useTriggerSchedule,
} from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
import { ScheduleStatus } from "@/lib/types";
import type { ScheduleFilters } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { SectionHeader } from "@/components/design";
import { CreateScheduleDialog } from "@/pages/schedules-components/create-schedule-dialog";
import { SchedulesTable } from "@/pages/schedules-components/SchedulesTable";

// Re-exported for callers that still import from `@/pages/schedules` (the
// project-detail Schedules section mounts the dialog inline with a preset
// scope). Keep this alias stable.
export { CreateScheduleDialog };

const PAGE_SIZE = 20;

const SCHEDULE_STATUS_VALUES: ScheduleStatus[] = [
  ScheduleStatus.active,
  ScheduleStatus.paused,
  ScheduleStatus.expired,
];

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

/**
 * Case-insensitive substring match on a schedule's identifying fields:
 *   - `template_name` (the most user-visible label)
 *   - `id`            (so the operator can paste a schedule id to jump)
 *   - `cron_expression` (handy when grepping for a known cron)
 *
 * Mirrors the predicate shape used by `filterTasksByQuery` /
 * `filterProjectsByQuery` so the four library pages (Tasks, Projects,
 * Workspaces, Schedules) all share the same search semantics.
 */
function filterSchedulesByQuery<
  T extends {
    id?: string | null;
    template_name?: string | null;
    cron_expression?: string | null;
  },
>(rows: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const id = (row.id ?? "").toLowerCase();
    const template = (row.template_name ?? "").toLowerCase();
    const cron = (row.cron_expression ?? "").toLowerCase();
    return (
      id.includes(trimmed) ||
      template.includes(trimmed) ||
      cron.includes(trimmed)
    );
  });
}


/**
 * /schedules landing page. Renders the filter bar + paginated table — the
 * actual table is the M22-styled {@link SchedulesTable} (flat divider-y
 * rows, scope-tinted project pills, kebab actions). Mutations and the
 * delete-confirm dialog are wired here so the table component stays
 * presentational.
 */
export default function SchedulesPage() {
  // ─── URL-backed filter / pagination state ───────────────────────────
  //
  // Tasks already moved its filters into the URL (`useSearchParams`);
  // mirroring the pattern here means a refresh / deep-link / back-button
  // preserves the operator's filtered view. Audit-round-3 finding.
  //
  // The URL is the source of truth — `filters`, `offset`, and the search
  // draft are all derived from it. The setters write back through
  // `setSearchParams` so React Router takes care of history entries.
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") as ScheduleFilters["status"] | null;
  const scheduleType = searchParams.get("type") as ScheduleFilters["schedule_type"] | null;
  const filters = useMemo<ScheduleFilters>(() => {
    const next: ScheduleFilters = {};
    if (status) next.status = status;
    if (scheduleType) next.schedule_type = scheduleType;
    return next;
  }, [status, scheduleType]);
  const offset = Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0;
  // Client-side `?q=` narrowing — the schedules API doesn't accept a free-text
  // query param, so we filter the current page client-side to match the rest
  // of the library surfaces (Tasks, Projects, Workspaces). The draft stays
  // in component state (typing doesn't churn URL history); we read+commit
  // to URL via the visible value below.
  const urlSearchValue = searchParams.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState<string>(urlSearchValue);

  // Visibility-gated polling: the schedules surface has no WS push (yet),
  // so the helper falls back to the 10s interval when the tab is visible
  // and pauses entirely when hidden — half the daemon's idle traffic.
  const refetchInterval = useWsAwarePolling(10_000);
  const { data, isLoading, error } = useSchedules(offset, PAGE_SIZE, filters, {
    refetchInterval,
  });
  const pauseScheduleMutation = usePauseSchedule();
  const resumeScheduleMutation = useResumeSchedule();
  const deleteScheduleMutation = useDeleteSchedule();
  const triggerScheduleMutation = useTriggerSchedule();
  const deleteConfirm = useConfirmDialog();

  // Map a `ScheduleFilters` key onto its URL param name. Keeps the
  // search-params shape decoupled from the internal filter shape so a
  // future schema tweak doesn't break shared bookmarks.
  function urlKeyFor(key: keyof ScheduleFilters): string {
    return key === "schedule_type" ? "type" : key;
  }

  function updateFilter<K extends keyof ScheduleFilters>(
    key: K,
    value: ScheduleFilters[K],
  ) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const paramKey = urlKeyFor(key);
      // `ScheduleFilters` keys are typed as enum unions, so a literal
      // `""` check needs a string-coerce intermediate to compile under
      // strict mode.
      const strValue =
        value === undefined || value === null ? "" : String(value);
      if (strValue === "") {
        next.delete(paramKey);
      } else {
        next.set(paramKey, strValue);
      }
      // Reset pagination on filter change — keeps the "showing 1–N of M"
      // label sensible across filter switches.
      next.delete("offset");
      return next;
    });
  }

  function setOffset(nextOffset: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextOffset === 0) next.delete("offset");
      else next.set("offset", String(nextOffset));
      return next;
    });
  }

  const filterCount = Object.values(filters).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;
  const showingFrom = data ? Math.min(offset + 1, data.total) : 0;
  const showingTo = data ? Math.min(offset + PAGE_SIZE, data.total) : 0;

  // Apply the client-side search predicate to the current page. The server
  // already paginates, so the narrowing is bounded by PAGE_SIZE.
  const filteredItems = useMemo(
    () => filterSchedulesByQuery(data?.items ?? [], searchDraft),
    [data?.items, searchDraft],
  );
  const hasSearch = searchDraft.trim().length > 0;

  return (
    <div data-testid="schedules-page" className="max-w-7xl">
      <SectionHeader
        title="Schedules"
        subtitle="Configure and monitor scheduled task execution."
        action={<CreateScheduleDialog />}
      />

      {/* Filter bar — Status select sits left, search input right (matches
          the Tasks filter row layout). */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select
            value={filters.status ?? "__all__"}
            onValueChange={(v) =>
              updateFilter(
                "status",
                v === "__all__"
                  ? undefined
                  : (v as ScheduleFilters["status"]),
              )
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              {SCHEDULE_STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1" />

        <input
          type="text"
          role="searchbox"
          placeholder="Search schedules…"
          aria-label="Search schedules"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          className={SEARCH_INPUT_CLASSES}
          data-testid="schedules-search-input"
        />
      </div>

      <div>
        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-destructive">
            Failed to load schedules: {error.message}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {filterCount > 0
              ? "No schedules match the current filters."
              : "No schedules yet."}
          </p>
        )}
        {data && data.items.length > 0 && filteredItems.length === 0 && hasSearch && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="schedules-search-empty"
          >
            No schedules match “{searchDraft.trim()}”.
          </p>
        )}
        {data && filteredItems.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Showing {showingFrom}–{showingTo} of {data.total} schedule
              {data.total !== 1 ? "s" : ""}
              {filterCount > 0 &&
                ` (${filterCount} filter${filterCount > 1 ? "s" : ""} active)`}
              {hasSearch &&
                ` · ${filteredItems.length} match${filteredItems.length === 1 ? "" : "es"} for “${searchDraft.trim()}”`}
            </p>
            <SchedulesTable
              rows={filteredItems}
              onRunNow={(id) =>
                !triggerScheduleMutation.isPending &&
                triggerScheduleMutation.mutate(id)
              }
              onPause={(id) =>
                !pauseScheduleMutation.isPending &&
                pauseScheduleMutation.mutate(id)
              }
              onResume={(id) =>
                !resumeScheduleMutation.isPending &&
                resumeScheduleMutation.mutate(id)
              }
              onDelete={(id) => deleteConfirm.requestConfirm(id)}
            />

            {/* Pagination */}
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
                {Math.ceil(data.total / PAGE_SIZE)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Schedule"
        description="This will permanently delete this schedule. This action cannot be undone."
        isPending={deleteScheduleMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteScheduleMutation.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
