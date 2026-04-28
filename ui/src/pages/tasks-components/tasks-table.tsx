import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useCancelTask,
  useCreateTask,
  useProjects,
  useRerunTask,
  useTasks,
} from "@/lib/hooks";
import { formatTime } from "@/lib/format";
import { TaskStatus } from "@/lib/types";
import type { Task, TaskCreate, TaskFilters } from "@/lib/types";
import { TaskStatusBadge } from "@/components/task-status-badge";
import { TaskFormFields, defaultTaskFormValues } from "@/components/task-form-fields";
import type { TaskFormValues } from "@/components/task-form-fields";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

/**
 * Filters bar + tabular listing for the /tasks page. Extracted from tasks.tsx
 * together with the create-task dialog and their shared helpers so the page
 * file stays focused on view-mode routing + stat cards. No behaviour changes:
 *   - Saved filters (URL `project_id`) still round-trip.
 *   - "Show superseded" toggle still maps to the `include_superseded` query.
 *   - Paging cursor + `PAGE_SIZE` are preserved byte-for-byte.
 */

const PAGE_SIZE = 20;

const TASK_STATUS_VALUES: TaskStatus[] = [
  TaskStatus.queued,
  TaskStatus.assigned,
  TaskStatus.running,
  TaskStatus.done,
  TaskStatus.failed,
  TaskStatus.timed_out,
];

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

function activeFilterCount(filters: TaskFilters): number {
  return Object.values(filters).filter(
    (v) => v !== undefined && v !== null && v !== "",
  ).length;
}

/**
 * Create-task dialog — trigger button + modal form. Owns its own open state,
 * form values, and submission flow; no props because the /tasks page header
 * only needs it to render inline at the top-right.
 */
export function CreateTaskDialog() {
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

/**
 * The pre-slice Tasks page — filters bar + table — rendered *byte-for-byte*
 * identically to the legacy implementation. Saved filters and workflows are
 * tied to this view, so the structure (and test hooks) must not drift.
 */
export function TasksTableView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = searchParams.get("project_id") ?? undefined;
  const [filters, setFilters] = useState<TaskFilters>(
    initialProjectId ? { project_id: initialProjectId } : {},
  );
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const { data: projects } = useProjects();

  const { data, isLoading, error } = useTasks(offset, PAGE_SIZE, filters, {
    refetchInterval: 10_000,
  });
  const cancelTaskMutation = useCancelTask();
  const rerunTaskMutation = useRerunTask();

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
    <div data-testid="tasks-table-view">
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

        {/* Superseded toggle — by default the list hides failed/timed_out rows
            whose rerun chain already succeeded (the red row is noise once the
            build is green). Flip this on to audit the full history. */}
        <div className="space-y-1">
          <Label
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
            htmlFor="show-superseded"
            title="Show failed tasks whose re-run already succeeded"
          >
            <input
              id="show-superseded"
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={filters.include_superseded === true}
              onChange={(e) =>
                updateFilter(
                  "include_superseded",
                  e.target.checked ? true : undefined,
                )
              }
              data-testid="tasks-show-superseded-toggle"
            />
            Show superseded
          </Label>
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
                  <TableHead>AI Key</TableHead>
                  <TableHead>Model</TableHead>
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
                      <TaskStatusBadge
                        status={task.status}
                        resumeAt={task.resume_at}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {String(task.id).slice(0, 8)}
                    </TableCell>
                    <TableCell data-testid="tasks-row-key">
                      {task.assigned_key_label ?? "-"}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs"
                      data-testid="tasks-row-model"
                    >
                      {/* Prefer the model the provider actually used (from
                          usage_records). Fall back to the requested model
                          (task.model) and finally to "Default" so rows that
                          haven't run yet still tell the operator something. */}
                      {task.actual_model_used ?? task.model ?? "Default"}
                    </TableCell>
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
                        {(task.status === "failed" || task.status === "timed_out") && (
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
