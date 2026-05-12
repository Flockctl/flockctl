import * as React from "react";

import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/design";
import type { Mission } from "@/lib/hooks/missions";

/**
 * MissionHeader — top-of-page strip for `/missions/:id`.
 *
 * Layout (per slice 24/01 T01):
 *   - h1 objective line: `text-[18px] font-semibold` (sm tablet+ scales
 *     up to `sm:text-xl`).
 *   - Trigger source line below: `text-zinc-500 text-[12px]` — describes
 *     where the mission was triggered from (manual operator vs. cron vs.
 *     auto-fan-out from a parent slice). When no trigger source is
 *     supplied we fall back to the autonomy + status combo so the line
 *     never goes empty.
 *
 * Mutations and tab navigation live in sibling components — this header
 * is a read-only summary. The `<StatusPill>`s are decorative (status +
 * autonomy badges); operator actions (pause, abort) belong on a future
 * action rail, not here.
 */

export interface MissionHeaderProps {
  mission: Mission;
  /**
   * Optional human-readable trigger source ("Operator · 2h ago",
   * "Cron · daily", etc.). When omitted we render an autonomy summary
   * instead so the line is never empty.
   */
  triggerSource?: string;
  className?: string;
}

const STATUS_TONE: Record<
  Mission["status"],
  React.ComponentProps<typeof StatusPill>["tone"]
> = {
  drafting: "neutral",
  active: "info",
  paused: "warning",
  completed: "success",
  failed: "danger",
  aborted: "danger",
};

function formatAutonomy(autonomy: Mission["autonomy"]): string {
  if (autonomy === "manual") return "Manual approvals";
  if (autonomy === "suggest") return "Suggest only";
  return "Auto-execute";
}

export function MissionHeader({
  mission,
  triggerSource,
  className,
}: MissionHeaderProps): React.JSX.Element {
  const fallbackTrigger = `${formatAutonomy(mission.autonomy)} · ${mission.status}`;
  const triggerLine = triggerSource ?? fallbackTrigger;

  return (
    <header
      data-testid="mission-header"
      className={cn("flex flex-col gap-1.5", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1
          data-testid="mission-header-objective"
          className="text-[18px] font-semibold leading-tight text-foreground sm:text-xl"
        >
          {mission.objective}
        </h1>
        <StatusPill
          tone={STATUS_TONE[mission.status] ?? "neutral"}
          size="sm"
          data-testid="mission-header-status"
        >
          {mission.status}
        </StatusPill>
        <StatusPill
          tone="neutral"
          size="sm"
          data-testid="mission-header-autonomy"
        >
          {mission.autonomy}
        </StatusPill>
      </div>
      <div
        data-testid="mission-header-trigger"
        className="text-[12px] text-zinc-500 dark:text-zinc-400"
      >
        {triggerLine}
      </div>
    </header>
  );
}

export default MissionHeader;
