import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Target } from "lucide-react";

import {
  useMission,
  useMissionEvents,
  useMissionProposals,
} from "@/lib/hooks/missions";
import { useTrackRecent } from "@/lib/recent-store";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

import { MissionHeader } from "./mission-detail-components/MissionHeader";
import { MissionKpiStrip } from "./mission-detail-components/MissionKpiStrip";
import { MissionEventsFeed } from "./mission-detail-components/MissionEventsFeed";
import { ProposalsQueue } from "./mission-detail-components/ProposalsQueue";

/**
 * Mission Detail page (slice 24-01 / T04).
 *
 * Page assembly:
 *
 *   <PageContainer max-w-7xl>
 *     <MissionHeader mission={mission} />
 *     <MissionKpiStrip stats={stats} />
 *     <div class="grid grid-cols-3 gap-4">
 *       <div class="col-span-2"><MissionEventsFeed /></div>
 *       <ProposalsQueue />
 *     </div>
 *   </PageContainer>
 *
 * The component is a thin orchestrator — every child has its own unit
 * suite (`mission-header.test.tsx`, `mission-kpi-tile.test.tsx`,
 * `mission-events-feed.test.tsx`, `mission-proposal-card.test.tsx`).
 * Tests for THIS file pin the structural composition only.
 */

// Page wrapper: ONLY constrain max-width. The shell's <main> already adds
// `p-3 sm:p-4 md:p-6` padding (see `components/shell/NewShell.tsx`) so adding
// another `p-6` here would double-pad and visually offset the page from the
// rest of the surfaces (Dashboard, Tasks, Projects, Workspaces, …).
const PAGE_CLASSES = "max-w-7xl";

export default function MissionDetailPage() {
  const { missionId } = useParams<{ missionId: string }>();
  const id = missionId ?? "";

  const missionQ = useMission(id);
  const { events, isLoading: eventsLoading } = useMissionEvents(id);
  const proposalsQ = useMissionProposals(id, { status: "pending" });

  // Sidebar Recent registration — same pattern as the legacy page.
  useTrackRecent({
    kind: "mission",
    id: missionId,
    label: missionQ.data?.objective?.slice(0, 60) ?? null,
    href: `/missions/${missionId ?? ""}`,
  });

  // ── Stats derived for the KPI strip ─────────────────────────────────
  // Triggers in the last 24h = events whose `created_at` (Unix seconds)
  // is within 86_400s of "now". `useMissionEvents` returns the rows
  // newest-first so we can short-circuit when we hit one outside the
  // window, but the loop is O(events.length) at worst — negligible for
  // typical mission sizes.
  const triggers24h = useMemo(() => {
    if (events.length === 0) return 0;
    // eslint-disable-next-line react-hooks/purity -- intentional render-time snapshot; events list drives the memo and per-render drift is acceptable
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    let n = 0;
    for (const ev of events) {
      if (ev.created_at < cutoff) break;
      n += 1;
    }
    return n;
  }, [events]);

  const proposals = proposalsQ.data?.items ?? [];
  const pendingProposalsCount = proposalsQ.data?.total ?? proposals.length;

  // ── Loading + error guards ──────────────────────────────────────────
  if (missionQ.isLoading) {
    return (
      <div data-testid="mission-detail-page" className={cn(PAGE_CLASSES)}>
        <div className="space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (missionQ.error || !missionQ.data) {
    return (
      <div
        data-testid="mission-detail-page"
        data-state="not-found"
        className={cn(PAGE_CLASSES)}
      >
        <EmptyState
          icon={Target}
          title="Mission not found"
          description={
            <>
              The mission may have been deleted or its id is invalid.{" "}
              <Link to="/dashboard" className="underline">
                Back to dashboard
              </Link>
              .
            </>
          }
        />
      </div>
    );
  }

  const mission = missionQ.data;
  // The supervisor's max-depth guard hard-codes 5 today (see
  // `src/services/missions/max-depth-guard.ts`). When a per-mission
  // override lands the constant moves into the `Mission` row and we
  // pull it from there — for now, surface the shared cap.
  const MAX_DEPTH = 5;
  const currentDepth = (() => {
    // Take the deepest seen depth on the timeline; falls back to 0
    // when the mission has not produced any events yet.
    if (events.length === 0) return 0;
    let max = 0;
    for (const ev of events) {
      if (ev.depth > max) max = ev.depth;
    }
    return max;
  })();

  return (
    <div data-testid="mission-detail-page" className={cn(PAGE_CLASSES)}>
      <MissionHeader mission={mission} />

      <div className="mt-4">
        <MissionKpiStrip
          depth={currentDepth}
          maxDepth={MAX_DEPTH}
          spentTokens={mission.spent_tokens}
          budgetTokens={mission.budget_tokens}
          spentUsdCents={mission.spent_usd_cents}
          budgetUsdCents={mission.budget_usd_cents}
          triggers24h={triggers24h}
          pendingProposals={pendingProposalsCount}
        />
      </div>

      <div
        data-testid="mission-detail-grid"
        className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3"
      >
        <div data-testid="mission-detail-events-col" className="lg:col-span-2">
          <MissionEventsFeed events={events} isLoading={eventsLoading} />
        </div>
        <div data-testid="mission-detail-proposals-col">
          <ProposalsQueue missionId={mission.id} proposals={proposals} />
        </div>
      </div>
    </div>
  );
}
