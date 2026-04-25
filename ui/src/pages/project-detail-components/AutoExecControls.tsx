import { useState } from "react";
import {
  useAutoExecStatus,
  useStartAutoExecute,
  useStopAutoExecute,
  useGeneratePlanStatus,
} from "@/lib/hooks";
import type { MilestoneTree } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// --- Auto-Execution Controls ---

export function AutoExecControls({
  projectId,
  milestone,
}: {
  projectId: string;
  milestone: MilestoneTree;
}) {
  const [isActive, setIsActive] = useState(false);
  const { data: execStatus } = useAutoExecStatus(projectId, milestone.id, {
    refetchInterval: isActive ? 5_000 : 30_000,
  });
  const { data: planGenStatus } = useGeneratePlanStatus(projectId);
  const planGenerating = !!planGenStatus?.generating;

  // Track active state for polling speed
  if ((execStatus?.status === "active") !== isActive) {
    setIsActive(execStatus?.status === "active");
  }

  const startAutoExec = useStartAutoExecute(projectId);
  const stopAutoExec = useStopAutoExecute(projectId);

  return (
    <div className="flex items-center gap-3">
      {isActive && execStatus ? (
        <>
          <span className="text-sm text-muted-foreground">
            {execStatus.completed_slices}/{execStatus.total_slices} slices
          </span>
          {execStatus.current_slice_ids.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {execStatus.current_slice_ids.length} slice{execStatus.current_slice_ids.length > 1 ? "s" : ""} active
            </Badge>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={stopAutoExec.isPending}
            onClick={() => stopAutoExec.mutate(milestone.id)}
          >
            {stopAutoExec.isPending ? "Stopping..." : "Stop"}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={startAutoExec.isPending || planGenerating}
          title={planGenerating ? "Plan is still being generated" : undefined}
          onClick={() =>
            startAutoExec.mutate({ milestoneId: milestone.id })
          }
        >
          {startAutoExec.isPending ? "Starting..." : "Auto-Execute"}
        </Button>
      )}
    </div>
  );
}
