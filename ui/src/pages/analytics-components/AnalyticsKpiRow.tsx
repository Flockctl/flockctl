import * as React from "react";

import { KpiTile } from "@/components/design";
import { formatUsdGuarded } from "@/lib/format";

/**
 * AnalyticsKpiRow — top-of-page summary strip for `/analytics`.
 *
 * Layout
 * ------
 * Four `<KpiTile>` instances in a single row at `lg+`, collapsing to
 * 2-up at `sm` and a single column on the smallest viewports. The four
 * tiles, left → right (matches the prototype's analytics header):
 *
 *   1. Spend            — mono `$X.XX`, total cost over the active range.
 *   2. Tokens           — mono total, compact-formatted by KpiTile.
 *   3. Tasks completed  — plain count of tasks that finished in-range.
 *   4. Avg cost / task  — mono `$X.XXXX`, four decimals because per-task
 *                          cost frequently lives below a cent.
 *
 * Numeric formatting
 * ------------------
 * - **Spend** uses the standard 2-decimal USD formatter; the reader
 *   needs cents precision for daily-burn diagnostics.
 * - **Avg cost / task** uses 4-decimal precision because individual
 *   task costs are commonly $0.001–$0.05 — 2 decimals would round
 *   most rows to "$0.00" and hide the signal.
 * - **Tokens** and **Tasks completed** are passed as raw numbers and
 *   rely on `KpiTile`'s `Intl.NumberFormat` compact formatter (`12.4K`,
 *   `1.2M`) to keep the tile single-line at every magnitude.
 *
 * Why no built-in data fetch
 * --------------------------
 * The component is presentational on purpose. The page (`analytics.tsx`)
 * already calls `useMetricsOverview` and pipes the result through to
 * `<AnalyticsKpiRow>` so a single render of the page only fetches
 * once. Wiring the fetch inside the strip would either duplicate the
 * request or force the page into a stale-data dance.
 */

export interface AnalyticsKpiRowProps {
  /** Total spend in USD over the active range. */
  spendUsd: number | undefined;
  /** Total tokens (input + output + cache) over the active range. */
  tokensTotal: number | undefined;
  /** Number of tasks that completed (success or done) over the range. */
  tasksCompleted: number | undefined;
  /** Average cost per task in USD over the range. */
  avgCostPerTask: number | undefined;
}

export function AnalyticsKpiRow({
  spendUsd,
  tokensTotal,
  tasksCompleted,
  avgCostPerTask,
}: AnalyticsKpiRowProps): React.JSX.Element {
  const spendFormatted = formatUsdGuarded(spendUsd, 2);
  const avgCostFormatted = formatUsdGuarded(avgCostPerTask, 4);

  return (
    <div
      data-testid="analytics-kpi-row"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {/* 1 — Spend */}
      <KpiTile label="Spend" value={spendFormatted ?? "—"} mono />

      {/* 2 — Tokens */}
      <KpiTile label="Tokens" value={tokensTotal} mono />

      {/* 3 — Tasks completed */}
      <KpiTile label="Tasks completed" value={tasksCompleted} />

      {/* 4 — Avg cost / task */}
      <KpiTile
        label="Avg cost / task"
        value={avgCostFormatted ?? "—"}
        mono
      />
    </div>
  );
}

export default AnalyticsKpiRow;
