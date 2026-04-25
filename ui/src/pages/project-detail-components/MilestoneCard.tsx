import { useState } from "react";
import { useAutoExecStatus, useDeleteMilestone } from "@/lib/hooks";
import type { MilestoneTree } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare, Trash2, BookOpen } from "lucide-react";
import type { ChatContext } from "./types";
import { MilestoneReadmeDialog } from "./MilestoneReadmeDialog";
import { AutoExecControls } from "./AutoExecControls";
import { SliceRow } from "./SliceRow";

// --- Milestone Card ---

export function MilestoneCard({
  projectId,
  milestone,
  expanded,
  onToggle,
  expandedSlices,
  onToggleSlice,
  onOpenChat,
}: {
  projectId: string;
  milestone: MilestoneTree;
  expanded: boolean;
  onToggle: () => void;
  expandedSlices: Set<string>;
  onToggleSlice: (id: string) => void;
  onOpenChat?: (entityType: ChatContext["entity_type"], entityId: string, milestoneId: string | undefined, sliceId: string | undefined, title: string) => void;
}) {
  const { data: execStatus } = useAutoExecStatus(projectId, milestone.id, {
    refetchInterval: 30_000,
  });
  const autoExecActive = execStatus?.status === "active";
  const deleteMilestone = useDeleteMilestone(projectId);
  const [readmeOpen, setReadmeOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 flex-1">
          <span className="text-sm w-4">
            {expanded ? "\u25BE" : "\u25B8"}
          </span>
          <CardTitle className="text-base">{milestone.title}</CardTitle>
          {statusBadge(milestone.status)}
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="View README"
            onClick={() => setReadmeOpen(true)}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
          <MilestoneReadmeDialog
            open={readmeOpen}
            onOpenChange={setReadmeOpen}
            projectId={projectId}
            milestoneSlug={milestone.id}
            milestoneTitle={milestone.title}
          />
          {onOpenChat && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onOpenChat("milestone", milestone.id, undefined, undefined, milestone.title)}
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          )}
          <AutoExecControls projectId={projectId} milestone={milestone} />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete milestone "${milestone.title}" and all its slices/tasks?`)) {
                deleteMilestone.mutate(milestone.id);
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0">
          {milestone.slices.length === 0 && (
            <p className="text-sm text-muted-foreground pl-6">
              No slices yet.
            </p>
          )}
          {milestone.slices.map((slice) => (
            <SliceRow
              key={slice.id}
              projectId={projectId}
              milestoneId={milestone.id}
              slice={slice}
              expanded={expandedSlices.has(slice.id)}
              onToggle={() => onToggleSlice(slice.id)}
              autoExecActive={autoExecActive}
              onOpenChat={onOpenChat}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}
