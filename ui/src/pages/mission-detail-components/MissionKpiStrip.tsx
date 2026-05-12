import * as React from "react";

import { cn } from "@/lib/utils";
import { formatCents, formatTokensWithNull } from "@/lib/format";
import { MissionBudgetBar } from "./MissionBudgetBar";

/**
 * MissionKpiStrip — five inline mini-tiles under the mission header.
 *
 * Tiles (left → right, per slice 24/01 T01):
 *   1. Depth                — current remediation depth `n / max`.
 *   2. Budget               — `$X.YY / $Z.WW` with embedded budget bar.
 *   3. Tokens               — running spent total (`spent / budget`).
 *   4. Triggers 24h         — count of mission events seen in last 24h.
 *   5. Pending proposals    — count of `remediation_proposed` rows
 *                             still awaiting an operator decision.
 *
 * The strip is intentionally smaller than `<DashboardKpiTiles>`: labels
 * are `text-[12px] uppercase`, values are `text-base font-semibold` (vs.
 * the dashboard's `text-2xl`). Brief calls them "mini-tiles" so the
 * header + strip land within ~96px vertical above the events feed.
 *
 * No `<KpiTile>` reuse here on purpose — `KpiTile` is sized for
 * dashboard-scale stats with sparkbars and trend chips, neither of
 * which the mission strip needs. Re-using it would force every tile
 * to absorb its layout (wider padding, larger value font) and break
 * the "smaller than Dashboard KPIs" callout.
 */

export interface MissionKpiStripProps {
  /** Current remediation depth (e.g. 2). */
  depth: number;
  /** Maximum allowed depth (e.g. 5). */
  maxDepth: number;
  /** Tokens consumed by the supervisor + downstream tasks. */
  spentTokens: number;
  /** Token budget cap. Pass 0 / undefined for "unbounded" → bar empty. */
  budgetTokens: number;
  /** USD cents consumed. */
  spentUsdCents: number;
  /** USD cents budget cap. */
  budgetUsdCents: number;
  /** Triggers in trailing 24h (recent mission_events count). */
  triggers24h: number;
  /** Pending proposals (`remediation_proposed` without resolution). */
  pendingProposals: number;
  className?: string;
}

// Cost / token formatters live in `@/lib/format`. The canonical
// `formatCents` and `formatTokensWithNull` handle `null`, `undefined`, AND
// non-finite inputs (NaN / ±Infinity) themselves — see their JSDoc — so the
// strip just delegates without re-deriving the same guards.

interface MiniTileProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Optional progress bar / trailing slot (used by the Budget tile). */
  bar?: React.ReactNode;
  testId?: string;
  /** Tone applied to the value text (used by Pending proposals when > 0). */
  tone?: "default" | "warning";
}

function MiniTile({
  label,
  value,
  hint,
  bar,
  testId,
  tone = "default",
}: MiniTileProps) {
  return (
    <div
      data-testid={testId ?? "mission-kpi-tile"}
      data-tone={tone}
      className={cn(
        "rounded-lg border bg-card px-3 py-2",
        "flex flex-col gap-0.5",
      )}
    >
      <div
        data-testid="mission-kpi-label"
        className="text-[12px] uppercase tracking-wider font-medium text-zinc-500 dark:text-zinc-400"
      >
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          data-testid="mission-kpi-value"
          className={cn(
            "text-base font-semibold leading-none tabular-nums",
            tone === "warning" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </span>
        {hint !== undefined && hint !== null && (
          <span
            data-testid="mission-kpi-hint"
            className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums"
          >
            {hint}
          </span>
        )}
      </div>
      {bar && <div className="mt-1.5">{bar}</div>}
    </div>
  );
}

export function MissionKpiStrip({
  depth,
  maxDepth,
  spentTokens,
  budgetTokens,
  spentUsdCents,
  budgetUsdCents,
  triggers24h,
  pendingProposals,
  className,
}: MissionKpiStripProps): React.JSX.Element {
  return (
    <div
      data-testid="mission-kpi-strip"
      className={cn(
        "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5",
        className,
      )}
    >
      {/* 1 — Depth */}
      <MiniTile
        testId="mission-kpi-depth"
        label="Depth"
        value={String(depth)}
        hint={`/ ${maxDepth}`}
      />

      {/* 2 — Budget (USD with embedded bar) */}
      <MiniTile
        testId="mission-kpi-budget"
        label="Budget"
        value={formatCents(spentUsdCents)}
        hint={`/ ${formatCents(budgetUsdCents)}`}
        bar={
          <MissionBudgetBar
            used={spentUsdCents}
            budget={budgetUsdCents}
            ariaLabel="USD budget used"
          />
        }
      />

      {/* 3 — Tokens */}
      <MiniTile
        testId="mission-kpi-tokens"
        label="Tokens"
        value={formatTokensWithNull(spentTokens)}
        hint={`/ ${formatTokensWithNull(budgetTokens)}`}
        bar={
          <MissionBudgetBar
            used={spentTokens}
            budget={budgetTokens}
            ariaLabel="Token budget used"
          />
        }
      />

      {/* 4 — Triggers 24h */}
      <MiniTile
        testId="mission-kpi-triggers"
        label="Triggers 24h"
        value={String(triggers24h)}
      />

      {/* 5 — Pending proposals */}
      <MiniTile
        testId="mission-kpi-pending"
        label="Pending proposals"
        value={String(pendingProposals)}
        tone={pendingProposals > 0 ? "warning" : "default"}
      />
    </div>
  );
}

export default MissionKpiStrip;
