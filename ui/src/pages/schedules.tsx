import { Fragment, useState } from "react";
import {
  useSchedules,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
  useTriggerSchedule,
} from "@/lib/hooks";
import { ScheduleStatus } from "@/lib/types";
import type { Schedule, ScheduleFilters } from "@/lib/types";
import { formatTimestamp as formatTime } from "@/lib/format";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  CreateScheduleDialog,
  scopeLabel,
} from "@/pages/schedules-components/create-schedule-dialog";
import { ScheduleTasksRow } from "@/pages/schedules-components/schedule-tasks-row";

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

function ScheduleStatusBadge({ status }: { status: Schedule["status"] }) {
  const variants: Record<string, string> = {
    [ScheduleStatus.active]:
      "bg-green-500/15 text-green-700 dark:text-green-400 dark:bg-green-500/20",
    [ScheduleStatus.paused]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400 dark:bg-orange-500/20",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

/**
 * /schedules landing page. Renders the filter bar + paginated table. Row
 * expansion drops to `ScheduleTasksRow` (fetches latest tasks spawned by the
 * schedule) and the header "Create" button mounts `CreateScheduleDialog`.
 * Heavy sub-trees live under `schedules-components/` so this file stays
 * focused on the table layout and row actions.
 */
export default function SchedulesPage() {
  const [filters, setFilters] = useState<ScheduleFilters>({});
  const [offset, setOffset] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { data, isLoading, error } = useSchedules(offset, PAGE_SIZE, filters, {
    refetchInterval: 10_000,
  });
  const pauseScheduleMutation = usePauseSchedule();
  const resumeScheduleMutation = useResumeSchedule();
  const deleteScheduleMutation = useDeleteSchedule();
  const triggerScheduleMutation = useTriggerSchedule();
  const deleteConfirm = useConfirmDialog();

  function updateFilter<K extends keyof ScheduleFilters>(
    key: K,
    value: ScheduleFilters[K],
  ) {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setOffset(0);
  }

  const filterCount = Object.values(filters).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;
  const showingFrom = data ? Math.min(offset + 1, data.total) : 0;
  const showingTo = data ? Math.min(offset + PAGE_SIZE, data.total) : 0;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold sm:text-2xl">Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Configure and monitor scheduled task execution.
          </p>
        </div>
        <CreateScheduleDialog />
      </div>

      {/* Filter bar */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
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


      </div>

      <div className="mt-6">
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
        {data && data.items.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Showing {showingFrom}–{showingTo} of {data.total} schedule
              {data.total !== 1 ? "s" : ""}
              {filterCount > 0 &&
                ` (${filterCount} filter${filterCount > 1 ? "s" : ""} active)`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[32px]" />
                  <TableHead>Template</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next Fire</TableHead>
                  <TableHead>Last Fire</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((sched: Schedule) => {
                  const isExpanded = expandedIds.has(sched.id);
                  return (
                  <Fragment key={sched.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => toggleExpanded(sched.id)}
                  >
                    <TableCell className="w-[32px] p-2">
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
                        aria-label={isExpanded ? "Collapse" : "Expand"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(sched.id);
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="font-medium">
                      {sched.template_name}
                    </TableCell>
                    <TableCell className="text-xs">
                      {scopeLabel(sched.template_scope)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {sched.cron_expression ?? "-"}
                    </TableCell>
                    <TableCell>
                      <ScheduleStatusBadge status={sched.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTime(sched.next_fire_time)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTime(sched.last_fire_time)}
                    </TableCell>
                    <TableCell>
                      <div
                        className="flex gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {sched.status === ScheduleStatus.active && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={pauseScheduleMutation.isPending}
                            onClick={() =>
                              pauseScheduleMutation.mutate(sched.id)
                            }
                          >
                            Pause
                          </Button>
                        )}
                        {sched.status === ScheduleStatus.paused && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={resumeScheduleMutation.isPending}
                            onClick={() =>
                              resumeScheduleMutation.mutate(sched.id)
                            }
                          >
                            Resume
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={triggerScheduleMutation.isPending}
                          onClick={() =>
                            triggerScheduleMutation.mutate(sched.id)
                          }
                        >
                          Run
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={deleteScheduleMutation.isPending}
                          onClick={() => deleteConfirm.requestConfirm(sched.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <ScheduleTasksRow scheduleId={sched.id} colSpan={8} />
                  )}
                  </Fragment>
                  );
                })}
              </TableBody>
            </Table>

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
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
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
