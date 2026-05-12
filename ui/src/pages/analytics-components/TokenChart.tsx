// TokenChart — paired in/out token-volume lines (indigo + emerald).
//
// Shares the legend chrome with SpendChart so the two analytics panels
// read as a matched pair. The tooltip is local because the formatting
// (integer token counts, not $-currency) differs from spend.

import * as React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

import { CHART_TICK_STYLE, CHART_GRID_STROKE } from "./chartConstants";
import { ChartLegendContent } from "./SpendChart";

export interface TokenChartDatum {
  /** ISO date, e.g. `"2026-05-01"`. */
  day: string;
  /** Total prompt-side token count for the day. */
  tokens_in: number;
  /** Total completion-side token count for the day. */
  tokens_out: number;
}

export interface TokenChartProps {
  data: ReadonlyArray<TokenChartDatum>;
  height?: number;
}

/**
 * Indigo-500 — `--primary` resolves to the same hue, but recharts lines
 * forward `stroke=` to SVG which DOES resolve `var(--…)` natively, so we
 * pass the variable rather than a literal where possible.
 */
export const TOKEN_IN_STROKE = "var(--primary)";

/**
 * Emerald-500 — pinned to the explicit hex with a CSS-var fallback so a
 * future theme that drops `--chart-success` still renders correctly.
 */
export const TOKEN_OUT_STROKE = "var(--chart-success, #10b981)";

/**
 * Module-scoped tooltip cursor — recharts memoizes against object identity, so
 * hoisting the literal saves a tooltip layout recompute on every parent render.
 */
const TOKEN_CURSOR = { stroke: "var(--muted)", strokeDasharray: "3 3" } as const;

export function TokenTooltipContent({
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
      data-testid="token-tooltip"
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
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span>{entry.name ?? entry.dataKey}</span>
            <span className="ml-auto font-mono">
              {Number(entry.value ?? 0).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TokenChart({
  data,
  height = 250,
}: TokenChartProps): React.ReactElement {
  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* Pass data by-reference (see SpendChart for rationale). */}
      <LineChart data={data as TokenChartDatum[]}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
        <XAxis dataKey="day" tick={CHART_TICK_STYLE} />
        <YAxis tick={CHART_TICK_STYLE} />
        <Tooltip content={<TokenTooltipContent />} cursor={TOKEN_CURSOR} />
        <Legend content={<ChartLegendContent />} />
        <Line
          type="monotone"
          dataKey="tokens_in"
          name="In"
          stroke={TOKEN_IN_STROKE}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="tokens_out"
          name="Out"
          stroke={TOKEN_OUT_STROKE}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default TokenChart;
