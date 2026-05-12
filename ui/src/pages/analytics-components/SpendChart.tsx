// SpendChart — stacked bars by model per day with an indigo→purple
// gradient fill resolved from CSS variables at mount time.
//
// Why a custom Tooltip / Legend content?
// --------------------------------------
// The brief pins the chrome (`bg-card border border-border rounded-md
// p-2 text-[12px]` for the tooltip; `text-zinc-500 text-[11px]` for the
// legend) — recharts' built-in `contentStyle` / `wrapperStyle` props
// only accept inline-style records, so we render the chrome ourselves
// via the `content={…}` slot. The custom content components are
// EXPORTED so the unit-test tier can render them in isolation against
// mocked recharts payload shapes without spinning up a real chart.

import * as React from "react";
import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { formatCostFine } from "@/lib/format";

import {
  CHART_TICK_STYLE,
  CHART_GRID_STROKE,
  getSpendGradientStops,
} from "./chartConstants";

/** One row per day; per-model dollar amounts keyed by model name. */
export interface SpendChartDatum {
  /** ISO date string, e.g. `"2026-05-01"`. */
  day: string;
  /** Per-model spend in USD. Recharts looks these up by `dataKey`. */
  [model: string]: string | number;
}

export interface SpendChartProps {
  /** One entry per day. */
  data: ReadonlyArray<SpendChartDatum>;
  /** Stable order of model series to render as stacked bars. */
  models: ReadonlyArray<string>;
  /** Pixel height of the responsive container. Defaults to 250. */
  height?: number;
}

/** Stable id used in the gradient `<defs>` block. */
export const SPEND_GRADIENT_ID = "spend-gradient";

/** Stable stack id. All bars in the chart share the same stack. */
export const SPEND_STACK_ID = "spend-stack";

/**
 * Module-scoped tooltip cursor — recharts memoizes against object identity, so
 * hoisting the literal saves a tooltip layout recompute on every parent render.
 */
const SPEND_CURSOR = { fill: "var(--muted)", fillOpacity: 0.3 } as const;

/**
 * Tooltip body. Exported so unit tests can render it directly with a
 * mocked recharts payload (recharts itself is stubbed out in tests).
 */
export function SpendTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string;
    name?: string;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <div
      data-testid="spend-tooltip"
      className="bg-card border border-border rounded-md p-2 text-[12px]"
    >
      <div className="mb-1 font-medium">{label}</div>
      <ul className="space-y-0.5">
        {payload.map((entry) => (
          <li
            key={String(entry.dataKey ?? entry.name)}
            className="flex items-center gap-2"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            <span>{entry.name ?? entry.dataKey}</span>
            <span className="ml-auto font-mono">
              {formatCostFine(Number(entry.value ?? 0))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Legend body. Exported and shared between SpendChart + TokenChart so a
 * future palette tweak hits both at once.
 */
export function ChartLegendContent({
  payload,
}: {
  payload?: Array<{ value?: string; color?: string }>;
}): React.ReactElement {
  return (
    <ul
      data-testid="chart-legend"
      className="text-zinc-500 text-[11px] mt-2 flex flex-wrap items-center justify-center gap-3"
    >
      {(payload ?? []).map((entry, idx) => (
        <li key={`${entry.value ?? "_"}-${idx}`} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: entry.color }}
          />
          <span>{entry.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Renders the chart. */
export function SpendChart({
  data,
  models,
  height = 250,
}: SpendChartProps): React.ReactElement {
  // Resolve the gradient stops from CSS vars. Recharts puts <stop> inside
  // <defs>, where stopColor does NOT resolve `var(--…)` natively — so we
  // read the computed value once on mount and re-resolve when the html
  // class changes (theme toggle).
  const [stops, setStops] = useState<{ from: string; to: string }>(() =>
    getSpendGradientStops(),
  );
  useEffect(() => {
    // Lazy initializer above already resolved the stops once; only the
    // theme-toggle observer needs to refresh them on subsequent class
    // changes. Skipping the redundant initial setStops keeps the mount
    // a single render, which the unit tests rely on.
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setStops(getSpendGradientStops()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* Pass data by-reference — Recharts only reads it, and a fresh spread
          every render busts its internal layout-vs-prev memo. */}
      <BarChart data={data as SpendChartDatum[]}>
        <defs>
          <linearGradient
            id={SPEND_GRADIENT_ID}
            data-testid="spend-gradient"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={stops.from} />
            <stop offset="100%" stopColor={stops.to} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
        <XAxis dataKey="day" tick={CHART_TICK_STYLE} />
        <YAxis tick={CHART_TICK_STYLE} />
        <Tooltip content={<SpendTooltipContent />} cursor={SPEND_CURSOR} />
        <Legend content={<ChartLegendContent />} />
        {models.map((model, i) => (
          <Bar
            key={model}
            dataKey={model}
            stackId={SPEND_STACK_ID}
            name={model}
            fill={`url(#${SPEND_GRADIENT_ID})`}
            radius={i === models.length - 1 ? [4, 4, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export default SpendChart;
