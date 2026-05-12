import * as React from "react";

import { cn } from "@/lib/utils";
import { clampPercent } from "@/lib/format";

/**
 * MissionBudgetBar — thin progress bar that re-tones based on the
 * `used / budget` ratio.
 *
 * Tone thresholds (per slice 24/01 T01):
 *   - `<70%`     → indigo  (`bg-indigo-500`)   — healthy / on-track
 *   - `70–90%`   → amber   (`bg-amber-500`)    — warn the operator
 *   - `>90%`     → red     (`bg-red-500`)      — near / past limit
 *
 * `budget <= 0` is treated as "no budget configured" — the track is
 * rendered empty and the tone defaults to indigo so the strip still
 * paints something rather than disappearing.
 *
 * The component intentionally stays tiny: the mission KPI strip embeds
 * one of these per budget axis (tokens + cents), and we want the inline
 * tile to keep a single visual line. No labels, no values — those live
 * one level up in `MissionKpiStrip`.
 */
export interface MissionBudgetBarProps {
  used: number;
  budget: number;
  /** Optional ARIA label so the bar reads sensibly to assistive tech. */
  ariaLabel?: string;
  className?: string;
}

export type MissionBudgetTone = "indigo" | "amber" | "red";

const TONE_FILL: Record<MissionBudgetTone, string> = {
  indigo: "bg-indigo-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

/**
 * Pure tone-picker so tests can verify the threshold logic without
 * rendering the component. Exported alongside the React component so
 * the public surface stays small.
 *
 * Threshold semantics (matches slice spec):
 *   - `<70%`  -> `indigo`
 *   - `70%`   -> `amber`  (boundary inclusive on amber)
 *   - `>=70 && <=90` -> `amber`
 *   - `>90%`  -> `red`
 */
export function pickMissionBudgetTone(
  used: number,
  budget: number,
): MissionBudgetTone {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) {
    return "indigo";
  }
  const pct = (used / budget) * 100;
  if (pct > 90) return "red";
  if (pct >= 70) return "amber";
  return "indigo";
}

// `clampPercent` lives in `@/lib/format` — over-budget missions still cap
// visually at 100%; the tone (red) carries the "we went past the line"
// signal. The bar itself never overflows the track.

export function MissionBudgetBar({
  used,
  budget,
  ariaLabel,
  className,
}: MissionBudgetBarProps): React.JSX.Element {
  const tone = pickMissionBudgetTone(used, budget);
  const pct = clampPercent(used, budget);
  const rawPct =
    budget > 0 && Number.isFinite(used) && Number.isFinite(budget)
      ? (used / budget) * 100
      : 0;

  return (
    <div
      data-testid="mission-budget-bar"
      data-tone={tone}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={budget > 0 ? budget : 0}
      aria-valuenow={Number.isFinite(used) ? used : 0}
      aria-valuetext={
        budget > 0 ? `${rawPct.toFixed(0)}% of budget used` : "no budget set"
      }
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800",
        className,
      )}
    >
      <div
        data-testid="mission-budget-bar-fill"
        className={cn("h-full rounded-full transition-all", TONE_FILL[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default MissionBudgetBar;
