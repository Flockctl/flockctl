import { useParams, Navigate } from "react-router-dom";

import { CommitDetailTab } from "@/components/git/CommitDetailTab";

/**
 * Route surface for `/projects/:projectId/git/commit/:sha` and
 * `/workspaces/:workspaceId/git/commit/:sha`. The History list inside
 * the SCM panel navigates here when an operator clicks a commit row;
 * the rendered pane is the {@link CommitDetailTab} introduced in this
 * slice (file list + lazy per-file diff editor).
 *
 * The route is intentionally thin — all of the data flow lives in
 * `CommitDetailTab`. The page exists so the deep link is reachable
 * without having to first land on the project / workspace shell, which
 * is important for sharing a commit URL across team members.
 */
export function ProjectCommitDetailPage() {
  const { projectId, sha } = useParams<{ projectId: string; sha: string }>();
  if (!projectId || !sha) return <Navigate to="/projects" replace />;
  return (
    <div className="h-full w-full">
      <CommitDetailTab scope="projects" entityId={projectId} sha={sha} />
    </div>
  );
}

export function WorkspaceCommitDetailPage() {
  const { workspaceId, sha } = useParams<{
    workspaceId: string;
    sha: string;
  }>();
  if (!workspaceId || !sha) return <Navigate to="/workspaces" replace />;
  return (
    <div className="h-full w-full">
      <CommitDetailTab
        scope="workspaces"
        entityId={workspaceId}
        sha={sha}
      />
    </div>
  );
}

export default ProjectCommitDetailPage;
