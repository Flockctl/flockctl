import { Fragment, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  useSchedules,
  useTemplates,
  useCreateSchedule,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
  useTriggerSchedule,
  useProjects,
  useScheduleTasks,
} from "@/lib/hooks";
import { ScheduleStatus, ScheduleType } from "@/lib/types";
import type { Schedule, ScheduleCreate, ScheduleFilters, TaskTemplate } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";

const PAGE_SIZE = 20;

const SCHEDULE_STATUS_VALUES: ScheduleStatus[] = [
  ScheduleStatus.active,
  ScheduleStatus.paused,
  ScheduleStatus.expired,
];



const CRON_PRESETS: { label: string; cron: string; group: string }[] = [
  { label: "Every 5 minutes", cron: "*/5 * * * *", group: "Frequent" },
  { label: "Every 15 minutes", cron: "*/15 * * * *", group: "Frequent" },
  { label: "Every 30 minutes", cron: "*/30 * * * *", group: "Frequent" },
  { label: "Every hour", cron: "0 * * * *", group: "Frequent" },
  { label: "Daily at midnight", cron: "0 0 * * *", group: "Daily" },
  { label: "Daily at 6 AM", cron: "0 6 * * *", group: "Daily" },
  { label: "Daily at noon", cron: "0 12 * * *", group: "Daily" },
  { label: "Daily at 6 PM", cron: "0 18 * * *", group: "Daily" },
  { label: "Weekly on Monday", cron: "0 0 * * 1", group: "Weekly" },
  { label: "Weekly on Friday", cron: "0 0 * * 5", group: "Weekly" },
  { label: "Custom cron...", cron: "__custom__", group: "Other" },
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

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

export function CreateScheduleDialog({
  projectId,
  buttonSize,
}: {
  projectId?: string;
  buttonSize?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [cronPreset, setCronPreset] = useState("__custom__");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [misfireGrace, setMisfireGrace] = useState("");
  const [formError, setFormError] = useState("");

  const createSchedule = useCreateSchedule();
  const { data: templatesData } = useTemplates(0, 100, projectId);

  function resetForm() {
    setTemplateId("");
    setCronExpression("");
    setCronPreset("__custom__");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setMisfireGrace("");
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!templateId) {
      setFormError("Template is required.");
      return;
    }

    if (!cronExpression.trim()) {
      setFormError("Cron expression is required.");
      return;
    }

    const data: ScheduleCreate = {
      template_id: templateId,
      schedule_type: ScheduleType.cron,
      cron_expression: cronExpression.trim(),
    };

    if (timezone.trim()) data.timezone = timezone.trim();
    if (misfireGrace) {
      data.misfire_grace_seconds = Number(misfireGrace);
    }

    try {
      await createSchedule.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create schedule",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button size={buttonSize}>Create Schedule</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Schedule</DialogTitle>
          <DialogDescription>
            {projectId
              ? "Schedule a template bound to this project."
              : "Schedule a template for automatic execution."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sched-template">Template *</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="sched-template">
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {templatesData?.items?.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </SelectItem>
                ))}
                {projectId &&
                  (!templatesData?.items ||
                    templatesData?.items?.length === 0) && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      No templates bound to this project.{" "}
                      <Link
                        to="/templates"
                        className="underline hover:text-foreground"
                      >
                        Create one on the Templates page
                      </Link>
                    </p>
                  )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
              <Label>Cron Schedule *</Label>
              <Select
                value={cronPreset}
                onValueChange={(value) => {
                  setCronPreset(value);
                  if (value !== "__custom__") {
                    const preset = CRON_PRESETS.find((p) => p.cron === value);
                    if (preset) setCronExpression(preset.cron);
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a schedule…" />
                </SelectTrigger>
                <SelectContent>
                  {["Frequent", "Daily", "Weekly", "Other"].map((group) => (
                    <SelectGroup key={group}>
                      <SelectLabel>{group}</SelectLabel>
                      {CRON_PRESETS.filter((p) => p.group === group).map(
                        (p) => (
                          <SelectItem key={p.cron} value={p.cron}>
                            {p.label}
                          </SelectItem>
                        ),
                      )}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {cronPreset === "__custom__" && (
                <Input
                  id="sched-cron"
                  placeholder="*/5 * * * *"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                />
              )}
              {cronExpression && (
                <p className="text-xs font-mono text-muted-foreground">
                  Cron: {cronExpression}
                </p>
              )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sched-tz">Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger id="sched-tz">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {Intl.supportedValuesOf("timeZone").map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sched-misfire">Misfire Grace (seconds)</Label>
              <Input
                id="sched-misfire"
                type="number"
                placeholder="optional"
                value={misfireGrace}
                onChange={(e) => setMisfireGrace(e.target.value)}
              />
            </div>
          </div>

          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createSchedule.isPending}>
              {createSchedule.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleTasksRow({
  scheduleId,
  colSpan,
}: {
  scheduleId: string;
  colSpan: number;
}) {
  const { data, isLoading, error } = useScheduleTasks(scheduleId, 0, 20, {
    refetchInterval: 10_000,
  });

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={colSpan} className="p-4">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading tasks…</p>
        )}
        {error && (
          <p className="text-xs text-destructive">
            Failed to load tasks: {error.message}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No tasks have been created by this schedule yet.
          </p>
        )}
        {data && data.items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {data.total} task{data.total !== 1 ? "s" : ""} created by this schedule
              {data.total > data.items.length && ` (showing latest ${data.items.length})`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="w-[140px]">Status</TableHead>
                  <TableHead className="w-[180px]">Created</TableHead>
                  <TableHead className="w-[180px]">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="underline hover:text-foreground"
                      >
                        {String(task.id).slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate">
                      {task.prompt ?? "\u2014"}
                    </TableCell>
                    <TableCell>{statusBadge(task.status)}</TableCell>
                    <TableCell className="text-xs">
                      {formatTime(task.created_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTime(task.completed_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

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
  const { data: templatesData } = useTemplates(0, 100);
  const { data: projectsData } = useProjects();
  const pauseScheduleMutation = usePauseSchedule();
  const resumeScheduleMutation = useResumeSchedule();
  const deleteScheduleMutation = useDeleteSchedule();
  const triggerScheduleMutation = useTriggerSchedule();
  const deleteConfirm = useConfirmDialog();

  const templateMap = useMemo(() => {
    const map = new Map<string, TaskTemplate>();
    if (templatesData?.items) {
      for (const tpl of templatesData.items) {
        map.set(tpl.id, tpl);
      }
    }
    return map;
  }, [templatesData]);

  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    if (projectsData) {
      for (const p of projectsData) {
        map.set(p.id, p.name);
      }
    }
    return map;
  }, [projectsData]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Schedules</h1>
          <p className="mt-1 text-muted-foreground">
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
                  <TableHead>Description</TableHead>
                  <TableHead>Project</TableHead>
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
                      {templateMap.get(sched.template_id)?.name ??
                        String(sched.template_id).slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                      {templateMap.get(sched.template_id)?.description ?? "\u2014"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {(() => {
                        const tpl = templateMap.get(sched.template_id);
                        if (tpl?.project_id) {
                          return projectMap.get(tpl.project_id) ?? String(tpl.project_id).slice(0, 8);
                        }
                        return "\u2014";
                      })()}
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
                    <ScheduleTasksRow scheduleId={sched.id} colSpan={9} />
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
