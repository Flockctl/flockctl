import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Plus } from "lucide-react";

import {
  useWorkspaces,
  useDeleteWorkspace,
  useProjects,
} from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
import type { Workspace } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

import { WorkspacesGrid } from "./workspaces-components/WorkspacesGrid";
import { NewWorkspaceDialog } from "./workspaces-components/NewWorkspaceDialog";
import type { WorkspaceCardData } from "./workspaces-components/WorkspaceCard";

/**
 * `/workspaces` page assembly (slice 23-03 T05).
 *
 * Composes the M22+ flat-primitive widgets prior tasks built in
 * isolation:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ <SectionHeader title="Workspaces" subtitle="N workspaces · M     │
 *   │   projects total" action={ search + + New workspace }/>          │
 *   │                                                                  │
 *   │ <WorkspacesGrid>                                                 │
 *   │   grid-cols-3 gap-3 of <WorkspaceCard/> + <AddWorkspaceCard/>    │
 *   │ </WorkspacesGrid>                                                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Why a single grid component (instead of a separate header + toolbar
 * + grid trio): workspaces has only one toolbar widget — search +
 * "+ New workspace" — and no view-toggle. Folding the SectionHeader
 * action slot, the search debounce, and the grid into one component
 * keeps the URL-`?q=` state local to the surface that consumes it.
 *
 * Data wiring is intentionally thin:
 *
 *   - `useWorkspaces({ refetchInterval: 30_000 })` — main list. Each
 *     row already carries `active_task_count` (added in slice T00) so
 *     the live-tasks indicator does not require a per-row fetch.
 *   - `useProjects()`                              — used to derive
 *     each workspace's project count + project-name fallback for the
 *     card description. One flat call, mapped client-side; no N+1.
 *   - `useDeleteWorkspace()`                       — kebab → confirm
 *     flow (the kebab itself is rendered by `<WorkspaceCard>`; this
 *     page owns the ConfirmDialog and the mutation).
 *
 * The dialog is rendered in **controlled mode** so every "New
 * workspace" affordance — the SectionHeader button, the dashed
 * `AddWorkspaceCard` placeholder, the empty-state CTA — opens the
 * exact same dialog instance rather than spawning a new copy.
 */

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const wsRefetchInterval = useWsAwarePolling(30_000);
  const {
    data: workspaces,
    isLoading,
    error,
  } = useWorkspaces({ refetchInterval: wsRefetchInterval });
  const { data: projects } = useProjects();
  const deleteWorkspace = useDeleteWorkspace();
  const deleteConfirm = useConfirmDialog();

  // Single dialog instance, opened by every "+ New workspace"
  // affordance the grid surfaces (header button, dashed
  // AddWorkspaceCard, future shortcuts). Lives at the page level so
  // the dialog form stays mounted between opens — re-mounting would
  // wipe the typed-but-not-yet-submitted state if the user closes the
  // dialog by mistake.
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = () => setDialogOpen(true);

  // Memoise the empty-array fallbacks so downstream `useMemo`s do not
  // see a fresh `[]` on every render — without this, the cards/groups
  // map below recomputes every render even when nothing changed.
  const workspaceList = useMemo<Workspace[]>(
    () => workspaces ?? [],
    [workspaces],
  );
  const projectList = useMemo(() => projects ?? [], [projects]);

  // project_id → workspace_id map for the project-count + last-activity
  // reducer below. Project rows carry `workspace_id: number | null`,
  // workspace ids are strings — coerce both sides to a string key so
  // the lookup matches regardless of the wire type.
  const projectsByWorkspace = useMemo(() => {
    const byWs = new Map<string, typeof projectList>();
    for (const p of projectList) {
      if (p.workspace_id == null) continue;
      const key = String(p.workspace_id);
      const list = byWs.get(key) ?? [];
      list.push(p);
      byWs.set(key, list);
    }
    return byWs;
  }, [projectList]);

  // Adapt each Workspace row into the props bag that <WorkspaceCard>
  // consumes. Done at the page level so the card stays presentation-
  // only — no react-query hooks inside the card means it remains
  // trivially unit-testable (and re-usable from a future search /
  // grouping page).
  const cards: WorkspaceCardData[] = useMemo(() => {
    return workspaceList.map<WorkspaceCardData>((ws) => {
      const projectsHere = projectsByWorkspace.get(String(ws.id)) ?? [];
      // Last activity is the newest `updated_at` across the workspace
      // row itself + any of its projects. The workspace's own
      // updated_at moves on metadata edits; project updated_at moves
      // when tasks land. Pick whichever is newer.
      const lastActivityAt =
        [ws.updated_at, ...projectsHere.map((p) => p.updated_at)]
          .filter((s): s is string => Boolean(s))
          .sort()
          .pop() ?? null;
      return {
        id: ws.id,
        name: ws.name,
        path: ws.path,
        description: ws.description,
        // No persistent "active" flag on the workspace row today; the
        // status pill is reserved for a future signal (e.g. mission
        // running). Keep the slot wired so a future addition is a
        // one-line change at this site only.
        active: false,
        projectCount: projectsHere.length,
        projectNames: projectsHere.map((p) => p.name),
        activeTaskCount: ws.active_task_count ?? 0,
        lastActivityAt,
      };
    });
  }, [workspaceList, projectsByWorkspace]);

  const totalCount = workspaceList.length;
  const totalProjectsInWorkspaces = useMemo(() => {
    let n = 0;
    for (const list of projectsByWorkspace.values()) n += list.length;
    return n;
  }, [projectsByWorkspace]);

  const subtitle =
    isLoading || error
      ? undefined
      : `${totalCount} ${totalCount === 1 ? "workspace" : "workspaces"} · ${totalProjectsInWorkspaces} ${totalProjectsInWorkspaces === 1 ? "project" : "projects"} total`;

  // Render-time guards — mutually exclusive states.
  const showLoading = isLoading;
  const showError = !!error;
  const showInitialEmpty =
    !isLoading && !error && workspaceList.length === 0;
  const showGrid =
    !isLoading && !error && workspaceList.length > 0;

  return (
    <div data-testid="workspaces-page" className={cn("max-w-7xl")}>
      {/*
        SectionHeader + toolbar + grid all live inside <WorkspacesGrid>.
        The grid is conditionally rendered alongside the loading /
        error / initial-empty states so we never paint two surfaces at
        once. The dialog is mounted once per page render, controlled
        by the page-level `dialogOpen` flag.
      */}
      {showLoading && (
        <div className="space-y-2" data-testid="workspaces-loading">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {showError && (
        <p className="text-destructive" data-testid="workspaces-error">
          Failed to load workspaces: {(error as Error).message}
        </p>
      )}

      {showInitialEmpty && (
        <EmptyState
          icon={Layers}
          title="No workspaces yet"
          description="Group related projects under a workspace to share secrets, schedules, and templates."
          action={
            <Button
              type="button"
              size="sm"
              onClick={openDialog}
              data-testid="workspaces-empty-cta"
            >
              <Plus aria-hidden="true" />
              New workspace
            </Button>
          }
          data-testid="workspaces-empty-state"
        />
      )}

      {showGrid && (
        <WorkspacesGrid
          workspaces={cards}
          subtitle={subtitle}
          onNewWorkspace={openDialog}
        />
      )}

      {/*
        Controlled dialog instance — one per page render. Every
        "+ New workspace" affordance calls `openDialog()` so the
        single mounted form is what the user sees regardless of which
        button triggered it.
      */}
      <NewWorkspaceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Workspace"
        description="This will permanently delete the workspace and remove all project associations. This action cannot be undone."
        isPending={deleteWorkspace.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteWorkspace.mutate(deleteConfirm.targetId, {
              onSuccess: () => {
                deleteConfirm.reset();
                navigate("/workspaces");
              },
            });
          }
        }}
      />
    </div>
  );
}
