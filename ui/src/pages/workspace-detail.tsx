import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useWorkspace,
  useWorkspaceDashboard,
  useAttention,
  useChats,
  useCreateChat,
} from "@/lib/hooks";
import { MissionControlKpiBarView } from "./project-detail-components/MissionControlKpiBar";
import { formatTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, ListChecks } from "lucide-react";
import { useWorkspaceTab } from "@/lib/use-workspace-tab";

import { WorkspacePlanTab } from "./workspace-detail-components/WorkspacePlanTab";
import { WorkspaceRunsTab } from "./workspace-detail-components/WorkspaceRunsTab";
import { WorkspaceTemplatesSchedulesTab } from "./workspace-detail-components/WorkspaceTemplatesSchedulesTab";
import { WorkspaceConfigTab } from "./workspace-detail-components/WorkspaceConfigTab";
import { TodoMdDialog } from "@/components/todo-md-dialog";

// Re-export the (currently unused) Edit/Delete workspace dialogs so any
// external consumer that imports them from this module path keeps working.
export { _EditWorkspaceDialog } from "./workspace-detail-components/EditWorkspaceDialog";
export { _DeleteWorkspaceDialog } from "./workspace-detail-components/DeleteWorkspaceDialog";

/**
 * Workspace-detail page shell.
 *
 * Mirrors the shape of {@link ProjectDetailPage}:
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ title + created-at                              [Chat] [TODO]│
 *   │ KPI bar                                                       │
 *   │ Plan | Runs | Templates & Schedules | Config                  │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │ active tab content                                            │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * The page is a single column — the old side-by-side `WorkspaceChatPanel`
 * that lived to the right of the tabs is gone. Its entry point is now
 * the header **Chat** button, which behaves exactly like Projects: if
 * any workspace-scoped chat exists, jump to the most recent one;
 * otherwise create a new workspace-scoped chat and navigate into it.
 * The button stays disabled while the mutation is in flight so rapid
 * re-clicks don't spawn duplicate chats.
 */

export default function WorkspaceDetailPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const [todoOpen, setTodoOpen] = useState(false);
  const [tab, setTab] = useWorkspaceTab();
  const createChat = useCreateChat();

  // Fetch workspace-scoped chats so the header Chat button can route to the
  // most recent one instead of always creating a new chat. Matches the
  // Projects-page pattern where "open a chat" prefers the last one.
  const { data: workspaceChats } = useChats(
    { workspaceId: workspaceId ?? "" },
    { enabled: !!workspaceId },
  );

  const {
    data: workspace,
    isLoading,
    error,
  } = useWorkspace(workspaceId ?? "");
  const { data: dashboard, isLoading: dashboardLoading } = useWorkspaceDashboard(
    workspaceId ?? "",
  );
  // `useAttention` is the global approval inbox — we filter to this
  // workspace's project IDs below. The hook has no `{ workspaceId }`
  // overload today; when it grows one, this filter collapses to a
  // straight `attention.total` read.
  const attention = useAttention();

  // --- KPI bar stats (pure derivations, no new network calls) ------
  //
  // Contract: any field we can't source from the current hook surface
  // area is passed as `null` and renders `—`. The milestone vision
  // forbids backend changes, so we lean on what's already wire-
  // serialized and accept "unknown" on the rest.
  const workspaceProjectIds = workspace?.projects?.map((p) => p.id) ?? [];
  const workspaceProjectIdSet = new Set(workspaceProjectIds);

  const projectsTotal = workspace ? workspaceProjectIds.length : null;
  const projectsDone = dashboard
    ? (dashboard.project_summaries ?? []).reduce(
        (n, ps) =>
          ps.milestone_count > 0 &&
          ps.completed_milestone_count === ps.milestone_count
            ? n + 1
            : n,
        0,
      )
    : null;

  const workspaceActiveTasks = dashboard?.active_tasks ?? null;

  const pendingApproval = attention.isLoading
    ? null
    : (attention.items ?? []).reduce((n, item) => {
        if (item.project_id === null) return n;
        return workspaceProjectIdSet.has(item.project_id) ? n + 1 : n;
      }, 0);

  const workspaceFailed24h = dashboard?.failed_tasks ?? null;

  // `useUsageSummary` doesn't take a workspace_id, and backend changes
  // are out of scope for this milestone. Pass `null` so the Tokens/$
  // card renders `—` honestly.
  const workspaceTokens24h: number | null = null;
  const workspaceCostCents24h: number | null = null;

  if (!workspaceId) {
    return <p className="text-destructive">Missing workspace ID.</p>;
  }

  if (error) {
    return (
      <p className="text-destructive">
        Failed to load workspace: {error.message}
      </p>
    );
  }

  return (
    <div
      data-testid="workspace-detail-page"
      className="flex min-h-full flex-col"
    >
      {/* --- Page header --- */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {isLoading || !workspace ? (
              <Skeleton className="h-7 w-48" />
            ) : (
              <h1
                className="truncate text-xl font-bold sm:text-2xl"
                title={workspace.name}
              >
                {workspace.name}
              </h1>
            )}
            {workspace?.description && (
              <p className="mt-1 text-muted-foreground">
                {workspace.description}
              </p>
            )}
            {workspace && (
              <p className="mt-1 text-xs text-muted-foreground">
                Created {formatTime(workspace.created_at)}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              Chat button — mirrors project-detail.tsx's header Chat
              button. If the workspace already has any chats, we jump to
              the most recent one (by `updated_at`); otherwise we create
              a fresh workspace-scoped chat and navigate into it. The
              button stays disabled while `useCreateChat` is in flight
              to debounce rapid re-clicks (same pattern as Projects).
            */}
            <Button
              variant="outline"
              size="sm"
              disabled={createChat.isPending || !workspace}
              onClick={() => {
                if (!workspace) return;
                const chats = workspaceChats ?? [];
                // Server order isn't guaranteed to be newest-first for
                // every filter, so sort defensively on `updated_at`
                // before routing.
                const mostRecent = [...chats].sort((a, b) =>
                  b.updated_at.localeCompare(a.updated_at),
                )[0];
                if (mostRecent) {
                  navigate(`/chats/${mostRecent.id}`);
                  return;
                }
                createChat
                  .mutateAsync({
                    workspaceId: parseInt(workspaceId),
                    title: `Workspace: ${workspace.name}`,
                  })
                  .then((chat) => navigate(`/chats/${chat.id}`));
              }}
              data-testid="workspace-detail-page-chat"
            >
              <MessageSquare className="mr-1 h-4 w-4" />
              {createChat.isPending ? "Creating…" : "Chat"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTodoOpen(true)}
              data-testid="workspace-detail-page-todo"
            >
              <ListChecks className="mr-1.5 h-4 w-4" />
              TODO
            </Button>
          </div>
        </div>

        <MissionControlKpiBarView
          slicesLabel="Projects"
          slicesDone={projectsDone}
          slicesTotal={projectsTotal}
          activeTasks={workspaceActiveTasks}
          pendingApproval={pendingApproval}
          failed24h={workspaceFailed24h}
          tokens24h={workspaceTokens24h}
          costCents24h={workspaceCostCents24h}
          isLoading={{
            slicesDone: dashboardLoading,
            slicesTotal: isLoading,
            activeTasks: dashboardLoading,
            pendingApproval: attention.isLoading,
            failed24h: dashboardLoading,
            tokens24h: false,
            costCents24h: false,
          }}
        />
      </div>

      {/* --- Tabs --- */}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          // `useWorkspaceTab.setTab` is guarded at runtime, so we can
          // forward the raw Radix value straight through.
          setTab(value as Parameters<typeof setTab>[0]);
        }}
        className="flex min-h-0 flex-1 flex-col gap-4"
        data-testid="workspace-detail-tabs"
      >
        <TabsList className="self-start">
          <TabsTrigger value="plan" data-testid="workspace-detail-tab-plan">
            Plan
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="workspace-detail-tab-runs">
            Runs
          </TabsTrigger>
          <TabsTrigger
            value="templates"
            data-testid="workspace-detail-tab-templates"
          >
            Templates &amp; Schedules
          </TabsTrigger>
          <TabsTrigger
            value="config"
            data-testid="workspace-detail-tab-config"
          >
            Config
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="plan"
          className="data-[state=inactive]:hidden space-y-4"
        >
          <WorkspacePlanTab workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent
          value="runs"
          className="data-[state=inactive]:hidden space-y-4"
        >
          <WorkspaceRunsTab
            workspaceId={workspaceId}
            projects={workspace?.projects ?? []}
          />
        </TabsContent>

        <TabsContent
          value="templates"
          className="data-[state=inactive]:hidden space-y-4"
        >
          <WorkspaceTemplatesSchedulesTab workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent
          value="config"
          className="data-[state=inactive]:hidden space-y-4"
        >
          <WorkspaceConfigTab workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>

      {workspace && (
        <TodoMdDialog
          scope="workspace"
          workspaceId={workspaceId}
          open={todoOpen}
          onOpenChange={setTodoOpen}
          title={workspace.name}
        />
      )}
    </div>
  );
}
