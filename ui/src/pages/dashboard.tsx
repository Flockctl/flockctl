import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";

import { SectionHeader } from "@/components/design";
import { Button } from "@/components/ui/button";
import { useTasks, useUsageSummary, useChats, useProjects } from "@/lib/hooks";
import { useAttention } from "@/lib/hooks/attention";
import { cn } from "@/lib/utils";

import { DashboardKpiTiles } from "./dashboard-components/DashboardKpiTiles";
import {
  RecentActivity,
  type RecentActivityItem,
} from "./dashboard-components/RecentActivity";
import { ActiveMissionCard } from "./dashboard-components/ActiveMissionCard";
import { QuickLinks } from "./dashboard-components/QuickLinks";
import {
  TimeRangeSelect,
  useTimeRange,
} from "./dashboard-components/TimeRangeSelect";

/**
 * Dashboard page (slice 23-01 — T06 page assembly).
 *
 * Layout per slice.md `## Tasks → T06`:
 *
 *   <PageContainer max-w-7xl p-6>
 *     <SectionHeader title="Dashboard" subtitle=… action=…/>
 *     <DashboardKpiTiles ... />
 *     <div class="grid grid-cols-3 gap-3">
 *       <RecentActivity class="col-span-2" />
 *       <div class="space-y-3">
 *         <ActiveMissionCard />
 *         <QuickLinks />
 *       </div>
 *     </div>
 *   </PageContainer>
 *
 * Data wiring is intentionally thin — the dashboard composes a handful
 * of existing hooks (`useTasks`, `useUsageSummary`, `useChats`,
 * `useProjects`, `useAttention`) and forwards their results into the
 * presentational tiles built in T01–T05. The aggregator-hook avenue
 * was left open by T00's audit (no `useDashboardKpi` exists; the
 * project-detail precedent is `useKpiData`) — but for the page-assembly
 * task we keep the wiring inline so the component boundaries stay
 * obvious in the diff.
 *
 * Time-range source of truth
 * --------------------------
 * The URL `?range=` query string is the single source of truth, read
 * via `useTimeRange()`. The `TimeRangeSelect` writes back to it via
 * `useSearchParams({ replace: true })`. The page forwards the validated
 * range to `useUsageSummary({ period })` so KPI fetches re-run when the
 * operator changes the picker.
 *
 * Active-mission + primary-project wiring
 * ---------------------------------------
 * The dashboard does not currently know which mission is "active" at
 * the user level — `useMissions(projectId)` is project-scoped. We pass
 * `null` to {@link ActiveMissionCard}, which renders the canonical
 * empty state with a "Start a mission" CTA. Same story for the QuickLinks
 * primary project: there is no `is_pinned` flag on the Project shape
 * yet, so we pick the first project alphabetically (when one exists).
 * Both wirings are documented next to their respective TODOs so the
 * follow-up slices have a short list of seams to attach to.
 */

// Page wrapper: ONLY constrain max-width. The shell's <main> already adds
// `p-3 sm:p-4 md:p-6` padding (see `components/shell/NewShell.tsx`) so adding
// another `p-6` here would double-pad and visually offset the page from
// every other surface (Tasks, Projects, Workspaces, Templates, …). Skipping
// `mx-auto` keeps the title at the same left edge as those surfaces.
const PAGE_CLASSES = "max-w-7xl";

export default function DashboardPage() {
  const navigate = useNavigate();
  const range = useTimeRange();

  // --- KPI data fan-out --------------------------------------------------
  const tasksQuery = useTasks(0, 100);
  const usageQuery = useUsageSummary({ period: range });
  const chatsQuery = useChats({});
  const projectsQuery = useProjects();
  const attention = useAttention();

  // `assigned` was a vestigial status the backend FSM never produces; the
  // legacy match was kept for safety while the enum still listed it. With
  // the dead-code cleanup, "active" tasks are exactly the running ones.
  const activeTasks = (tasksQuery.data?.items ?? []).filter(
    (t) => t.status === "running",
  ).length;

  const usage = usageQuery.data;
  const totalTokens =
    (usage?.total_input_tokens ?? 0) + (usage?.total_output_tokens ?? 0);
  const costUsd = usage?.total_cost_usd ?? 0;

  // Treat any chat we can see as "open" — the dashboard doesn't have a
  // first-class "active" filter on the chats list endpoint and the brief
  // calls for an at-a-glance count, not a per-state breakdown.
  const openChats = chatsQuery.data?.length ?? 0;

  // --- Subtitle ---------------------------------------------------------
  // "{N} active tasks · {M} chats · daemon healthy" — the slice's demo
  // copy. We don't have a daemon-health probe wired in here, so we
  // default to "healthy" as the connection-dot in the title bar already
  // surfaces the live network state.
  const subtitle = useMemo(() => {
    const parts = [
      `${activeTasks} active task${activeTasks === 1 ? "" : "s"}`,
      `${openChats} chat${openChats === 1 ? "" : "s"}`,
      "daemon healthy",
    ];
    return parts.join(" · ");
  }, [activeTasks, openChats]);

  // --- Recent activity --------------------------------------------------
  // Derive client-side from concat of recent tasks + chats + attention
  // items, sorted newest-first. The dashboard owns this fan-out so
  // <RecentActivity> stays trivially testable.
  const activityItems = useMemo<RecentActivityItem[]>(() => {
    const items: RecentActivityItem[] = [];
    for (const task of tasksQuery.data?.items ?? []) {
      if (task.status === "done") {
        items.push({
          id: `task-${task.id}`,
          type: "task_completed",
          title: task.prompt?.slice(0, 80) ?? "Task completed",
          detail: task.project_id
            ? `task · ${task.actual_model_used ?? task.model ?? ""}`
            : undefined,
          timestamp:
            task.completed_at ?? task.updated_at ?? task.created_at,
          href: `/tasks/${task.id}`,
        });
      }
    }
    for (let idx = 0; idx < attention.items.length; idx += 1) {
      const a = attention.items[idx]!;
      const stamp =
        "created_at" in a && a.created_at
          ? a.created_at
          : "since" in a && a.since
            ? a.since
            : new Date().toISOString();
      const title =
        "title" in a && a.title
          ? a.title
          : "question" in a && a.question
            ? a.question
            : "Needs attention";
      const projectId = a.project_id ?? null;
      items.push({
        id: `attention-${idx}`,
        type: "proposal_filed",
        title,
        detail: projectId ? `project ${projectId}` : undefined,
        timestamp: stamp,
      });
    }
    items.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime() || 0;
      const tb = new Date(b.timestamp).getTime() || 0;
      return tb - ta;
    });
    return items.slice(0, 5);
  }, [tasksQuery.data, attention.items]);

  // --- Primary project for QuickLinks -----------------------------------
  // No `is_pinned` flag exists on the Project shape, so we fall back to
  // the first project sorted alphabetically. When the projects list is
  // empty, QuickLinks hides the Code-mode row by contract.
  const primaryProject = useMemo(() => {
    const list = projectsQuery.data ?? [];
    if (list.length === 0) return undefined;
    const sorted = [...list].sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? ""),
    );
    const first = sorted[0]!;
    return { slug: first.id, name: first.name };
  }, [projectsQuery.data]);

  return (
    <div data-testid="dashboard-page" className={cn(PAGE_CLASSES)}>
      <SectionHeader
        title="Dashboard"
        subtitle={subtitle}
        action={
          <>
            <TimeRangeSelect />
            <Button
              type="button"
              size="sm"
              data-testid="dashboard-new-chat-button"
              onClick={() => navigate("/chats")}
            >
              <Plus aria-hidden="true" />
              New chat
            </Button>
          </>
        }
      />

      <DashboardKpiTiles
        activeTasks={activeTasks}
        costUsd={costUsd}
        tokensTotal={totalTokens}
        tokensIn={usage?.total_input_tokens}
        tokensOut={usage?.total_output_tokens}
        openChats={openChats}
        missions={0}
      />

      <div
        data-testid="dashboard-grid"
        className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3"
      >
        <RecentActivity
          items={activityItems}
          className="lg:col-span-2"
        />
        <div className="space-y-3">
          <ActiveMissionCard mission={null} />
          <QuickLinks
            primaryProject={primaryProject}
            attentionCount={attention.total ?? 0}
          />
        </div>
      </div>
    </div>
  );
}
