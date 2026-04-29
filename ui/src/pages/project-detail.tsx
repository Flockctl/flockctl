import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ListChecks, MessageSquare } from "lucide-react";

import {
  useAttention,
  useCreateChat,
  useProject,
  useProjectConfig,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TodoMdDialog } from "@/components/todo-md-dialog";

import { ConfigTab } from "./project-detail-components/ConfigTab";
import { MissionControlKpiBar } from "./project-detail-components/MissionControlKpiBar";
import { PlanTab } from "./project-detail-components/PlanTab";
import { RunsTab } from "./project-detail-components/RunsTab";
import { TemplatesSchedulesTab } from "./project-detail-components/TemplatesSchedulesTab";

/**
 * Project-detail page shell (redesigned — milestone TBD / v1 migration).
 *
 * Replaces the former tree-view / board-view dispatcher with a single
 * **tabbed surface**:
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ ← back · crumbs                                              │
 *   │ title + attention badge + repo badges     [TODO] [New Task]   │
 *   │ MissionControlKpiBar                                          │
 *   │ Plan | Runs | Templates & Schedules | Config                  │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ active tab content                                            │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Design notes:
 * - The old ViewModeToggle is gone. The board is always rendered inside
 *   the Plan tab via {@link PlanTab}, so there is no longer a tree-vs-
 *   board split. Task analytics moved into a dedicated {@link RunsTab}.
 * - `?tab=<id>` backs the active tab so a page reload, a shared URL, or
 *   a deep-link into a specific tab all land on the same content.
 *   Invalid / missing values fall back to `"plan"`.
 * - The project-level "Chat" button is removed per the migration brief.
 *   Milestone- and slice-level chat buttons live on the right-rail detail
 *   panels inside the Plan tab and are untouched.
 * - "Settings" has moved into the Config tab — the entire former
 *   `/projects/:id/settings` page (General, AI Configuration, Execution,
 *   Env Vars, Gitignore, AGENTS.md, Skills, MCP, Secrets, Danger Zone)
 *   now lives inline there. The legacy URL redirects to `?tab=config`.
 * - The Danger Zone (delete project) is folded into the Config tab. The
 *   page header no longer carries a delete affordance — delete is not a
 *   first-class action you want 0 clicks away.
 *
 * Data fetching is intentionally minimal here: the shell only reads
 * `useProject` / `useProjectConfig` / `useAttention` so it can render
 * the title bar without waiting for the heavy project-tree payload. Each
 * tab loads its own data independently.
 */

const TAB_IDS = ["plan", "runs", "templates-schedules", "config"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return !!value && (TAB_IDS as readonly string[]).includes(value);
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const createChat = useCreateChat();

  const tab: TabId = isTabId(searchParams.get("tab"))
    ? (searchParams.get("tab") as TabId)
    : "plan";

  const setTab = (next: TabId) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "plan") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  };

  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
  } = useProject(projectId ?? "", { enabled: !!projectId });

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
      // Plan tab's embedded board is carving ~280px off the viewport for
      // the page chrome above it — kept as a CSS var so tweaking the
      // height of the header does not require touching the board.
      style={{ "--project-chrome-h": "280px" } as React.CSSProperties}
      className="flex min-h-full flex-col"
    >
      {/* --- Page header --- */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {projectLoading || !project ? (
                <Skeleton className="h-7 w-48" />
              ) : (
                <h1 className="truncate text-xl font-bold sm:text-2xl" title={project.name}>
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
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {project.repo_url && (
                  <Badge variant="secondary" className="font-mono">
                    {project.repo_url}
                  </Badge>
                )}
                <Badge variant="outline" className="font-mono">
                  {baseBranch}
                </Badge>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              Per redesign brief: the project-level "Chat" button used to
              open a project-scoped chat; it's been folded into the Plan
              tab's milestone/slice detail panels. The project-level entry
              point below survives because top-level Plan chats remain a
              convenient way to ask about the project as a whole — but it
              no longer pollutes the page's main CTA row. Keeping it
              around preserves the "open a project chat" flow the old
              button surfaced.
            */}
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
              {createChat.isPending ? "Creating…" : "Chat"}
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
          </div>
        </div>

        {/* KPI bar — always visible above the tab switcher */}
        <MissionControlKpiBar projectId={projectId} />
      </div>

      {/* --- Tabs --- */}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isTabId(value)) setTab(value);
        }}
        className="flex min-h-0 flex-1 flex-col gap-4"
        data-testid="project-detail-tabs"
      >
        <TabsList className="self-start">
          <TabsTrigger value="plan" data-testid="project-detail-tab-plan">
            Plan
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="project-detail-tab-runs">
            Runs
          </TabsTrigger>
          <TabsTrigger
            value="templates-schedules"
            data-testid="project-detail-tab-templates-schedules"
          >
            Templates &amp; Schedules
          </TabsTrigger>
          <TabsTrigger value="config" data-testid="project-detail-tab-config">
            Config
          </TabsTrigger>
        </TabsList>

        {/*
          Plan tab is the only one that must fill a constrained height —
          the embedded board uses `h-full` and needs a bounded parent.
          The `h-[calc(...)]` height carves the page chrome (title block
          + KPI bar + tabs strip) off the viewport so the board fills
          whatever remains without forcing the outer `main` container to
          scroll past the board's own tracks.
        */}
        <TabsContent
          value="plan"
          className="h-[calc(100vh-var(--project-chrome-h))] min-h-[400px] data-[state=inactive]:hidden"
        >
          <PlanTab projectId={projectId} />
        </TabsContent>

        <TabsContent value="runs" className="data-[state=inactive]:hidden">
          <RunsTab projectId={projectId} />
        </TabsContent>

        <TabsContent
          value="templates-schedules"
          className="data-[state=inactive]:hidden"
        >
          <TemplatesSchedulesTab projectId={projectId} />
        </TabsContent>

        <TabsContent value="config" className="data-[state=inactive]:hidden">
          <ConfigTab projectId={projectId} />
        </TabsContent>
      </Tabs>

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

