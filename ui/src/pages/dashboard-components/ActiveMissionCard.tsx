import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { FlatCard } from "@/components/design";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ActiveMissionCard — dashboard right-column summary of the operator's
 * currently-active mission (slice 23-01 T03).
 *
 * Two visual modes
 * ----------------
 * 1. **Active mission present** — render the mission objective, a
 *    `X of Y slices done · N proposals waiting` label, a gradient
 *    progress bar, and a `Review proposals →` button that navigates to
 *    `/missions/{id}`.
 * 2. **No active mission** — render an empty-state pitch with a
 *    `Start a mission` CTA. The CTA calls `onStartMission` if provided;
 *    the dashboard wires this to the (existing or future) mission-create
 *    dialog. We keep the dialog lookup at the parent level because the
 *    dashboard already coordinates other mission/chat affordances and
 *    does not want this card to import a heavy dialog tree.
 *
 * Why presentational
 * ------------------
 * Same rationale as `RecentActivity` (T02): the card is purely
 * `props in → JSX out`. The dashboard owns the data fan-out
 * (`useMissions(projectId)` filtered by `status === 'active'` plus a
 * `useMissionProposals` count), so this component stays trivially
 * testable and visually-isolated for the visual baselines.
 *
 * Progress-bar semantics
 * ----------------------
 * The bar fills `slicesDone / max(slicesTotal, 1)` clamped to `[0, 100]`.
 * If `slicesTotal === 0` (a brand-new mission with no slices yet) we
 * show 0 % rather than divide-by-zero NaN — operators will see the
 * empty bar plus the `0 of 0 slices done` label and recognise the
 * "no slices yet" state.
 *
 * Visual baseline note
 * --------------------
 * The gradient is identical to the `MissionsTile` gradient
 * (`from-indigo-400 to-indigo-600`) so the dashboard reads as a single
 * tonal family (KPI strip top-right amber proposals pill →
 * gradient mission progress in this card).
 */

export interface ActiveMissionSummary {
  /** Mission row id — used to route to `/missions/{id}`. */
  id: string;
  /** Free-text objective; truncated visually but never altered here. */
  objective: string;
  /** Slices in the mission's plan whose status is `done`. */
  slicesDone: number;
  /** Total slices belonging to the mission. */
  slicesTotal: number;
  /** Pending supervisor proposals waiting for operator review. */
  pendingProposals: number;
}

export interface ActiveMissionCardProps {
  /**
   * The currently-active mission, or `null`/`undefined` to render the
   * empty-state pitch. We accept all three so the dashboard can pass
   * `useMissions().data?.items.find(m => m.status === 'active') ?? null`
   * without unwrapping.
   */
  mission?: ActiveMissionSummary | null;
  /**
   * Click handler for the empty-state `Start a mission` CTA. The
   * dashboard wires this to its mission-create flow. Omitted when the
   * dashboard has not yet wired the dialog — the button stays clickable
   * but inert (no navigation, no error) so the visual baseline still
   * matches.
   */
  onStartMission?: () => void;
  /** Optional class merged onto the FlatCard surface. */
  className?: string;
}

export function ActiveMissionCard({
  mission,
  onStartMission,
  className,
}: ActiveMissionCardProps): React.JSX.Element {
  if (!mission) {
    return <EmptyState onStartMission={onStartMission} className={className} />;
  }
  return <ActiveState mission={mission} className={className} />;
}

function ActiveState({
  mission,
  className,
}: {
  mission: ActiveMissionSummary;
  className?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { id, objective, slicesDone, slicesTotal, pendingProposals } = mission;

  // Clamp progress to [0, 100] %. A 0/0 mission renders 0 %.
  const safeTotal = slicesTotal > 0 ? slicesTotal : 0;
  const ratio = safeTotal === 0 ? 0 : slicesDone / safeTotal;
  const pct = Math.max(0, Math.min(1, ratio)) * 100;

  // Pluralise "proposal" to keep the copy honest at small counts.
  const proposalsLabel =
    pendingProposals === 1 ? "1 proposal waiting" : `${pendingProposals} proposals waiting`;

  return (
    <section data-testid="active-mission-card" data-state="active">
    <FlatCard className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="text-sm font-semibold">Active mission</h3>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <p
          data-testid="active-mission-objective"
          className="text-sm font-medium text-foreground line-clamp-2"
          title={objective}
        >
          {objective}
        </p>

        <div
          data-testid="active-mission-progress-label"
          className="text-xs text-muted-foreground tabular-nums"
        >
          {slicesDone} of {slicesTotal} slices done · {proposalsLabel}
        </div>

        <div
          data-testid="active-mission-progress"
          data-tone="gradient"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={safeTotal}
          aria-valuenow={slicesDone}
          aria-label="mission slice progress"
          className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>

        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start px-0 h-auto text-[12.5px]"
          data-testid="active-mission-review-button"
          onClick={() => navigate(`/missions/${id}`)}
        >
          Review proposals →
        </Button>
      </div>
    </FlatCard>
    </section>
  );
}

function EmptyState({
  onStartMission,
  className,
}: {
  onStartMission?: () => void;
  className?: string;
}): React.JSX.Element {
  return (
    <section data-testid="active-mission-card" data-state="empty">
    <FlatCard className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="text-sm font-semibold">Active mission</h3>
      </div>

      <div className="flex flex-col items-start gap-3 px-4 pb-4">
        <p
          data-testid="active-mission-empty-pitch"
          className="text-xs text-muted-foreground"
        >
          No mission in flight. Start one to let the supervisor watch
          progress and propose remediation.
        </p>
        <Button
          type="button"
          size="sm"
          data-testid="active-mission-start-button"
          onClick={() => onStartMission?.()}
        >
          <Sparkles aria-hidden="true" />
          Start a mission
        </Button>
      </div>
    </FlatCard>
    </section>
  );
}

export default ActiveMissionCard;
