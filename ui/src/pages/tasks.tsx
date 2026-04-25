import { useTaskStats } from "@/lib/hooks";
import { StatCard } from "@/components/stat-card";
import { Hash, Clock, Loader, CheckCircle, XCircle, Timer, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useTasksViewMode,
  type TasksViewMode,
} from "@/lib/use-tasks-view-mode";
import { CreateTaskDialog, TasksTableView } from "@/pages/tasks-components/tasks-table";
import { TasksKanbanView } from "@/pages/tasks-components/tasks-kanban";

const VIEW_MODE_OPTIONS: readonly { value: TasksViewMode; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "kanban", label: "Kanban" },
] as const;

/**
 * Segmented three-way toggle for the /tasks page view mode. Mirrors the
 * pattern from ViewModeToggle in slice 00 task 03: reads + writes URL state
 * through `useTasksViewMode` (no local mirror, no imperative navigate), uses
 * aria-pressed + data-view-mode attributes for test/a11y hooks, and relies on
 * `{ replace: true }` inside the hook so clicks never add a history entry.
 */
interface TasksViewModeToggleProps {
  className?: string;
}

function TasksViewModeToggle({ className }: TasksViewModeToggleProps) {
  const { mode, setMode } = useTasksViewMode();
  return (
    <div
      role="group"
      aria-label="View mode"
      data-slot="tasks-view-mode-toggle"
      className={cn("inline-flex items-center gap-1", className)}
    >
      {VIEW_MODE_OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={active ? "secondary" : "outline"}
            aria-pressed={active}
            data-view-mode={opt.value}
            data-active={active ? "true" : undefined}
            onClick={() => setMode(opt.value)}
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * /tasks landing page. Renders the stat-card strip at the top plus either
 * the table view (default) or the cross-project kanban based on `?view=`
 * URL state. Heavy sub-trees live in `tasks-components/` so this file stays
 * focused on the header + stat cards + view-mode switch.
 */
export default function TasksPage() {
  const { mode } = useTasksViewMode();
  const taskStatsQuery = useTaskStats();
  const stats = taskStatsQuery.data;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold sm:text-2xl">Tasks</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            View, create, and monitor tasks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <TasksViewModeToggle />
          <CreateTaskDialog />
        </div>
      </div>

      {/* Task stat cards.
          "Failed" reports only the *still-broken* failures — a failed row whose
          rerun chain already landed on a successful terminal state is folded
          into Completed (and surfaced separately as "Build after re-run" so
          operators can see how often re-runs rescue the build).
          `failed_not_rerun` is the backend's count of failures without any
          rerun; we add superseded-timed_outs on the client side so timed-out
          rescues are reflected too (stats splits `failed_rerun`/`failed_not_rerun`
          for `failed` only). */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <StatCard icon={Hash} label="Total" value={stats?.total ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={Clock} label="Queued" value={stats?.queued ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard icon={Loader} label="Running" value={stats?.running ?? 0} isLoading={taskStatsQuery.isLoading} />
        <StatCard
          icon={CheckCircle}
          label="Completed"
          value={
            (stats?.completed ?? 0) +
            (stats?.done ?? 0) +
            (stats?.superseded_failures ?? 0)
          }
          isLoading={taskStatsQuery.isLoading}
        />
        <StatCard
          icon={RotateCw}
          label="Build after re-run"
          value={stats?.build_after_rerun ?? 0}
          isLoading={taskStatsQuery.isLoading}
        />
        <StatCard
          icon={XCircle}
          label="Failed"
          value={Math.max(
            0,
            (stats?.failed ?? 0) +
              (stats?.timed_out ?? 0) -
              (stats?.superseded_failures ?? 0),
          )}
          isLoading={taskStatsQuery.isLoading}
        />
        <StatCard icon={Timer} label="Timed Out" value={stats?.timed_out ?? 0} isLoading={taskStatsQuery.isLoading} />
      </div>

      {mode === "table" ? <TasksTableView /> : <TasksKanbanView />}
    </div>
  );
}
