import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useTasks } from "@/lib/hooks";
import { TaskStatus } from "@/lib/types";
import type { Project, Task } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { TaskStatusBadge } from "@/components/task-status-badge";

/**
 * Cross-project kanban surface for the /tasks page. Extracted from tasks.tsx
 * so the page file can focus on header + view-mode routing. No behaviour
 * changes — column definitions, card layout, and query parameters are
 * identical to the inline original.
 */

// Column definitions for the cross-project kanban. Statuses not matched by
// any column fall into the rightmost "Other" bucket so they remain visible
// instead of silently disappearing on a schema bump. Order is the operator's
// left-to-right pipeline mental model: queued → in flight → needs me →
// finished → broken.
const KANBAN_COLUMNS: readonly {
  key: string;
  label: string;
  matchStatuses: readonly TaskStatus[];
}[] = [
  {
    key: "queued",
    label: "Queued",
    matchStatuses: [TaskStatus.queued, TaskStatus.assigned],
  },
  {
    key: "running",
    label: "Running",
    matchStatuses: [TaskStatus.running],
  },
  {
    key: "pending_approval",
    label: "Pending Approval",
    matchStatuses: [TaskStatus.pending_approval],
  },
  {
    key: "done",
    label: "Done",
    matchStatuses: [TaskStatus.done],
  },
  {
    key: "failed",
    label: "Failed",
    matchStatuses: [TaskStatus.failed, TaskStatus.timed_out],
  },
] as const;

/**
 * Cross-project kanban: pulls every task across every project (capped at 200
 * to keep the swimlanes from collapsing under a huge backfill) and groups
 * them into status columns defined by `KANBAN_COLUMNS`. Each card surfaces
 * the project label, AI key label, and the model that actually ran (with
 * fallbacks), and clicks through to the task detail page — same target as
 * the table view, so navigation behaviour stays identical between modes.
 *
 * Cards are intentionally compact (no preview, no approve/reject inline) so
 * the operator can scan many columns at once. Approve/reject still lives on
 * the task detail page; users who need the inline action go through the
 * table's row-action column.
 */
export function TasksKanbanView() {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data, isLoading, error } = useTasks(0, 200, undefined, {
    refetchInterval: 10_000,
  });

  const projectLabels = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const p of (projects ?? []) as Project[]) {
      map[p.id] = p.name;
    }
    return map;
  }, [projects]);

  const tasks = data?.items ?? [];

  // Bucket tasks into the configured columns. Anything with a status that
  // isn't claimed by any column falls into "Other" so we never silently drop
  // rows on a schema bump.
  const { columnsWithTasks, otherTasks } = useMemo(() => {
    const claimed = new Set<string>();
    const buckets: Record<string, Task[]> = {};
    for (const col of KANBAN_COLUMNS) {
      buckets[col.key] = [];
      for (const s of col.matchStatuses) claimed.add(s);
    }
    const other: Task[] = [];
    for (const t of tasks) {
      const col = KANBAN_COLUMNS.find((c) =>
        (c.matchStatuses as readonly string[]).includes(t.status),
      );
      if (col) buckets[col.key]?.push(t);
      else if (!claimed.has(t.status)) other.push(t);
    }
    return { columnsWithTasks: buckets, otherTasks: other };
  }, [tasks]);

  if (isLoading) {
    return (
      <div
        data-testid="tasks-kanban-view"
        className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="tasks-kanban-view" className="mt-4">
        <p className="text-destructive">
          Failed to load tasks: {error.message}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="tasks-kanban-view"
      className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5"
    >
      {KANBAN_COLUMNS.map((col) => {
        const colTasks = columnsWithTasks[col.key] ?? [];
        return (
          <KanbanColumn
            key={col.key}
            label={col.label}
            columnKey={col.key}
            tasks={colTasks}
            projectLabels={projectLabels}
            onTaskClick={(t) => navigate(`/tasks/${t.id}`)}
          />
        );
      })}
      {otherTasks.length > 0 && (
        <KanbanColumn
          label="Other"
          columnKey="other"
          tasks={otherTasks}
          projectLabels={projectLabels}
          onTaskClick={(t) => navigate(`/tasks/${t.id}`)}
        />
      )}
    </div>
  );
}

/**
 * One swim-lane in the kanban grid. Empty columns still render so the layout
 * stays stable as tasks move between statuses (otherwise a swim-lane would
 * pop in/out and nudge neighbouring columns sideways).
 */
interface KanbanColumnProps {
  label: string;
  columnKey: string;
  tasks: Task[];
  projectLabels: Record<string, string>;
  onTaskClick: (task: Task) => void;
}

function KanbanColumn({
  label,
  columnKey,
  tasks,
  projectLabels,
  onTaskClick,
}: KanbanColumnProps) {
  return (
    <section
      aria-label={label}
      data-testid={`tasks-kanban-column-${columnKey}`}
      data-column-key={columnKey}
      className="flex min-h-[16rem] flex-col rounded-md border bg-muted/20 p-2"
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
          data-testid={`tasks-kanban-count-${columnKey}`}
        >
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {tasks.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No tasks.</p>
        ) : (
          tasks.map((task) => (
            <KanbanTaskCard
              key={task.id}
              task={task}
              projectLabel={
                task.project_id ? projectLabels[task.project_id] : undefined
              }
              onClick={() => onTaskClick(task)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/**
 * Compact card optimised for swimlane density. Surfaces the four facts an
 * operator needs to triage from the kanban without opening the detail page:
 *   * status badge (column header is implicit but redundancy is cheap)
 *   * project (cross-project kanban — without this you can't tell rows apart)
 *   * AI key label
 *   * model that actually ran (with fallback chain mirroring the table view)
 */
interface KanbanTaskCardProps {
  task: Task;
  projectLabel?: string | null;
  onClick: () => void;
}

function KanbanTaskCard({ task, projectLabel, onClick }: KanbanTaskCardProps) {
  const modelDisplay = task.actual_model_used ?? task.model ?? "Default";
  return (
    <Card
      size="sm"
      data-testid="tasks-kanban-card"
      data-task-id={task.id}
      className="cursor-pointer hover:bg-muted/40"
      onClick={onClick}
    >
      <CardContent className="space-y-1.5">
        <div className="flex items-center gap-2">
          <TaskStatusBadge status={task.status} />
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            #{String(task.id).slice(0, 8)}
          </span>
        </div>
        {projectLabel && (
          <p className="truncate text-xs font-medium" title={projectLabel}>
            {projectLabel}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <dt>AI Key</dt>
          <dd
            className="truncate text-foreground"
            data-testid="tasks-kanban-card-key"
            title={task.assigned_key_label ?? undefined}
          >
            {task.assigned_key_label ?? "-"}
          </dd>
          <dt>Model</dt>
          <dd
            className="truncate font-mono text-foreground"
            data-testid="tasks-kanban-card-model"
            title={modelDisplay}
          >
            {modelDisplay}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
