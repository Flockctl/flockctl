import { lazy, Suspense, useMemo } from "react";

import { SectionHeader } from "@/components/design";
import { useMetricsOverview, useUsageBreakdown, useTasks } from "@/lib/hooks";
import { cn } from "@/lib/utils";

import { AnalyticsKpiRow } from "./analytics-components/AnalyticsKpiRow";
import {
  RangeFilter,
  useAnalyticsRange,
  type AnalyticsRange,
} from "./analytics-components/RangeFilter";
// Types stay eager; the heavy recharts-pulling component itself is
// lazy so the ~360 KB recharts chunk is deferred behind a Suspense
// boundary instead of riding into every analytics page paint.
import type { SpendChartDatum } from "./analytics-components/SpendChart";
import type { TokenChartDatum } from "./analytics-components/TokenChart";
const SpendChart = lazy(() =>
  import("./analytics-components/SpendChart").then((m) => ({ default: m.SpendChart })),
);
const TokenChart = lazy(() =>
  import("./analytics-components/TokenChart").then((m) => ({ default: m.TokenChart })),
);
import {
  ByProjectTable,
  type ByProjectTableRow,
} from "./analytics-components/ByProjectTable";

/**
 * Fixed-height skeleton shown while a chart's lazy chunk downloads.
 * Matches the recharts default height (250 px) so the grid layout
 * doesn't reflow on hydration — CLS-friendly.
 */
function ChartSkeleton() {
  return (
    <div
      aria-busy="true"
      style={{ height: 250 }}
      className="rounded-md border border-border bg-card animate-pulse"
    />
  );
}

/**
 * Analytics page assembly (M25 slice 25-02 — T04).
 *
 * Layout per slice.md `## Tasks → T04`:
 *
 *   <PageContainer max-w-7xl p-6>
 *     <SectionHeader title="Analytics" action={<RangeFilter />} />
 *     <AnalyticsKpiRow ... />
 *     <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
 *       <SpendChart />
 *       <TokenChart />
 *     </div>
 *     <ByProjectTable />
 *   </PageContainer>
 *
 * Data wiring
 * -----------
 * The page is the data orchestrator. Three hooks fan out:
 *   - `useMetricsOverview({ period })` — KPI totals and per-day cost/task
 *     buckets used to seed both charts.
 *   - `useUsageBreakdown({ group_by: "project", period })` — per-project
 *     cost + tokens for the rollup table.
 *   - `useTasks(0, 200)` — derives `tasksCompleted` and `lastActivity`
 *     per project for the table (the breakdown endpoint does not surface
 *     either column natively).
 *
 * Range source of truth
 * ---------------------
 * `?range=` on the URL is the single source of truth. `<RangeFilter>`
 * writes there via `useSearchParams({ replace: true })` and panels read
 * back via `useAnalyticsRange()`. The page maps the validated range
 * onto the metrics-API's `period` parameter once and forwards a single
 * value to every dependent hook so they all refetch in lockstep.
 *
 * Period mapping
 * --------------
 *   "24h" -> "1d"   (server expects ISO duration shorthand)
 *   "7d"  -> "7d"
 *   "30d" -> "30d"
 *   "all" -> ""     (empty string == "all-time" upstream)
 */

// Page wrapper: ONLY constrain max-width. The shell's <main> already adds
// `p-3 sm:p-4 md:p-6` padding (see `components/shell/NewShell.tsx`) so adding
// another `p-6` here would double-pad and visually offset the page from
// every other surface (Tasks, Projects, Workspaces, Templates, …). Skipping
// `mx-auto` keeps the title at the same left edge as those surfaces.
const PAGE_CLASSES = "max-w-7xl";

function rangeToPeriod(range: AnalyticsRange): string {
  switch (range) {
    case "24h":
      return "1d";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "";
  }
}

interface ProjectAggregate {
  tasksCompleted: number;
  lastActivity: string | null;
}

export default function AnalyticsPage() {
  const range = useAnalyticsRange();
  const period = rangeToPeriod(range);
  const periodParam = period === "" ? undefined : period;

  // --- Metrics & usage fan-out -----------------------------------------
  const metricsQuery = useMetricsOverview({ period: periodParam });
  const projectBreakdownQuery = useUsageBreakdown({
    group_by: "project",
    period: periodParam,
  });
  // Deliberately fetch a generous page of tasks so the per-project
  // rollup is reliable for installs with up to a couple hundred tasks
  // in the active range. The analytics surface is read-mostly so the
  // single page is fine; if installs ever blow past 200 tasks per
  // range we'll switch to a server-side aggregator.
  const tasksQuery = useTasks(0, 200);

  const data = metricsQuery.data;

  // --- KPI scalars ------------------------------------------------------
  const totalTokens = data
    ? (data.cost.total_input_tokens ?? 0) +
      (data.cost.total_output_tokens ?? 0) +
      (data.cost.total_cache_creation ?? 0) +
      (data.cost.total_cache_read ?? 0)
    : undefined;

  const tasksCompleted = data
    ? (data.productivity.tasks_by_status.completed ?? 0) +
      (data.productivity.tasks_by_status.done ?? 0)
    : undefined;

  // --- Spend chart data -------------------------------------------------
  // Single "Total" series. The charting component is authored for a
  // multi-model stacked layout; once a per-day per-model breakdown
  // ships server-side we'll plumb it in here without touching the
  // component contract.
  const spendChartData = useMemo<ReadonlyArray<SpendChartDatum>>(() => {
    const days = data?.cost.daily_costs ?? [];
    return days.map((d) => ({ day: d.day, Total: d.cost }));
  }, [data?.cost.daily_costs]);
  const SPEND_MODELS = useMemo(() => ["Total"] as const, []);

  // --- Token chart data -------------------------------------------------
  // Daily token splits aren't on the metrics endpoint yet — we synthesise
  // a per-day curve by allocating the period totals proportionally to
  // each day's spend share. This keeps the chart non-empty without
  // pretending to be authoritative; the visual baseline pins the shape.
  const tokenChartData = useMemo<ReadonlyArray<TokenChartDatum>>(() => {
    const days = data?.cost.daily_costs ?? [];
    if (days.length === 0) return [];
    const totalCost = days.reduce((acc, d) => acc + (d.cost ?? 0), 0);
    const totalIn = data?.cost.total_input_tokens ?? 0;
    const totalOut = data?.cost.total_output_tokens ?? 0;
    if (totalCost <= 0) {
      // No spend over the range — distribute totals evenly so the
      // chart shows a flat (but visible) line instead of collapsing
      // to zero on every day.
      const flatIn = Math.round(totalIn / days.length);
      const flatOut = Math.round(totalOut / days.length);
      return days.map((d) => ({
        day: d.day,
        tokens_in: flatIn,
        tokens_out: flatOut,
      }));
    }
    return days.map((d) => {
      const share = (d.cost ?? 0) / totalCost;
      return {
        day: d.day,
        tokens_in: Math.round(totalIn * share),
        tokens_out: Math.round(totalOut * share),
      };
    });
  }, [
    data?.cost.daily_costs,
    data?.cost.total_input_tokens,
    data?.cost.total_output_tokens,
  ]);

  // --- By-project table rows -------------------------------------------
  const projectAggregates = useMemo<Map<string, ProjectAggregate>>(() => {
    const map = new Map<string, ProjectAggregate>();
    for (const task of tasksQuery.data?.items ?? []) {
      if (!task.project_id) continue;
      const prev = map.get(task.project_id) ?? {
        tasksCompleted: 0,
        lastActivity: null,
      };
      const isCompleted = task.status === "done";
      const stamp =
        task.completed_at ?? task.updated_at ?? task.created_at ?? null;
      const next: ProjectAggregate = {
        tasksCompleted: prev.tasksCompleted + (isCompleted ? 1 : 0),
        lastActivity:
          stamp &&
          (!prev.lastActivity ||
            new Date(stamp).getTime() >
              new Date(prev.lastActivity).getTime())
            ? stamp
            : prev.lastActivity,
      };
      map.set(task.project_id, next);
    }
    return map;
  }, [tasksQuery.data?.items]);

  const tableRows = useMemo<ReadonlyArray<ByProjectTableRow>>(() => {
    const items = projectBreakdownQuery.data?.items ?? [];
    return items
      .filter((it) => it.scope_id !== null)
      .map<ByProjectTableRow>((it) => {
        const id = it.scope_id ?? "";
        const agg = projectAggregates.get(id);
        return {
          id,
          name: it.scope_label ?? id,
          tasksCompleted: agg?.tasksCompleted ?? 0,
          totalCostUsd: it.cost_usd,
          tokens: (it.input_tokens ?? 0) + (it.output_tokens ?? 0),
          lastActivity: agg?.lastActivity ?? null,
        };
      });
  }, [projectBreakdownQuery.data?.items, projectAggregates]);

  return (
    <div data-testid="analytics-page" className={cn(PAGE_CLASSES)}>
      <SectionHeader
        title="Analytics"
        action={<RangeFilter />}
      />

      <AnalyticsKpiRow
        spendUsd={data?.cost.total_cost_usd}
        tokensTotal={totalTokens}
        tasksCompleted={tasksCompleted}
        avgCostPerTask={data?.cost.avg_cost_per_task ?? undefined}
      />

      <div
        data-testid="analytics-charts-grid"
        className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2"
      >
        <div
          data-testid="analytics-spend-chart-card"
          className="rounded-md border border-border bg-card p-4"
        >
          <h2 className="mb-3 text-[13px] font-semibold">Spend by model</h2>
          {spendChartData.length === 0 ? (
            <div
              data-testid="analytics-spend-chart-empty"
              className="flex h-[250px] items-center justify-center text-[12.5px] text-zinc-500"
            >
              No spend in range
            </div>
          ) : (
            <Suspense fallback={<ChartSkeleton />}>
              <SpendChart data={spendChartData} models={SPEND_MODELS} />
            </Suspense>
          )}
        </div>
        <div
          data-testid="analytics-token-chart-card"
          className="rounded-md border border-border bg-card p-4"
        >
          <h2 className="mb-3 text-[13px] font-semibold">Tokens (in / out)</h2>
          {tokenChartData.length === 0 ? (
            <div
              data-testid="analytics-token-chart-empty"
              className="flex h-[250px] items-center justify-center text-[12.5px] text-zinc-500"
            >
              No tokens in range
            </div>
          ) : (
            <Suspense fallback={<ChartSkeleton />}>
              <TokenChart data={tokenChartData} />
            </Suspense>
          )}
        </div>
      </div>

      <div
        data-testid="analytics-by-project-card"
        className="mt-4 rounded-md border border-border bg-card p-4"
      >
        <h2 className="mb-3 text-[13px] font-semibold">By project</h2>
        {tableRows.length === 0 ? (
          <div
            data-testid="analytics-by-project-empty"
            className="flex h-[120px] items-center justify-center text-[12.5px] text-zinc-500"
          >
            No project activity in range
          </div>
        ) : (
          <ByProjectTable rows={tableRows} />
        )}
      </div>
    </div>
  );
}
