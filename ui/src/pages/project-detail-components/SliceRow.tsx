import { useActivateSlice, useDeleteSlice } from "@/lib/hooks";
import type { PlanSliceTree } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageSquare, Trash2 } from "lucide-react";
import type { ChatContext } from "./types";
import { TaskRow } from "./TaskRow";

// --- Slice Row ---

export function SliceRow({
  projectId,
  milestoneId,
  slice,
  expanded,
  onToggle,
  autoExecActive,
  onOpenChat,
}: {
  projectId: string;
  milestoneId: string;
  slice: PlanSliceTree;
  expanded: boolean;
  onToggle: () => void;
  autoExecActive: boolean;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const activateSlice = useActivateSlice(projectId);
  const deleteSlice = useDeleteSlice(projectId);

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 pl-6 cursor-pointer hover:bg-muted/50 rounded"
        onClick={onToggle}
      >
        <span className="text-xs w-4">
          {(slice.tasks ?? []).length > 0 ? (expanded ? "\u25BE" : "\u25B8") : " "}
        </span>
        <span className="text-sm font-medium">{slice.title}</span>
        {statusBadge(slice.status)}
        <Badge variant="outline" className="text-xs">
          {slice.risk}
        </Badge>
        {slice.status === "pending" && !autoExecActive && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={activateSlice.isPending}
            onClick={(e) => {
              e.stopPropagation();
              activateSlice.mutate({ milestoneId, sliceId: slice.id });
            }}
          >
            Activate
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {onOpenChat && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => onOpenChat("slice", slice.id, milestoneId, undefined, slice.title)}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete slice "${slice.title}" and all its tasks?`)) {
                deleteSlice.mutate({ milestoneId, sliceId: slice.id });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {expanded &&
        (slice.tasks ?? []).map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projectId={projectId}
            milestoneId={milestoneId}
            sliceId={slice.id}
            onOpenChat={onOpenChat}
          />
        ))}
    </div>
  );
}
