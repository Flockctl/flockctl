import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTasks, useCreateTask, useCancelTask, useRerunTask, useTaskStats, useProjects } from "@/lib/hooks";
import { TaskStatus } from "@/lib/types";
import type { Task, TaskFilters, TaskCreate } from "@/lib/types";
import { StatCard } from "@/components/stat-card";
import { TaskFormFields, defaultTaskFormValues } from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
import { Hash, Clock, Loader, CheckCircle, XCircle, Timer } from "lucide-react";
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
  SelectItem,
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

const PAGE_SIZE = 20;

const TASK_STATUS_VALUES: TaskStatus[] = [
  TaskStatus.queued,
  TaskStatus.assigned,
  TaskStatus.running,
  TaskStatus.done,
  TaskStatus.failed,
  TaskStatus.timed_out,
];

function TaskStatusBadge({ status }: { status: Task["status"] }) {
  const variants: Record<string, string> = {
    [TaskStatus.running]: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    [TaskStatus.done]: "bg-green-500/15 text-green-700 dark:text-green-400",
    [TaskStatus.failed]: "bg-red-500/15 text-red-700 dark:text-red-400",
    [TaskStatus.timed_out]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="secondary">{status}</Badge>;
}

function formatDuration(task: Task): string {
  const start = task.started_at ? new Date(task.started_at).getTime() : null;
  const end = task.completed_at
    ? new Date(task.completed_at).getTime()
    : start
      ? Date.now()
      : null;
  if (start == null || end == null) return "-";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function activeFilterCount(filters: TaskFilters): number {
  return Object.values(filters).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;
}

function CreateTaskDialog() {
  const [open, setOpen] = useState(false);
  const [formValues, setFormValues] = useState<TaskFormValues>(defaultTaskFormValues);
  const [formError, setFormError] = useState("");

  const createTask = useCreateTask();

  function resetForm() {
    setFormValues(defaultTaskFormValues);
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const trimmedAgent = formValues.agent.trim();
    if (!trimmedAgent) {
      setFormError("Agent is required.");
      return;
    }

    const data: TaskCreate = {
      agent: trimmedAgent,
      timeout_seconds: Number(formValues.timeout) || 300,
    };
    if (formValues.model.trim() && formValues.model !== "__default__") data.model = formValues.model.trim();
    if (formValues.prompt.trim()) data.prompt = formValues.prompt.trim();
    if (formValues.selectedProjectId && formValues.selectedProjectId !== "__none__") data.project_id = formValues.selectedProjectId;
    if (formValues.assignedKeyId && formValues.assignedKeyId !== "__auto__") data.assigned_key_id = parseInt(formValues.assignedKeyId);
    if (formValues.permissionMode) data.permission_mode = formValues.permissionMode;

    try {
      await createTask.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create task");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        <Button>Create Task</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>
            Submit a new task to the swarm.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <TaskFormFields values={formValues} onChange={setFormValues} idPrefix="ct" />
          {formError && (
            <p className="text-sm text-destructive">{formError}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createTask.isPending}>
              {createTask.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = searchParams.get("project_id") ?? undefined;
  const [filters, setFilters] = useState<TaskFilters>(initialProjectId ? { project_id: initialProjectId } : {});
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const { data: projects } = useProjects();

  const { data, isLoading, error } = useTasks(offset, PAGE_SIZE, filters, {
    refetchInterval: 10_000,
  });
  const cancelTaskMutation = useCancelTask();
  const rerunTaskMutation = useRerunTask();
  const taskStatsQuery = useTaskStats();
  const stats = taskStatsQuery.data;

  function updateFilter<K extends keyof TaskFilters>(
    key: K,
    value: TaskFilters[K],
  ) {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "") {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setOffset(0);
    // Sync project_id to URL
    if (key === "project_id") {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) {
          next.set("project_id", String(value));
        } else {
          next.delete("project_id");
        }
        return next;
      });
    }
  }

  const showingFrom = data ? Math.min(offset + 1, data.total) : 0;
  const showingTo = data ? Math.min(offset + PAGE_SIZE, data.total) : 0;
  const filterCount = activeFilterCount(filters);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="mt-1 text-muted-foreground">
            View, create, and monitor tasks.
          </p>
        </div>
        <CreateTaskDialog />
      </div>

      {/* Task stat cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard icon={Hash} label="Total" value={stats?.total ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={Clock} label="Queued" value={stats?.queued ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={Loader} label="Running" value={stats?.running ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={CheckCircle} label="Completed" value={(stats?.completed ?? 0) + (stats?.done ?? 0)} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={XCircle} label="Failed" value={stats?.failed ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={Timer} label="Timed Out" value={stats?.timed_out ?? 0} isLoading={taskStatsQuery.isLoading} />
      </div>

      {/* Filter bar */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Project</Label>
          <Select
            value={filters.project_id ?? "__all__"}
            onValueChange={(v) =>
              updateFilter("project_id", v === "__all__" ? undefined : v)
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All projects</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select
            value={filters.status ?? "__all__"}
            onValueChange={(v) =>
              updateFilter(
                "status",
                v === "__all__" ? undefined : (v as TaskFilters["status"]),
              )
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              {TASK_STATUS_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Agent</Label>
          <Input
            placeholder="Filter by agent..."
            className="w-[160px]"
            defaultValue={filters.agent ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              updateFilter("agent", v || undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                updateFilter("agent", v || undefined);
              }
            }}
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Created after</Label>
          <input
            type="date"
            className="flex h-9 w-[150px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={
              filters.created_after
                ? filters.created_after.slice(0, 10)
                : ""
            }
            onChange={(e) => {
              const v = e.target.value;
              updateFilter(
                "created_after",
                v ? new Date(v).toISOString() : undefined,
              );
            }}
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Created before</Label>
          <input
            type="date"
            className="flex h-9 w-[150px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={
              filters.created_before
                ? filters.created_before.slice(0, 10)
                : ""
            }
            onChange={(e) => {
              const v = e.target.value;
              updateFilter(
                "created_before",
                v ? new Date(v).toISOString() : undefined,
              );
            }}
          />
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
            Failed to load tasks: {error.message}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {filterCount > 0
              ? "No tasks match the current filters."
              : "No tasks yet."}
          </p>
        )}
        {data && data.items.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Showing {showingFrom}–{showingTo} of {data.total} task
              {data.total !== 1 ? "s" : ""}
              {filterCount > 0 && ` (${filterCount} filter${filterCount > 1 ? "s" : ""} active)`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((task) => (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/tasks/${task.id}`)}
                  >
                    <TableCell>
                      <TaskStatusBadge status={task.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {String(task.id).slice(0, 8)}
                    </TableCell>
                    <TableCell>{task.agent ?? "-"}</TableCell>
                    <TableCell className="text-xs">
                      {formatTime(task.created_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDuration(task)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        {(task.status === "queued" || task.status === "assigned" || task.status === "running") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            disabled={cancelTaskMutation.isPending}
                            onClick={() => cancelTaskMutation.mutate(task.id)}
                          >
                            Cancel
                          </Button>
                        )}
                        {(task.status === "done" || task.status === "failed" || task.status === "timed_out") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={rerunTaskMutation.isPending}
                            onClick={() => rerunTaskMutation.mutate(task.id)}
                          >
                            Re-run
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
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
    </div>
  );
}
