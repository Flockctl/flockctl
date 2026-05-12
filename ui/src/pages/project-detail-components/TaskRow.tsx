import { Link } from "react-router-dom";
import { useDeletePlanTask } from "@/lib/hooks";
import type { PlanTask } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
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
  const deleteConfirm = useConfirmDialog();
  return (
    <div className="flex items-center gap-2 py-1.5 pl-12">
      <span className="text-sm">{task.title}</span>
      {statusBadge(task.status)}
      {/* Visible glyph + sr-only label so colour-blind / screen-reader
       *  users get the same verification signal. Audit-round-7 finding. */}
      {task.verification_passed === true && (
        <span className="text-green-600 text-xs" title="Verification passed" aria-label="Verification passed">
          <span aria-hidden="true">&#10003;</span>
          <span className="sr-only">Verification passed</span>
        </span>
      )}
      {task.verification_passed === false && (
        <span className="text-red-600 text-xs" title="Verification failed" aria-label="Verification failed">
          <span aria-hidden="true">&#10007;</span>
          <span className="sr-only">Verification failed</span>
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
            aria-label={`Open chat for task ${task.title}`}
            onClick={() => onOpenChat("task", task.id, milestoneId, sliceId, task.title)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          aria-label={`Delete task ${task.title}`}
          onClick={() => deleteConfirm.requestConfirm(task.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <ConfirmDialog
          open={deleteConfirm.open}
          onOpenChange={deleteConfirm.onOpenChange}
          title="Delete task?"
          description={`Delete "${task.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="destructive"
          isPending={deleteTask.isPending}
          onConfirm={() => {
            if (deleteConfirm.targetId) {
              deleteTask.mutate({ milestoneId, sliceId, taskId: deleteConfirm.targetId });
            }
          }}
        />
      </div>
    </div>
  );
}
