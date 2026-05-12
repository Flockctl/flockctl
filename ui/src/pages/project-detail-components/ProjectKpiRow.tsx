import * as React from "react";

import { KpiTile } from "@/components/design";
import { cn } from "@/lib/utils";
import { formatUsdGuarded } from "@/lib/format";

/**
 * ProjectKpiRow — top-of-page summary strip for the redesigned project
 * detail page (M23 / slice 00 / T01).
 *
 * Layout
 * ------
 * Five `<KpiTile>` instances in a single `grid grid-cols-5 gap-3` row.
 * The five tiles, left → right:
 *
 *   1. Slices             — "{done} / {total}" + gradient progress bar
 *   2. Active tasks       — running + assigned task count
 *   3. Pending approval   — attention-inbox rows scoped to this project
 *   4. Failed 24h         — failed task count, `tone="danger"` when > 0
 *   5. Cost               — `$X.XX` mono, optional budget hint
 *
 * Why presentational
 * ------------------
 * Page assembly (T09) is responsible for wiring the existing
 * `useKpiData(projectId)` aggregator hook into this row. Keeping the
 * row prop-driven keeps T01 testable without React Query, mirrors the
 * pattern established by `DashboardKpiTiles` (M22), and lets the
 * workspace-detail page reuse the same surface in a future slice
 * without re-fetching.
 *
 * Numeric formatting
 * ------------------
 * Cost is always rendered as `$X.XX` (two decimals, never compact —
 * the reader needs to see cents). All counts pass through to
 * `<KpiTile>`, which uses `Intl.NumberFormat`'s compact notation past
 * 1000. `undefined` for any field renders KpiTile's em-dash sentinel.
 */

export interface ProjectKpiRowProps {
  /** Number of completed slices in the active milestone (or aggregate). */
  slicesDone: number | undefined;
  /** Total slices — denominator for the progress bar. */
  slicesTotal: number | undefined;
  /** Currently-running + assigned task count. */
  activeTasks: number | undefined;
  /** Approval inbox rows that belong to this project. */
  pendingApproval: number | undefined;
  /** Failed task count over the 24h window. Danger tone when > 0. */
  failed24h: number | undefined;
  /** Cost in USD over the 24h window. */
  costUsd: number | undefined;
  /** Optional budget cap; rendered as `of $Y.YY` hint when present. */
  costBudgetUsd?: number;
  /**
   * Compact mode — render the five stats as inline pills instead of the
   * default 5-column grid of full-size KpiTiles. Used by project-detail
   * to tuck the KPIs onto the same row as the repo/branch badges so the
   * header doesn't burn a whole strip on five mostly-zero numbers.
   *
   * The container keeps the `project-kpi-row` testid in both modes; the
   * em-dash sentinel for `undefined` and the danger tone for `failed24h
   * > 0` are preserved. KpiTile-level testids (`kpi-tile`, `kpi-value`,
   * etc.) are NOT emitted in compact mode — those are unit-tested
   * separately against the default rendering.
   */
  compact?: boolean;
}

/**
 * Render `"{done} / {total}"`. Either side `undefined` collapses the
 * whole label to KpiTile's em-dash sentinel — we never display
 * `"undefined / 12"`.
 */
function formatSlicesValue(
  done: number | undefined,
  total: number | undefined,
): string | undefined {
  if (done === undefined || total === undefined) return undefined;
  if (Number.isNaN(done) || Number.isNaN(total)) return undefined;
  return `${done} / ${total}`;
}

/** Render `value` (string|number|undefined) as the same em-dash sentinel
 *  KpiTile uses, so the compact mode doesn't drift from the default. */
function compactValue(v: string | number | undefined): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v;
  if (Number.isNaN(v) || !Number.isFinite(v)) return "—";
  return String(v);
}

function CompactStat({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider",
          danger ? "text-red-500" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-[12px] font-semibold tabular-nums",
          mono && "mono",
          danger && "text-red-500",
        )}
      >
        {value}
      </span>
    </span>
  );
}

export function ProjectKpiRow({
  slicesDone,
  slicesTotal,
  activeTasks,
  pendingApproval,
  failed24h,
  costUsd,
  costBudgetUsd,
  compact = false,
}: ProjectKpiRowProps): React.JSX.Element {
  const slicesValue = formatSlicesValue(slicesDone, slicesTotal);
  const costFormatted = formatUsdGuarded(costUsd);
  const costBudgetFormatted = formatUsdGuarded(costBudgetUsd);

  // Failed 24h flips to the danger tone whenever there's at least one
  // failure. `undefined` is treated as "no data" → default tone (no
  // false alarms on an unloaded scope).
  const failedTone =
    failed24h !== undefined && failed24h > 0 ? "danger" : "default";

  // The gradient progress bar is only meaningful when we actually have
  // a denominator. A zero-slice project still renders the tile (with
  // `0 / 0`) but omits the bar to avoid a flat empty track.
  const showSlicesProgress =
    slicesDone !== undefined &&
    slicesTotal !== undefined &&
    slicesTotal > 0;

  if (compact) {
    return (
      <div
        data-testid="project-kpi-row"
        className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1"
      >
        <CompactStat label="Slices" value={compactValue(slicesValue)} />
        <span className="text-muted-foreground/40 text-[10px]">·</span>
        <CompactStat label="Active" value={compactValue(activeTasks)} />
        <span className="text-muted-foreground/40 text-[10px]">·</span>
        <CompactStat label="Pending" value={compactValue(pendingApproval)} />
        <span className="text-muted-foreground/40 text-[10px]">·</span>
        <CompactStat
          label="Failed 24h"
          value={compactValue(failed24h)}
          danger={failedTone === "danger"}
        />
        <span className="text-muted-foreground/40 text-[10px]">·</span>
        <CompactStat
          label="Cost"
          value={costFormatted ?? "—"}
          mono
        />
        {costBudgetFormatted && (
          <span className="text-[10px] text-muted-foreground">
            of {costBudgetFormatted}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="project-kpi-row"
      className="grid grid-cols-5 gap-3"
    >
      {/* 1 — Slices */}
      <KpiTile
        label="Slices"
        value={slicesValue}
        progress={
          showSlicesProgress
            ? {
                value: slicesDone!,
                max: slicesTotal!,
                tone: "gradient",
              }
            : undefined
        }
      />

      {/* 2 — Active tasks */}
      <KpiTile label="Active tasks" value={activeTasks} />

      {/* 3 — Pending approval */}
      <KpiTile label="Pending approval" value={pendingApproval} />

      {/* 4 — Failed 24h (danger tone when > 0) */}
      <KpiTile label="Failed 24h" value={failed24h} tone={failedTone} />

      {/* 5 — Cost (mono $X.XX with optional budget hint) */}
      <KpiTile
        label="Cost"
        value={costFormatted ?? "—"}
        mono
        hint={costBudgetFormatted ? `of ${costBudgetFormatted}` : undefined}
      />
    </div>
  );
}

export default ProjectKpiRow;
