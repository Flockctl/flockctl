import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { statusBadge } from "@/components/status-badge";
import {
  ConfirmDialog,
  useConfirmDialog,
} from "@/components/confirm-dialog";
import { useRemoveProjectFromWorkspace } from "@/lib/hooks";
import type { WorkspaceProjectSummary } from "@/lib/types";
import { AddProjectDialog } from "./AddProjectDialog";

/**
 * Per-project `<details>`/`<summary>` accordion, one entry per
 * {@link WorkspaceProjectSummary}. Each `<summary>` shows the project
 * name and milestone count; the expanded body lists the project's
 * milestones with a status badge and slice count.
 *
 * Header carries an {@link AddProjectDialog} trigger ("Add Project")
 * — this is the ONLY UI affordance for attaching a project to a
 * workspace, so it must remain visible even when the workspace has
 * zero projects (otherwise a fresh workspace is unreachable from the
 * UI and the user has to fall back to `flockctl workspace link`).
 *
 * Each row's `<summary>` carries a trailing "Remove" button that
 * detaches the project from this workspace via
 * `DELETE /workspaces/:id/projects/:projectId` (which sets
 * `workspaceId = NULL` — the project keeps existing standalone, it
 * is NOT deleted). The button is gated by a {@link ConfirmDialog} so
 * the user can't accidentally detach by mis-clicking the disclosure
 * row. Click handlers `stopPropagation` + `preventDefault` so the
 * native `<details>` doesn't toggle on Remove-click.
 *
 * Extracted from the old Project Overview card that used to live
 * inline in `workspace-detail.tsx`. We kept the native `<details>`
 * element on purpose — this milestone is about realignment with the
 * tabbed layout, not a rewrite of the disclosure affordance. A swap to
 * shadcn's `Collapsible` is deferred to a later slice.
 */
export function ProjectsAccordion({
  workspaceId,
  summaries,
}: {
  workspaceId: string;
  summaries: WorkspaceProjectSummary[];
}) {
  const existingProjectIds = summaries.map((s) => s.project_id);
  const removeProject = useRemoveProjectFromWorkspace();
  const removeConfirm = useConfirmDialog();

  // Look up the pending project's display name so the confirm
  // dialog can show "Remove <name> from workspace?" instead of an
  // opaque UUID. Falls back to the id if the row vanished between
  // open and confirm (e.g. a parallel refetch removed it).
  const pendingName =
    summaries.find((s) => s.project_id === removeConfirm.targetId)
      ?.project_name ?? removeConfirm.targetId;

  return (
    <Card data-testid="workspace-projects-accordion">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Project Overview</CardTitle>
        <AddProjectDialog
          workspaceId={workspaceId}
          existingProjectIds={existingProjectIds}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projects in this workspace yet. Click{" "}
            <span className="font-medium">Add Project</span> to attach an
            existing project.
          </p>
        ) : (
          summaries.map((ps) => (
            <details key={ps.project_id} className="group">
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                {ps.project_name}
                <span className="text-xs text-muted-foreground">
                  ({ps.milestone_count} milestones)
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 px-2 text-xs text-destructive hover:text-destructive"
                  data-testid={`workspace-project-remove-${ps.project_id}`}
                  aria-label={`Remove ${ps.project_name} from workspace`}
                  disabled={removeProject.isPending}
                  onClick={(e) => {
                    // The button lives inside <summary>, so a default
                    // click would toggle the parent <details>. Stop
                    // both flows so the dialog opens cleanly.
                    e.preventDefault();
                    e.stopPropagation();
                    removeConfirm.requestConfirm(ps.project_id);
                  }}
                >
                  Remove
                </Button>
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
          ))
        )}
      </CardContent>
      <ConfirmDialog
        open={removeConfirm.open}
        onOpenChange={removeConfirm.onOpenChange}
        title="Remove project from workspace"
        description={
          // We are intentionally explicit that this is detach, not
          // delete — the backend route sets `workspaceId = NULL` and
          // the project keeps existing as a standalone project.
          // Without this, "Remove" reads as "delete the project" and
          // users either avoid the button or use it to disastrous
          // effect.
          `"${pendingName}" will be detached from this workspace. The project itself ` +
          `will keep existing as a standalone project — its plan, runs, and config are not ` +
          `deleted, and you can re-attach it later via "Add Project".`
        }
        confirmLabel="Remove"
        isPending={removeProject.isPending}
        onConfirm={() => {
          if (removeConfirm.targetId) {
            removeProject.mutate(
              { workspaceId, projectId: removeConfirm.targetId },
              { onSuccess: () => removeConfirm.reset() },
            );
          }
        }}
      />
    </Card>
  );
}

export default ProjectsAccordion;
