import {
  useWorkspaceDashboard,
  useWorkspaceDependencyGraph,
} from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";

import { DependencyGraphCard } from "./DependencyGraphCard";
import { ProjectsAccordion } from "./ProjectsAccordion";

/**
 * "Plan" tab of the redesigned workspace-detail page.
 *
 * Mirrors the loose structure of the project-detail {@link PlanTab}
 * (header band → primary content → secondary card below), but without
 * a slice board — workspaces do not own their own slices. The StatCard
 * grid and Recharts `BarChart` / `PieChart` that used to sit above the
 * accordion are intentionally NOT ported: the KPI bar rendered by the
 * workspace-detail page header (slice 00) is their replacement.
 *
 * Layout:
 *   1. {@link ProjectsAccordion} — per-project `<details>` disclosure
 *      listing each project's milestones. Extracted from the old
 *      inline "Project Overview" card in `workspace-detail.tsx`.
 *   2. {@link DependencyGraphCard} — wave-ordered milestone dependency
 *      graph. Rendered only when the graph has at least one node AND
 *      one wave; otherwise we emit nothing so the tab collapses to the
 *      accordion alone.
 */
export function WorkspacePlanTab({ workspaceId }: { workspaceId: string }) {
  const { data: dashboard, isLoading: dashboardLoading } =
    useWorkspaceDashboard(workspaceId);
  const { data: depGraph } = useWorkspaceDependencyGraph(workspaceId);

  if (dashboardLoading && !dashboard) {
    return (
      <div className="space-y-4" data-testid="workspace-plan-tab">
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const summaries = dashboard?.project_summaries ?? [];
  const hasGraph =
    !!depGraph && depGraph.nodes.length > 0 && depGraph.waves.length > 0;

  return (
    <div className="space-y-4" data-testid="workspace-plan-tab">
      <ProjectsAccordion summaries={summaries} />
      {hasGraph && <DependencyGraphCard graph={depGraph!} />}
    </div>
  );
}

export default WorkspacePlanTab;
