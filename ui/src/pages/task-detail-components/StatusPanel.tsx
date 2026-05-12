import { Link } from "react-router-dom";
import type { Task } from "@/lib/types/task";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/format";

/**
 * StatusPanel — right-rail panel summarising the task's run-state
 * essentials (M19/03). Reads everything off the parent's `task`
 * prop; no extra hooks. Purely presentational.
 *
 * Uses the canonical {@link formatTimestamp} from `@/lib/format`
 * (returns "-" for missing inputs); the previous local helper
 * returned em-dash ("—") and wrapped Date in a try/catch — both
 * unnecessary, since `new Date(invalid)` doesn't throw.
 */

export interface StatusPanelProps {
  task: Task;
  projectName?: string | null;
}

export function StatusPanel({ task, projectName }: StatusPanelProps) {
  return (
    <div data-testid="task-detail-status-panel" className="rounded-lg border bg-card p-3 text-sm">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        Status
      </h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">State</dt>
        <dd>
          <Badge variant="outline">{task.status}</Badge>
        </dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd className="text-[11px]">{formatTimestamp(task.started_at)}</dd>
        <dt className="text-muted-foreground">Completed</dt>
        <dd className="text-[11px]">{formatTimestamp(task.completed_at)}</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd className="font-mono text-[11px]">{task.permission_mode ?? "default"}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono text-[11px] truncate" title={task.actual_model_used ?? task.model ?? ""}>
          {task.actual_model_used ?? task.model ?? "—"}
        </dd>
        <dt className="text-muted-foreground">Project</dt>
        <dd className="truncate text-[11px]">
          {task.project_id ? (
            <Link to={`/projects/${task.project_id}`} className="underline-offset-2 hover:underline">
              {projectName ?? `#${task.project_id}`}
            </Link>
          ) : (
            "—"
          )}
        </dd>
      </dl>
    </div>
  );
}

export default StatusPanel;
