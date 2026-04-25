import { Link } from "react-router-dom";
import { useDeletePlanTask } from "@/lib/hooks";
import type { PlanTask } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { MessageSquare, Trash2 } from "lucide-react";
import type { ChatContext } from "./types";

// --- Task Row ---

export function TaskRow({
  task,
  projectId,
  milestoneId,
  sliceId,
  onOpenChat,
}: {
  task: PlanTask;
  projectId: string;
  milestoneId: string;
  sliceId: string;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const deleteTask = useDeletePlanTask(projectId);
  return (
    <div className="flex items-center gap-2 py-1.5 pl-12">
      <span className="text-sm">{task.title}</span>
      {statusBadge(task.status)}
      {task.verification_passed === true && (
        <span className="text-green-600 text-xs" title="Verification passed">
          &#10003;
        </span>
      )}
      {task.verification_passed === false && (
        <span className="text-red-600 text-xs" title="Verification failed">
          &#10007;
        </span>
      )}
      {task.task_id && (
        <Link
          to={`/tasks/${task.task_id}`}
          className="text-xs text-blue-600 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          View Logs
        </Link>
      )}
      <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {onOpenChat && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onOpenChat("task", task.id, milestoneId, sliceId, task.title)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (window.confirm(`Delete task "${task.title}"?`)) {
              deleteTask.mutate({ milestoneId, sliceId, taskId: task.id });
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
