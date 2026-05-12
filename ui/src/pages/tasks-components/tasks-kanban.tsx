import { memo, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useTasks } from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
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
    matchStatuses: [TaskStatus.queued],
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

// Module-scope status→column lookup. KANBAN_COLUMNS is static so we can
// pre-flatten it once at module init; previously every render walked the
// columns array via `.find(... includes(...))` for every task — O(tasks × cols
// × statuses-per-col). Now lookup is O(1) per task.
const STATUS_TO_COLUMN_KEY: ReadonlyMap<string, string> = new Map(
  KANBAN_COLUMNS.flatMap((col) =>
    col.matchStatuses.map((s) => [s as string, col.key] as const),
  ),
);

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
  // WS-aware polling — see tasks-table.tsx for rationale. Kanban shares
  // the same task_* WS channel for live updates; polling is duplicate
  // work when the socket is up.
  const taskRefetchInterval = useWsAwarePolling(10_000);
  const { data, isLoading, error } = useTasks(0, 200, undefined, {
    refetchInterval: taskRefetchInterval,
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
  // Stable callback so KanbanTaskCard's `memo` actually hits — without
  // useCallback every parent render would allocate a fresh function
  // and break the memo on every card (audit-round-5).
  const handleTaskClick = useCallback(
    (taskId: string) => navigate(`/tasks/${taskId}`),
    [navigate],
  );

  // isn't claimed by any column falls into "Other" so we never silently drop
  // rows on a schema bump.
  const { columnsWithTasks, otherTasks } = useMemo(() => {
    const buckets: Record<string, Task[]> = {};
    for (const col of KANBAN_COLUMNS) {
      buckets[col.key] = [];
    }
    const other: Task[] = [];
    for (const t of tasks) {
      const colKey = STATUS_TO_COLUMN_KEY.get(t.status);
      if (colKey !== undefined) buckets[colKey]?.push(t);
      else other.push(t);
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
            onTaskClick={handleTaskClick}
          />
        );
      })}
      {otherTasks.length > 0 && (
        <KanbanColumn
          label="Other"
          columnKey="other"
          tasks={otherTasks}
          projectLabels={projectLabels}
          onTaskClick={handleTaskClick}
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
  /** Receives the task id so the parent's `useCallback` can stay
   *  reference-stable across renders. See KanbanTaskCardProps for the
   *  same rationale at the leaf. */
  onTaskClick: (taskId: string) => void;
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
              // KanbanTaskCard binds task.id inside via useCallback; we
              // can forward the parent's stable id-callback straight
              // through without allocating a new closure per render.
              onClick={onTaskClick}
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
  /**
   * Called with the card's task id when clicked. Audit-round-5 change:
   * accept the id rather than a bound `() => void` so the parent can
   * memoise this callback once (instead of allocating a fresh arrow
   * per task on every render of the column). Combined with `memo`,
   * tasks whose status hasn't changed skip the re-render entirely.
   */
  onClick: (taskId: string) => void;
}

const KanbanTaskCard = memo(function KanbanTaskCard({
  task,
  projectLabel,
  onClick,
}: KanbanTaskCardProps) {
  const handleClick = useCallback(() => onClick(task.id), [onClick, task.id]);
  const modelDisplay = task.actual_model_used ?? task.model ?? "Default";
  return (
    <Card
      size="sm"
      data-testid="tasks-kanban-card"
      data-task-id={task.id}
      className="cursor-pointer hover:bg-muted/40"
      onClick={handleClick}
    >
      <CardContent className="space-y-1.5">
        <div className="flex items-center gap-2">
          <TaskStatusBadge status={task.status} resumeAt={task.resume_at} />
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
});
