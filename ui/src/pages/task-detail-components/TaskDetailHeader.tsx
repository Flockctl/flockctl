import { Link } from "react-router-dom";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import type { Task, TaskStatus } from "@/lib/types/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * TaskDetailHeader — refreshed header strip for the Task Detail page
 * (M19/01).
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← Back  T#abc123    [running]   timer        [Cancel]  [⋯] │
 *   │   short prompt preview                                       │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Behaviour bindings (per the M19/00 audit):
 *   - Primary action mapping:
 *       running / queued / assigned         → Cancel
 *       failed / timed_out / cancelled      → Re-run
 *       pending_approval                    → Approve
 *       done / waiting_for_input / other    → no primary; overflow only
 *   - Overflow menu surfaces every secondary action present today
 *     (Reject when pending, Save as incident, Open project, Open
 *     workspace, Copy id). The menu is rendered ONLY when the parent
 *     supplies the corresponding callback — unsupported actions
 *     simply don't appear, keeping the menu honest about what's
 *     reachable in the current state.
 *
 * The component is presentational: it takes a `task` plus a callback
 * bag. The page that mounts it owns the mutations (`useCancelTask`,
 * `useRerunTask`, etc.) and forwards them as the callbacks. This
 * keeps the audit's "click handlers call the same hooks as before"
 * contract trivially provable — the component never instantiates a
 * mutation hook itself.
 */

export interface TaskDetailHeaderProps {
  task: Task;
  /** Optional human-readable project name; falls back to id when null. */
  projectName?: string | null;
  /** Optional duration text rendered next to the status badge. */
  durationLabel?: string | null;
  /** Optional rate-limit countdown rendered next to the status badge. */
  rateLimitLabel?: string | null;

  // Primary actions
  onCancel?: () => void;
  cancelPending?: boolean;
  onRerun?: () => void;
  rerunPending?: boolean;
  onApprove?: () => void;
  approvePending?: boolean;

  // Overflow menu actions (omit to hide the row)
  onReject?: () => void;
  onSaveAsIncident?: () => void;
  onCopyTaskId?: () => void;
  onOpenProject?: () => void;
  onOpenWorkspace?: () => void;
  /**
   * Worktree teardown — only meaningful when `task.worktree_path` is
   * set (the task either ended dirty or is still mid-flight on an
   * isolated branch). The parent passes a callback that wires up
   * `DELETE /tasks/:id/worktree` and handles the 409-on-dirty
   * confirmation handshake. The menu item is hidden when no worktree
   * is recorded; we don't suppress the legacy non-isolated UI in any
   * way.
   */
  onRemoveWorktree?: () => void;
}

const statusVariant = (
  status: TaskStatus,
): "default" | "secondary" | "destructive" | "outline" => {
  switch (status) {
    case "done":
      return "secondary";
    case "running":
    case "queued":
      return "default";
    case "failed":
    case "timed_out":
      return "destructive";
    case "pending_approval":
    case "rate_limited":
    default:
      return "outline";
  }
};

function PrimaryAction(props: TaskDetailHeaderProps) {
  const { task } = props;
  if (
    (task.status === "running" || task.status === "queued") &&
    props.onCancel
  ) {
    return (
      <Button
        variant="destructive"
        size="sm"
        disabled={props.cancelPending}
        onClick={props.onCancel}
        data-testid="task-detail-action-cancel"
      >
        {props.cancelPending ? "Cancelling…" : "Cancel"}
      </Button>
    );
  }
  if (
    (task.status === "failed" || task.status === "timed_out") &&
    props.onRerun
  ) {
    return (
      <Button
        variant="default"
        size="sm"
        disabled={props.rerunPending}
        onClick={props.onRerun}
        data-testid="task-detail-action-rerun"
      >
        {props.rerunPending ? "Re-running…" : "Re-run"}
      </Button>
    );
  }
  if (task.status === "pending_approval" && props.onApprove) {
    return (
      <Button
        variant="default"
        size="sm"
        disabled={props.approvePending}
        onClick={props.onApprove}
        data-testid="task-detail-action-approve"
      >
        {props.approvePending ? "Approving…" : "Approve"}
      </Button>
    );
  }
  return null;
}

function OverflowMenu(props: TaskDetailHeaderProps) {
  const items: Array<{ key: string; label: string; onClick: () => void; destructive?: boolean }> = [];
  if (props.task.status === "pending_approval" && props.onReject) {
    items.push({ key: "reject", label: "Reject", onClick: props.onReject, destructive: true });
  }
  if (props.onSaveAsIncident) {
    items.push({ key: "incident", label: "Save as incident", onClick: props.onSaveAsIncident });
  }
  if (props.onOpenProject) {
    items.push({ key: "project", label: "Open project", onClick: props.onOpenProject });
  }
  if (props.onOpenWorkspace) {
    items.push({ key: "workspace", label: "Open workspace", onClick: props.onOpenWorkspace });
  }
  if (props.onCopyTaskId) {
    items.push({ key: "copy", label: "Copy task ID", onClick: props.onCopyTaskId });
  }
  if (props.task.worktree_path && props.onRemoveWorktree) {
    items.push({
      key: "worktree",
      label: "Remove worktree",
      onClick: props.onRemoveWorktree,
      destructive: true,
    });
  }
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="More actions"
          data-testid="task-detail-action-overflow"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((it, i) => (
          <span key={it.key}>
            {it.destructive && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={it.onClick}
              className={it.destructive ? "text-destructive focus:text-destructive" : ""}
            >
              {it.label}
            </DropdownMenuItem>
          </span>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskDetailHeader(props: TaskDetailHeaderProps) {
  const { task, projectName, durationLabel, rateLimitLabel } = props;
  const promptLine =
    typeof task.prompt === "string" && task.prompt.length > 0
      ? (task.prompt.split(/\r?\n/)[0] ?? "").slice(0, 120)
      : null;

  return (
    <header
      data-testid="task-detail-header"
      className="flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/tasks" className="inline-flex items-center gap-1 hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />
          <span>Tasks</span>
        </Link>
        {projectName && (
          <>
            <span aria-hidden="true">/</span>
            <span className="truncate">{projectName}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold" data-testid="task-detail-id">
          T#{String(task.id).slice(0, 8)}
        </span>
        <Badge variant={statusVariant(task.status)} data-testid="task-detail-status">
          {task.status}
        </Badge>
        {durationLabel && (
          <span className="text-xs text-muted-foreground" data-testid="task-detail-duration">
            {durationLabel}
          </span>
        )}
        {rateLimitLabel && (
          <span className="text-xs text-amber-600 dark:text-amber-400" data-testid="task-detail-rate-limit">
            {rateLimitLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PrimaryAction {...props} />
          <OverflowMenu {...props} />
        </div>
      </div>
      {promptLine && (
        <p className="truncate text-xs text-muted-foreground" title={promptLine}>
          {promptLine}
        </p>
      )}
    </header>
  );
}

export default TaskDetailHeader;
