import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { FolderGit2, Plus } from "lucide-react";

import {
  useProjects,
  // Audit-round-5: WS-aware fallback so the 30s poll pauses when
  // the global WS is up (chat/task pushes already invalidate the
  // projects list) and on hidden tabs.
  useDeleteProject,
  useAttention,
  useWorkspaces,
} from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
import { slugify } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "@/components/design";

import {
  ProjectsToolbar,
  filterProjectsByQuery,
  useProjectsView,
  type ProjectsView,
} from "./projects-components/ProjectsToolbar";
import {
  FilterChips,
  FILTER_ALL,
  FILTER_PARAM,
  FILTER_STANDALONE,
} from "./projects-components/FilterChips";
import { groupByWorkspace } from "./projects-components/groupByWorkspace";
import { ProjectCard } from "./projects-components/ProjectCard";
import { ProjectsTable } from "./projects-components/ProjectsTable";
import { NewProjectDialog } from "./projects-components/NewProjectDialog";
import type { Project } from "@/lib/types";
import type { Workspace } from "@/lib/types";

/**
 * `/projects` page assembly (slice 23-02 T07).
 *
 * Composes the M22+ flat-primitive widgets that prior tasks built in
 * isolation:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ <SectionHeader title="Projects" subtitle="N total · N in        │
 *   │   workspaces · N standalone" action={<ProjectsToolbar/>} />     │
 *   │ <FilterChips />                                                  │
 *   │                                                                  │
 *   │ view === 'cards'                                                 │
 *   │   ?  per-workspace section header → 3-col grid of <ProjectCard/> │
 *   │      (standalone group rendered last under its own header)       │
 *   │   :  <ProjectsTable rows={filtered}/>                            │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * State plumbing:
 *
 *   - `?q=`     — read directly from `useSearchParams()`. The toolbar
 *                 commits typed input to this URL parameter on a 200 ms
 *                 debounce; the page re-reads it on every change.
 *   - `?filter=` — read directly from `useSearchParams()`. The chip row
 *                  writes via `setSearchParams({ replace: true })`. Allowed
 *                  values: `all` (also encoded as the absence of the
 *                  param), `standalone`, or any workspace slug.
 *   - `view`    — backed by localStorage. The page calls
 *                 `useProjectsView()` for its own copy and re-syncs
 *                 whenever the toolbar fires `onViewChange`.
 *
 * Data:
 *
 *   - `useProjects({ refetchInterval: 30_000 })` — main list.
 *   - `useWorkspaces({})`                        — needed for groupings + chip slugs.
 *   - `useAttention()`                           — counts surfaced as a
 *                                                  per-row "N waiting"
 *                                                  badge in the table view.
 *   - `useDeleteProject()`                       — kebab → confirm flow.
 */

const CARDS_GRID_CLASSES = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3";

// Each workspace gets a coloured swatch so the section headers in the cards
// view feel grounded. The palette is keyed off a stable hash of the
// workspace name so a workspace's colour doesn't drift between renders or
// reloads — and ordering of workspaces in the response cannot reshuffle
// who is "indigo" vs "amber".
const WORKSPACE_SWATCHES = [
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-pink-500",
  "bg-sky-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-teal-500",
] as const;

function pickSwatch(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % WORKSPACE_SWATCHES.length;
  return WORKSPACE_SWATCHES[index]!;
}

/**
 * Snapshot the whole filter contract for a single project — the predicate
 * used by both Cards and Table views so neither view can drift away from
 * the filter chip / search input the user actually clicked.
 */
function applyFilters(
  projects: Project[],
  filter: string,
  query: string,
  workspaceSlugById: Map<string | number, string>,
): Project[] {
  let rows = projects;

  if (filter === FILTER_STANDALONE) {
    rows = rows.filter(
      (p) => p.workspace_id === null || p.workspace_id === undefined,
    );
  } else if (filter !== FILTER_ALL) {
    rows = rows.filter((p) => {
      if (p.workspace_id === null || p.workspace_id === undefined) return false;
      const slug = workspaceSlugById.get(p.workspace_id);
      return slug === filter;
    });
  }

  if (query.trim()) {
    rows = filterProjectsByQuery(rows, query);
  }

  return rows;
}

export default function ProjectsPage() {
  const projectsRefetchInterval = useWsAwarePolling(30_000);
  const {
    data: projects,
    isLoading,
    error,
  } = useProjects({ refetchInterval: projectsRefetchInterval });
  const { data: workspaces } = useWorkspaces({});
  const deleteProject = useDeleteProject();
  const deleteConfirm = useConfirmDialog();
  const { items: attentionItems } = useAttention();

  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const filter = searchParams.get(FILTER_PARAM) ?? FILTER_ALL;

  // Page-local view state. The toolbar owns its own `useProjectsView` for
  // the segmented-control rendering; we mirror via `onViewChange` so the
  // page renders cards vs. table without re-importing the toolbar's state.
  const [view, setView] = useProjectsView();

  // Programmatic trigger ref so the empty-state CTA, toolbar button, and
  // SectionHeader action all open the same dialog rather than each owning
  // a copy. Lives at the page level so the dialog itself stays mounted
  // once and re-uses its internal scan/debounce timers across opens.
  const newProjectTriggerRef = useRef<HTMLButtonElement>(null);
  const openNewProjectDialog = () => newProjectTriggerRef.current?.click();

  // Attention counts grouped by project for the table view's "N waiting"
  // badge. Cards omit the badge because the live-dot already surfaces
  // active task state per the prototype.
  const attentionByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of attentionItems) {
      if (!item.project_id) continue;
      map.set(item.project_id, (map.get(item.project_id) ?? 0) + 1);
    }
    return map;
  }, [attentionItems]);

  const projectList: Project[] = projects ?? [];
  const workspaceList: Workspace[] = workspaces ?? [];

  // Slug index for chip filtering. The component derives slugs from
  // workspace names — keep this in step with FilterChipsWorkspace so a
  // chip click round-trips correctly back through `?filter=<slug>`.
  const workspaceSlugById = useMemo(() => {
    const map = new Map<string | number, string>();
    for (const ws of workspaceList) {
      map.set(ws.id, slugify(ws.name));
    }
    return map;
  }, [workspaceList]);

  // Counts go into the SectionHeader subtitle and the chips. Compute
  // before filtering so the chip badges stay stable as the user filters.
  const totalCount = projectList.length;
  const standaloneCount = projectList.filter(
    (p) => p.workspace_id === null || p.workspace_id === undefined,
  ).length;
  const groupedCount = totalCount - standaloneCount;

  const workspaceCounts = useMemo(() => {
    const map = new Map<string | number, number>();
    for (const p of projectList) {
      if (p.workspace_id === null || p.workspace_id === undefined) continue;
      map.set(p.workspace_id, (map.get(p.workspace_id) ?? 0) + 1);
    }
    return map;
  }, [projectList]);

  const chipWorkspaces = useMemo(
    () =>
      [...workspaceList]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((ws) => ({
          id: ws.id,
          name: ws.name,
          slug: workspaceSlugById.get(ws.id) ?? slugify(ws.name),
          count: workspaceCounts.get(ws.id) ?? 0,
        })),
    [workspaceList, workspaceSlugById, workspaceCounts],
  );

  // Filtered slice used by the Table view + the empty-state predicate.
  const filtered = useMemo(
    () => applyFilters(projectList, filter, query, workspaceSlugById),
    [projectList, filter, query, workspaceSlugById],
  );

  // Cards view groups the FILTERED list (not the raw list) so chip + search
  // narrow the headers too — picking `?filter=work` drops every other
  // section header rather than just emptying their grids.
  const grouped = useMemo(
    () =>
      groupByWorkspace(
        filtered.map((p) => ({
          ...p,
          last_activity_at: p.updated_at,
        })),
        workspaceList.map((w) => ({ id: w.id, name: w.name })),
      ),
    [filtered, workspaceList],
  );

  // Render-time guards
  const showLoading = isLoading;
  const showError = !!error;
  const showInitialEmpty =
    !isLoading && !error && projectList.length === 0;
  const showFilteredEmpty =
    !isLoading &&
    !error &&
    projectList.length > 0 &&
    filtered.length === 0;

  // Wire the toolbar's onViewChange to the page's view mirror (so the
  // toolbar's localStorage write and the page's render stay in lockstep
  // even though they each call `useProjectsView` independently).
  const handleViewChange = (next: ProjectsView) => {
    setView(next);
  };

  // The toolbar emits `onSearchChange` after debounced commits land in
  // the URL — we already read the URL directly via `useSearchParams`, so
  // a no-op listener is enough to satisfy the prop contract.
  const noopSearchChange = (_q: string) => undefined;

  // Pre-compute the page-level effects that touch the document title.
  // Pages that use SectionHeader skip rewriting <title> here — global
  // title management lives in the shell. This effect is intentionally
  // empty.
  useEffect(() => undefined, []);

  return (
    <div data-testid="projects-page" className="max-w-7xl">
      <SectionHeader
        title="Projects"
        subtitle={
          isLoading || error
            ? undefined
            : `${totalCount} total · ${groupedCount} in workspaces · ${standaloneCount} standalone`
        }
        action={
          <ProjectsToolbar
            onSearchChange={noopSearchChange}
            onViewChange={handleViewChange}
            onNewProject={openNewProjectDialog}
          />
        }
      />

      {!showLoading && !showError && projectList.length > 0 && (
        <div className="mb-4">
          <FilterChips
            totalCount={totalCount}
            standaloneCount={standaloneCount}
            workspaces={chipWorkspaces}
          />
        </div>
      )}

      {showLoading && (
        <div className="space-y-2" data-testid="projects-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {showError && (
        <p
          className="text-destructive"
          data-testid="projects-error"
        >
          Failed to load projects: {(error as Error)?.message}
        </p>
      )}

      {showInitialEmpty && (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          description="Add a project to start orchestrating tasks against a codebase."
          action={
            <Button
              type="button"
              size="sm"
              onClick={openNewProjectDialog}
              data-testid="projects-empty-cta"
            >
              <Plus aria-hidden="true" />
              New project
            </Button>
          }
          data-testid="projects-empty-state"
        />
      )}

      {showFilteredEmpty && (
        <EmptyState
          icon={FolderGit2}
          title="No projects match your filters"
          description="Try widening the filter or clearing the search."
          data-testid="projects-filtered-empty-state"
        />
      )}

      {!showLoading && !showError && projectList.length > 0 && filtered.length > 0 && (
        <>
          {view === "cards" ? (
            <CardsLayout
              grouped={grouped}
              attention={attentionByProject}
              onDelete={(id) => deleteConfirm.requestConfirm(id)}
            />
          ) : (
            <ProjectsTable
              rows={filtered.map((p) => {
                // `Workspace.id` is typed as `string` upstream while
                // `Project.workspace_id` is `number | null`. Coerce both
                // sides to a string for the comparison so a stringified
                // ID from the projects payload still matches its
                // workspace row.
                const ws = workspaceList.find(
                  (w) => String(w.id) === String(p.workspace_id),
                );
                return {
                  project: p,
                  workspace: ws
                    ? {
                        name: ws.name,
                        accentClassName: undefined,
                      }
                    : undefined,
                  lastActivity: p.updated_at,
                };
              })}
              onDelete={(id) => deleteConfirm.requestConfirm(id)}
            />
          )}
        </>
      )}

      {/*
        Mount the dialog once per page render — the trigger ref lets every
        affordance (toolbar button, empty-state CTA, future shortcuts) open
        the same dialog without remounting the form.
      */}
      <NewProjectDialog
        trigger={
          <button
            ref={newProjectTriggerRef}
            type="button"
            data-testid="new-project-hidden-trigger"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
        }
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Project"
        description="This will permanently delete the project and all its milestones, slices, and tasks. This action cannot be undone."
        isPending={deleteProject.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteProject.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}

interface CardsLayoutProps {
  grouped: ReturnType<typeof groupByWorkspace<
    Project & { last_activity_at: string },
    { id: string | number; name: string }
  >>;
  attention: Map<string, number>;
  onDelete?: (id: string) => void;
}

/**
 * Renders the per-workspace section headers + 3-col project-card grid that
 * make up the Cards view. Standalone projects come last under their own
 * "Standalone" header (matches the prototype's grouping order).
 *
 * Empty workspace groups (e.g. a workspace whose only project was filtered
 * out) are dropped so we never render a header followed by zero cards —
 * which would visually claim "this workspace is empty" when really the
 * filter just hides everything.
 */
function CardsLayout({ grouped, attention, onDelete }: CardsLayoutProps) {
  return (
    <div data-testid="projects-cards-layout" className="space-y-4">
      {grouped.workspaces.map(({ ws, projects }) => {
        if (projects.length === 0) return null;
        return (
          <section key={String(ws.id)} data-testid={`projects-section-ws-${ws.id}`}>
            <SectionHeader
              size="section"
              title={ws.name}
              subtitle={`${projects.length} ${projects.length === 1 ? "project" : "projects"}`}
              leadingSwatch={pickSwatch(ws.name)}
            />
            <div className={CARDS_GRID_CLASSES}>
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  workspace={{ name: ws.name }}
                  hasActiveTask={(attention.get(p.id) ?? 0) > 0}
                  onDelete={onDelete ? () => onDelete(p.id) : undefined}
                />
              ))}
            </div>
          </section>
        );
      })}
      {grouped.standalone.length > 0 && (
        <section data-testid="projects-section-standalone">
          <SectionHeader
            size="section"
            title="Standalone"
            subtitle={`${grouped.standalone.length} ${grouped.standalone.length === 1 ? "project" : "projects"}`}
            leadingSwatch="bg-zinc-400"
          />
          <div className={CARDS_GRID_CLASSES}>
            {grouped.standalone.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                hasActiveTask={(attention.get(p.id) ?? 0) > 0}
                onDelete={onDelete ? () => onDelete(p.id) : undefined}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
