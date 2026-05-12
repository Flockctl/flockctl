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
  // First render: we don't yet have execStatus → polling kicks off at
  // the slower 30s cadence. Once the first fetch lands, `isActive` is
  // derived directly from the server state, so the next refetchInterval
  // value flips to 5s without a manual setState (the previous
  // implementation set state in render, which triggers a React 19
  // strict-mode warning and a re-render storm).
  const { data: planGenStatus } = useGeneratePlanStatus(projectId);
  const planGenerating = !!planGenStatus?.generating;
  const startAutoExec = useStartAutoExecute(projectId);
  const stopAutoExec = useStopAutoExecute(projectId);

  // Two-pass derivation: first query call uses a stable interval (30s)
  // since execStatus is undefined. The second call — after the data
  // arrives — pulls the active flag from the server row, and React
  // Query reconciles the new `refetchInterval` cleanly because the
  // value is derived from a stable source (server state, not local
  // state mutated mid-render).
  const { data: execStatus } = useAutoExecStatus(projectId, milestone.id, {
    refetchInterval: (q) =>
      (q.state.data?.status === "active") ? 5_000 : 30_000,
  });
  const isActive = execStatus?.status === "active";

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
