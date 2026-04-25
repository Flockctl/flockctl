import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { statusBadge } from "@/components/status-badge";
import type { WorkspaceProjectSummary } from "@/lib/types";

/**
 * Per-project `<details>`/`<summary>` accordion, one entry per
 * {@link WorkspaceProjectSummary}. Each `<summary>` shows the project
 * name and milestone count; the expanded body lists the project's
 * milestones with a status badge and slice count.
 *
 * Extracted verbatim from the old Project Overview card that used to
 * live inline in `workspace-detail.tsx`. We kept the native `<details>`
 * element on purpose — this milestone is about realignment with the
 * tabbed layout, not a rewrite of the disclosure affordance. A swap to
 * shadcn's `Collapsible` is deferred to a later slice.
 */
export function ProjectsAccordion({
  summaries,
}: {
  summaries: WorkspaceProjectSummary[];
}) {
  if (summaries.length === 0) {
    return null;
  }

  return (
    <Card data-testid="workspace-projects-accordion">
      <CardHeader>
        <CardTitle>Project Overview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {summaries.map((ps) => (
          <details key={ps.project_id} className="group">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              {ps.project_name}
              <span className="text-xs text-muted-foreground">
                ({ps.milestone_count} milestones)
              </span>
            </summary>
            <div className="mt-2 ml-4 space-y-2">
              {ps.tree.milestones.map((m) => (
                <div key={m.id} className="rounded border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{m.title}</span>
                    {statusBadge(m.status)}
                    <span className="text-xs text-muted-foreground">
                      {(m.slices ?? []).length} slices
                    </span>
                  </div>
                </div>
              ))}
              {ps.tree.milestones.length === 0 && (
                <p className="text-xs text-muted-foreground">No milestones</p>
              )}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

export default ProjectsAccordion;
