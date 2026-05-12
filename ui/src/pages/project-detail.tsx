import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTrackRecent } from "@/lib/recent-store";
import { ListChecks, MessageSquare } from "lucide-react";

import {
  useAttention,
  useCreateChat,
  useProject,
  useProjectConfig,
  useProjectTree,
} from "@/lib/hooks";
import { useKpiData } from "@/lib/use-kpi-data";
import { useSelection } from "@/lib/use-selection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TodoMdDialog } from "@/components/todo-md-dialog";
import { GitDropdownButton } from "@/components/git/git-dropdown-button";

import { ConfigTab } from "./project-detail-components/ConfigTab";
import { MilestoneKanban } from "./project-detail-components/MilestoneKanban";
import { MilestoneRail } from "./project-detail-components/MilestoneRail";
import { ProjectKpiRow } from "./project-detail-components/ProjectKpiRow";
import { ProjectTreePanel } from "./project-detail-components/ProjectTreePanel";
import {
  PROJECT_TAB_IDS,
  ProjectTabs,
  type ProjectTabId,
} from "./project-detail-components/ProjectTabs";
// `RunsTab` pulls in `recharts` for the spend/tokens charts. Users on
// the Plan / Code / Config tabs never need it — lazy-load the tab so
// the recharts chunk only downloads when the Runs tab is opened.
// Audit-round-7 BUNDLE finding.
const RunsTab = lazy(() =>
  import("./project-detail-components/RunsTab").then((m) => ({
    default: m.RunsTab,
  })),
);

// `ProjectCodeMode` pulls in `react-arborist` (file tree) plus a chain that
// reaches Monaco editor / shiki / the chat composer. Most project-detail
// visits stay on Plan / Runs / Config — lazy-load the tab so the Code
// chunk only downloads when the user actually opens the Code tab.
const ProjectCodeMode = lazy(() =>
  import("./project-detail-components/CodeMode").then((m) => ({
    default: m.ProjectCodeMode,
  })),
);

/**
 * Project-detail page shell — assembled from the M23 redesign primitives.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ProjectHeader  (title · attention badge · repo badges · CTAs)   │
 *   │ ProjectKpiRow  (5 tiles wired through useKpiData)               │
 *   │ ProjectTabs    (URL-driven `?tab=` segmented strip)             │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ {tab === "plan"} → MilestoneRail | MilestoneKanban (260px / 1fr)│
 *   │ {tab === "tree"} → ProjectTreePane (mission/milestone/slice/task)│
 *   │ {tab === "runs"} → RunsTab                                      │
 *   │ {tab === "code"} → ProjectCodeMode                              │
 *   │ {tab === "config"} → ConfigTab                                  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Assembly invariants (pinned by `project-detail.test.tsx`):
 *   - The page body renders the header → KPI row → tab strip in order.
 *     None of the three is conditional on the active tab.
 *   - The active tab swaps **only** the inner pane. Switching tabs does
 *     NOT remount the page chrome (header / KPI / tabs). The test pins
 *     this with stable element identities across `userEvent.click` calls.
 *   - The Plan pane is the **only** branch that renders `MilestoneRail`
 *     + `MilestoneKanban` directly. Every other tab delegates to its
 *     dedicated tab component (`RunsTab`, `ProjectCodeMode`,
 *     `TemplatesAndSchedulesTab`, `ConfigTab`).
 *
 * URL state:
 *   - `?tab=<plan|runs|code|templates|config>` — driven by `<ProjectTabs>`.
 *     A missing or unknown value falls back to `"plan"` (the default).
 *   - `?milestone=<slug>` — drives the `MilestoneRail` selection. When the
 *     URL has no milestone but the project has at least one, we fall
 *     back to the first milestone so the kanban is never blank.
 */

const TAB_SET = new Set<string>(PROJECT_TAB_IDS);

function isTabId(value: string | null): value is ProjectTabId {
  return !!value && TAB_SET.has(value);
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const createChat = useCreateChat();

  const tab: ProjectTabId = isTabId(searchParams.get("tab"))
    ? (searchParams.get("tab") as ProjectTabId)
    : "plan";

  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
  } = useProject(projectId ?? "", { enabled: !!projectId });

  // Populate the new-shell sidebar Recent list. No-op when params or
  // project name aren't ready; safe to call even when the OLD shell
  // is active (the recent store survives across shells).
  useTrackRecent({
    kind: "project",
    id: projectId,
    label: project?.name,
    href: `/projects/${projectId ?? ""}`,
  });

  const { data: projectConfig } = useProjectConfig(projectId ?? "");
  const baseBranch = projectConfig?.baseBranch ?? "main";

  const { items: attentionItems } = useAttention();
  const attentionCount = useMemo(() => {
    if (!projectId) return 0;
    let count = 0;
    for (const item of attentionItems) {
      if (item.project_id === projectId) count += 1;
    }
    return count;
  }, [attentionItems, projectId]);

  const [todoOpen, setTodoOpen] = useState(false);

  // KPI data — useKpiData returns `costCents24h`; ProjectKpiRow wants
  // dollars. Convert here so the row stays purely presentational.
  const kpi = useKpiData(projectId ?? "");
  const costUsd =
    typeof kpi.costCents24h === "number"
      ? kpi.costCents24h / 100
      : undefined;

  // Plan tab data: project tree drives MilestoneRail + MilestoneKanban.
  // Skip the fetch on tabs that don't need it (Runs / Code / Config) so
  // we don't pay for a (potentially heavy) tree response on a project
  // that's only being browsed for analytics or files. The Tree pane
  // re-fetches the same tree internally via its own ProjectTreePanel —
  // react-query dedupes by the shared `["project", id, "tree"]` cache
  // key so the second mount is free.
  const { data: tree } = useProjectTree(projectId ?? "", {
    enabled: !!projectId && tab === "plan",
  });
  const milestones = tree?.milestones ?? [];

  const { milestoneId, setMilestone } = useSelection();
  // Prefer the URL `?milestone=` value; fall back to the first milestone
  // so the kanban never renders against an unknown selection.
  const activeMilestoneId =
    milestoneId && milestones.some((m) => m.id === milestoneId)
      ? milestoneId
      : milestones[0]?.id ?? null;
  const activeMilestone = useMemo(
    () => milestones.find((m) => m.id === activeMilestoneId) ?? null,
    [milestones, activeMilestoneId],
  );

  // Sync the URL with the implicit fallback so a copy-pasted link to
  // `/projects/p1?tab=plan` lands on the same milestone the user was
  // looking at when they shared it. Only writes when the URL is empty
  // and we genuinely picked a fallback.
  useEffect(() => {
    if (tab !== "plan") return;
    if (!milestoneId && activeMilestoneId) {
      setMilestone(activeMilestoneId);
    }
  }, [tab, milestoneId, activeMilestoneId, setMilestone]);

  if (!projectId) {
    return <p className="text-destructive">Missing project ID.</p>;
  }

  if (projectError) {
    return (
      <p className="text-destructive">
        Failed to load project: {projectError.message}
      </p>
    );
  }

  return (
    <div
      data-testid="project-detail-page"
      // Constrain the page to the app's inner main (`flex-1 overflow-auto`
      // in layout.tsx). The custom property makes it explicit that the
      // Plan / Code panes are carving ~280px off the viewport for the
      // page chrome above them — kept as a CSS var so tweaking the height
      // of the header does not require touching the panes.
      style={{ "--project-chrome-h": "280px" } as React.CSSProperties}
      className="flex min-h-full flex-col"
    >
      {/* --- Page header --- */}
      <header
        data-testid="project-detail-header"
        className="mb-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {projectLoading || !project ? (
                <Skeleton className="h-7 w-48" />
              ) : (
                <h1 className="truncate text-[15px] font-semibold leading-tight" title={project.name}>
                  {project.name}
                </h1>
              )}
              {attentionCount > 0 && (
                <Badge
                  variant="destructive"
                  className="cursor-pointer"
                  aria-label={`${attentionCount} item${attentionCount === 1 ? "" : "s"} waiting on you`}
                  onClick={() => navigate("/attention")}
                >
                  {attentionCount} waiting
                </Badge>
              )}
            </div>
            {project?.description && (
              <p className="mt-1 text-muted-foreground">{project.description}</p>
            )}
            {project && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {project.repo_url && (
                  <Badge variant="secondary" className="font-mono">
                    {project.repo_url}
                  </Badge>
                )}
                <Badge variant="outline" className="font-mono">
                  {baseBranch}
                </Badge>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground/40 text-[10px]"
                >
                  ·
                </span>
                <ProjectKpiRow
                  compact
                  slicesDone={kpi.slicesDone}
                  slicesTotal={kpi.slicesTotal}
                  activeTasks={kpi.activeTasks}
                  pendingApproval={kpi.pendingApproval}
                  failed24h={kpi.failed24h}
                  costUsd={costUsd}
                />
              </div>
            )}
          </div>

          {/*
            Header right cluster — mirrors the prototype at
            `.flockctl/plan/ui-prototype.html` (project-detail bar):
            tab strip lives in the SAME row as the project title, with
            a "New chat" CTA flush to its right and the secondary
            actions (TODO, Git) on the same line.

            The strip used to live on its own row beneath the KPI bar;
            promoting it into the header eats one full row of vertical
            real estate and matches the prototype's hierarchy
            (project name → tab strip → content) without an
            interleaving KPI band breaking the visual grouping.

            Order — Tabs / New chat / TODO / Git — keeps the prototype's
            primary "switch view" → "spawn chat" pairing tight and
            pushes the lower-frequency overflow buttons to the right.
          */}
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="project-detail-header-actions"
          >
            <ProjectTabs data-testid="project-detail-tabs" />
            <Button
              variant="outline"
              size="sm"
              disabled={createChat.isPending || !project}
              onClick={() => {
                if (!project) return;
                createChat
                  .mutateAsync({ project_id: project.id })
                  .then((chat) => navigate(`/chats/${chat.id}`));
              }}
              data-testid="project-detail-page-chat"
            >
              <MessageSquare className="mr-1 h-4 w-4" />
              {createChat.isPending ? "Creating…" : "New chat"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTodoOpen(true)}
              data-testid="project-detail-page-todo"
            >
              <ListChecks className="mr-1 h-4 w-4" />
              TODO
            </Button>
            {project && (
              <GitDropdownButton
                target={{
                  kind: "project",
                  id: project.id,
                  path: project.path,
                }}
              />
            )}
          </div>
        </div>
      </header>

      {/* KPI row used to live here as a 5-column grid of full-size
          tiles. It now rides along the repo/branch line in the header
          via `<ProjectKpiRow compact />` — the numbers are mostly zero
          on a fresh project and burning a full strip on them was
          wasted vertical real estate. */}

{/* --- Active pane (conditional, only the inner pane swaps) --- */}
      {/*
        The pane carries the WAI-ARIA `role="tabpanel"` plus the matching
        `id` referenced by `<ProjectTabs>`'s `aria-controls`. Without the
        id, axe flags `aria-valid-attr-value` (critical) on the tab
        buttons because the controls reference points at a non-existent
        node. The `id` shape (`project-tabpanel-<tab>`) is the contract
        the tab strip pins down — keep them in sync.
      */}
      <div
        data-testid="project-detail-pane"
        data-active-tab={tab}
        role="tabpanel"
        id={`project-tabpanel-${tab}`}
        aria-labelledby={`project-tab-${tab}`}
        // Plan and Code each need a bounded height so their internal
        // `h-full` panels can fill the viewport. Other tabs are
        // content-sized.
        //
        // The pane uses an explicit `h-[calc(100vh - chrome)]` rather
        // than relying on `flex-1` because the project-detail outer
        // container is `min-h-full` (NOT `h-full`) — `min-height` alone
        // does not establish a definite height for percentage / flex
        // resolution in the children, so a `flex-1` pane collapses to
        // its content height instead of filling the viewport. The
        // `--project-chrome-h` CSS var (set on the outer div) measures
        // the header + KPI row + tab strip stack so tweaking that chrome
        // doesn't require touching the pane class. The `min-h-[400px]`
        // floor protects short-viewport screens from a degenerate
        // 0-height editor when chrome is bigger than the visible area.
        className={
          tab === "plan" || tab === "code" || tab === "tree"
            ? "flex h-[calc(100vh-var(--project-chrome-h))] min-h-[400px] flex-col"
            : undefined
        }
      >
        {tab === "plan" && (
          <div
            data-testid="project-detail-plan-pane"
            // 260px milestone rail + remaining width for the kanban.
            className="grid flex-1 min-h-0 grid-cols-[260px_1fr] gap-4"
          >
            <MilestoneRail
              milestones={milestones}
              activeMilestoneId={activeMilestoneId}
              onSelectMilestone={(id) => setMilestone(id)}
            />
            <div className="min-w-0 overflow-auto">
              {activeMilestone ? (
                <MilestoneKanban
                  milestoneTitle={activeMilestone.title}
                  slices={activeMilestone.slices}
                />
              ) : (
                <div
                  data-testid="project-detail-plan-empty"
                  className="grid h-full place-items-center text-sm text-muted-foreground"
                >
                  No milestones yet — generate a plan to get started.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "tree" && (
          <ProjectTreePane projectId={projectId} />
        )}

        {tab === "runs" && (
          <Suspense
            fallback={
              <div
                aria-busy="true"
                style={{ height: 500 }}
                className="rounded-md border border-border bg-card animate-pulse"
              />
            }
          >
            <RunsTab projectId={projectId} />
          </Suspense>
        )}

        {tab === "code" && project && (
          <Suspense
            fallback={
              <div
                aria-busy="true"
                style={{ height: 500 }}
                className="rounded-md border border-border bg-card animate-pulse"
              />
            }
          >
            <ProjectCodeMode
              // `key` makes a project-id change remount the subtree —
              // see CodeMode.tsx for why that's the reset mechanism.
              key={projectId}
              projectId={projectId}
              target={{
                kind: "project",
                id: project.id,
                path: project.path,
              }}
            />
          </Suspense>
        )}

        {tab === "config" && <ConfigTab projectId={projectId} />}
      </div>

      {project && (
        <TodoMdDialog
          scope="project"
          projectId={projectId}
          open={todoOpen}
          onOpenChange={setTodoOpen}
          title={project.name}
        />
      )}
    </div>
  );
}

/**
 * Plain hierarchical mission → milestone → slice → task view. Wraps the
 * existing {@link ProjectTreePanel} (already battle-tested against
 * keyboard navigation + selection sync) and forwards selection back
 * into the URL via {@link useSelection} so a click drills into the
 * Plan tab with the right slice highlighted. Selecting a task also
 * lands on the parent slice — task-level URL state isn't part of the
 * `useSelection` contract.
 */
function ProjectTreePane({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { milestoneId, sliceId, setSelection, setMilestone } = useSelection();

  return (
    <div
      data-testid="project-detail-tree-pane"
      className="min-h-0 flex-1 overflow-auto"
    >
      <ProjectTreePanel
        projectId={projectId}
        selectedMilestoneId={milestoneId ?? undefined}
        selectedSliceId={sliceId ?? undefined}
        onSelectMilestone={(id) => {
          setMilestone(id);
          navigate(`/projects/${projectId}?tab=plan`);
        }}
        onSelectSlice={(mid, sid) => {
          setSelection({ milestoneId: mid, sliceId: sid });
          navigate(`/projects/${projectId}?tab=plan`);
        }}
        onSelectTask={(mid, sid) => {
          // No task-level URL state — drill into the parent slice in the
          // Plan tab so the task is visible in the slice detail panel.
          setSelection({ milestoneId: mid, sliceId: sid });
          navigate(`/projects/${projectId}?tab=plan`);
        }}
      />
    </div>
  );
}
