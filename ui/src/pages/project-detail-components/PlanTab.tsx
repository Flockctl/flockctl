import { Loader2, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useGeneratePlanStatus,
  useProjectTree,
  useStartAutoExecuteAll,
} from "@/lib/hooks";

import { CreateMilestoneDialog } from "./CreateMilestoneDialog";
import { GeneratePlanDialog } from "./GeneratePlanDialog";
import { PlanEditorProvider } from "./plan-editor-context";
import { ProjectDetailBoardView } from "./ProjectDetailBoardView";

/**
 * "Plan" tab of the redesigned project-detail page — the board-only
 * mission-control view that replaced the old tree/board toggle.
 *
 * Layout is a vertical stack:
 *   1. a thin **action rail** with Auto-Execute All / Generate Plan /
 *      Create Milestone (same three controls the old tree view shipped
 *      above its planning tree);
 *   2. a **plan-generation banner** that appears while the agent is
 *      writing the plan, styled identically to the old one;
 *   3. the embedded {@link ProjectDetailBoardView} filling the remaining
 *      height — left rail = milestones, center = slice board, right rail
 *      = milestone/slice detail tabs with a new "Edit files" button that
 *      opens the Plan file-editor + chat modal through the provider
 *      wrapping this tab.
 *
 * The modal used to be owned by `ProjectDetailTreeView`; hoisting it
 * into {@link PlanEditorProvider} keeps the old flow alive in the
 * board-only world without losing the chat-on-files affordance. See
 * `plan-editor-context.tsx` for why we moved it to context rather than
 * prop-drilling.
 */
export function PlanTab({ projectId }: { projectId: string }) {
  const { data: planGenStatus } = useGeneratePlanStatus(projectId, {
    enabled: !!projectId,
  });
  const planGenerating = !!planGenStatus?.generating;

  const { data: tree } = useProjectTree(projectId, {
    refetchInterval: planGenerating ? 3_000 : 30_000,
  });
  const autoExecAll = useStartAutoExecuteAll(projectId);

  const hasMilestones = !!tree && tree.milestones.length > 0;

  return (
    <PlanEditorProvider projectId={projectId}>
      <div
        data-testid="project-plan-tab"
        className="flex h-full min-h-0 flex-col gap-3"
      >
        {/* Action rail */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {tree ? (
              <span>
                {tree.milestones.length} milestone
                {tree.milestones.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasMilestones && (
              <Button
                size="sm"
                variant="outline"
                disabled={autoExecAll.isPending || planGenerating}
                title={
                  planGenerating
                    ? "Plan is still being generated"
                    : undefined
                }
                onClick={() => {
                  if (
                    window.confirm(
                      "Start auto-execution for all milestones?",
                    )
                  ) {
                    autoExecAll.mutate();
                  }
                }}
                data-testid="plan-tab-auto-execute-all"
              >
                {autoExecAll.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="mr-1 h-4 w-4" />
                )}
                Auto-Execute All
              </Button>
            )}
            <GeneratePlanDialog projectId={projectId} />
            <CreateMilestoneDialog projectId={projectId} />
          </div>
        </div>

        {/* Plan-generation banner (visual parity with the old tree view) */}
        {planGenerating && (
          <div
            className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
            data-testid="plan-tab-generating-banner"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Plan is being generated
              {planGenStatus?.mode ? ` (${planGenStatus.mode} mode)` : ""}
              &hellip; milestones and slices will appear as the agent writes
              them. Launching is disabled until generation finishes.
            </span>
          </div>
        )}

        {/* Board fills the remaining height */}
        <div className="flex-1 min-h-0">
          <ProjectDetailBoardView projectId={projectId} embedded />
        </div>
      </div>
    </PlanEditorProvider>
  );
}

export default PlanTab;
