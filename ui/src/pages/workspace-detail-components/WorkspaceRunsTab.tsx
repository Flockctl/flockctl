import { Link } from "react-router-dom";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, FolderPlus } from "lucide-react";
import type { Project } from "@/lib/types";

/**
 * "Runs" tab of the workspace-detail page.
 *
 * Runs are scoped per-project in Flockctl — the workspace has no
 * workspace-wide runs surface of its own. Rather than crowd the tab
 * with an empty placeholder chart grid, we render a structural empty
 * state that matches the vertical rhythm of the project Runs tab
 * (`project-detail-components/RunsTab.tsx`): a single `Card` shell so
 * the body sits at the same vertical position as in the Projects UI.
 *
 * The card body lists one outline-variant Button per workspace project
 * linking to that project's Runs tab. When the workspace has no
 * projects, the button row is replaced with a call-to-action that
 * takes the user to the Plan tab (where AddProjectDialog lives).
 *
 * Intentionally read-only and dependency-light — no data fetching, no
 * mutations, no analytics. Adding a workspace-wide runs aggregate is
 * a future milestone; keeping this tab as a pure router avoids
 * carving out a second planning surface in the meantime.
 */
export function WorkspaceRunsTab({
  workspaceId,
  projects,
}: {
  workspaceId: string;
  projects: Project[];
}) {
  const hasProjects = projects.length > 0;

  return (
    <div className="space-y-4" data-testid="workspace-runs-tab">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Runs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Runs are scoped per project. Open a project's Runs tab to see
            its execution history.
          </p>

          {hasProjects ? (
            <div
              className="flex flex-wrap gap-2"
              data-testid="workspace-runs-project-links"
            >
              {projects.map((project) => (
                <Button
                  key={project.id}
                  variant="outline"
                  size="sm"
                  asChild
                  data-testid={`workspace-runs-project-link-${project.id}`}
                >
                  <Link to={`/projects/${project.id}?tab=runs`}>
                    {project.name}
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              ))}
            </div>
          ) : (
            <div
              className="flex flex-col items-start gap-2 rounded-md border border-dashed p-4"
              data-testid="workspace-runs-empty-cta"
            >
              <p className="text-sm text-muted-foreground">
                This workspace has no projects yet. Add a project to start
                seeing runs.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/workspaces/${workspaceId}?tab=plan`}>
                  <FolderPlus className="mr-1.5 h-4 w-4" />
                  Add a project
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default WorkspaceRunsTab;
