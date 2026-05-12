import * as React from "react";

import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/design/StatusPill";

/**
 * KpiTile — flat, single-stat summary tile.
 *
 * Layout (top-to-bottom)
 * ----------------------
 *   [label uppercase tracking-wider zinc-500 / red-500 if danger]
 *   [VALUE big bold (mono if requested)] [trend pill] [hint]
 *   [ optional Sparkbar ]
 *   [ optional progress bar ]
 *
 * Reuses
 * ------
 * - <StatusPill> (T02) for the trend chip when `trend.tone !== 'neutral'`.
 *   Neutral trends render as a plain muted span — pills here are reserved
 *   for "this number moved" signals (positive / negative).
 * - The `.sparkbar` utility (see `index.css` @layer utilities) is rendered
 *   inline rather than via the dedicated <Sparkbar> primitive (T06): T06
 *   will land in a sibling task and KpiTile will switch to importing it
 *   then. Keeping it inline now keeps T05 self-contained and avoids
 *   shipping a half-finished primitive.
 *
 * Conventions
 * -----------
 * - No `onClick` prop. Wrap the tile in `<FlatCard interactive>` to make
 *   it clickable.
 * - Tone is passed in (`default | danger | warning`); never bake colour in.
 * - `value === undefined` renders an em-dash placeholder. We never render
 *   `NaN` or `"undefined"`.
 * - Numeric values >= 1000 are abbreviated via `Intl.NumberFormat`'s
 *   compact notation (`1.2K`, `412K`, `1.2M`) so the tile keeps a single
 *   visual line at every magnitude.
 * - If both `spark` and `progress` are supplied the progress bar wins and
 *   we `console.warn` once — that combination is a caller error.
 */

export type KpiTileTone = "default" | "danger" | "warning";

export interface KpiTileTrend {
  delta: string;
  tone: "positive" | "negative" | "neutral";
}

export interface KpiTileProgress {
  value: number;
  max: number;
  tone?: "indigo" | "gradient";
}

export interface KpiTileProps {
  label: string;
  value: string | number | undefined;
  mono?: boolean;
  trend?: KpiTileTrend;
  spark?: number[];
  progress?: KpiTileProgress;
  hint?: string;
  tone?: KpiTileTone;
}

const TONE_LABEL: Record<KpiTileTone, string> = {
  default: "text-zinc-500 dark:text-zinc-400",
  danger: "text-red-500",
  warning: "text-amber-500 dark:text-amber-400",
};

// --- dev warning dedupe ----------------------------------------------------
//
// The negative-test contract (`tone='hax0r' falls back to default + warn`)
// implies a console.warn — but firing one per render would spam the console
// in any list of tiles. Dedupe by tone token, the same way StatusPill (T02)
// is specified to dedupe on its tone fallback.
const _warnedUnknownTones = new Set<string>();
const _warnedSparkProgressConflict = { fired: false };

function warnUnknownTone(tone: string) {
  if (process.env.NODE_ENV === "production") return;
  if (_warnedUnknownTones.has(tone)) return;
  _warnedUnknownTones.add(tone);
  // eslint-disable-next-line no-console
  console.warn(
    `[KpiTile] unknown tone="${tone}" — falling back to "default". ` +
      `Allowed values: default | danger | warning.`,
  );
}

function warnSparkProgressConflict() {
  if (process.env.NODE_ENV === "production") return;
  if (_warnedSparkProgressConflict.fired) return;
  _warnedSparkProgressConflict.fired = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[KpiTile] both `spark` and `progress` were supplied — rendering " +
      "`progress` and ignoring `spark`. Pass only one.",
  );
}

// Test-only resets so a `vi.spyOn(console, 'warn')` block in a single test
// can opt back into observing the next warn without leaking state from a
// previous test in the same module.
export function _resetKpiTileWarnings(): void {
  _warnedUnknownTones.clear();
  _warnedSparkProgressConflict.fired = false;
}

// --- value formatting ------------------------------------------------------

const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Render a stat value as a string. Strings pass through, numbers use
 * compact notation past 1000, undefined / NaN render as `—`.
 */
export function formatKpiValue(v: string | number | undefined): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v;
  if (Number.isNaN(v) || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return COMPACT_FORMATTER.format(v);
  // Preserve integers exactly; format floats with up to 2 decimals so a
  // raw 0.4321 doesn't sprawl across the tile.
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

// --- inline Sparkbar -------------------------------------------------------

const SPARK_TONE: Record<NonNullable<KpiTileProps["tone"]>, string> = {
  default: "text-indigo-500",
  danger: "text-red-500",
  warning: "text-amber-500",
};

function InlineSparkbar({
  data,
  tone,
}: {
  data: number[];
  tone: KpiTileTone;
}) {
  if (!data.length) return null;
  const slice = data.slice(-8);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  const range = max - min || 1;
  return (
    <span
      data-testid="kpi-sparkbar"
      className={cn(
        "mono inline-flex h-7 items-end gap-0 text-[10px]",
        SPARK_TONE[tone],
      )}
    >
      {slice.map((v, i) => (
        <span
          key={i}
          className="sparkbar"
          // 4..28 px range — the brief's spec for `.sparkbar` heights.
          style={{ height: `${4 + ((v - min) / range) * 24}px` }}
        />
      ))}
    </span>
  );
}

// --- inline progress bar ---------------------------------------------------

function InlineProgress({
  progress,
  ariaLabel,
}: {
  progress: KpiTileProgress;
  ariaLabel: string;
}) {
  const { value, max, tone = "indigo" } = progress;
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  const fillCls =
    tone === "gradient"
      ? "bg-gradient-to-r from-indigo-400 to-indigo-600"
      : "bg-indigo-500";
  return (
    <div
      data-testid="kpi-progress"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
    >
      <div
        className={cn("h-full rounded-full transition-all", fillCls)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// --- trend chip ------------------------------------------------------------

const TREND_PILL_TONE: Record<
  KpiTileTrend["tone"],
  "success" | "danger" | null
> = {
  positive: "success",
  negative: "danger",
  // Per spec: neutral renders without StatusPill (plain muted span).
  neutral: null,
};

function TrendChip({ trend }: { trend: KpiTileTrend }) {
  const pillTone = TREND_PILL_TONE[trend.tone];
  if (pillTone === null) {
    return (
      <span
        data-testid="kpi-trend"
        data-trend-tone="neutral"
        className="mono text-[11px] text-zinc-500 dark:text-zinc-400"
      >
        {trend.delta}
      </span>
    );
  }
  return (
    <StatusPill
      tone={pillTone}
      size="sm"
      data-testid="kpi-trend"
      data-trend-tone={trend.tone}
    >
      {trend.delta}
    </StatusPill>
  );
}

// --- KpiTile ---------------------------------------------------------------

export function KpiTile({
  label,
  value,
  mono,
  trend,
  spark,
  progress,
  hint,
  tone = "default",
}: KpiTileProps): React.JSX.Element {
  // Tone fallback for misuse (typed as `KpiTileTone`, but JS callers /
  // unsafe casts can still smuggle in junk). Warn once per unknown tone.
  let safeTone: KpiTileTone;
  if (tone === "default" || tone === "danger" || tone === "warning") {
    safeTone = tone;
  } else {
    warnUnknownTone(String(tone));
    safeTone = "default";
  }

  // spark + progress is a caller error — render progress, warn once.
  const showProgress = progress !== undefined;
  const showSpark = spark !== undefined && !showProgress;
  if (progress !== undefined && spark !== undefined) {
    warnSparkProgressConflict();
  }

  return (
    <div
      data-testid="kpi-tile"
      data-tone={safeTone}
      className={cn(
        "rounded-xl border divider-y bg-white dark:bg-zinc-900 p-3.5",
      )}
    >
      <div
        data-testid="kpi-label"
        className={cn(
          "text-[11px] uppercase tracking-wider font-medium",
          TONE_LABEL[safeTone],
        )}
      >
        {label}
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          data-testid="kpi-value"
          className={cn(
            "text-[18px] font-semibold tabular-nums leading-none",
            mono && "mono",
          )}
        >
          {formatKpiValue(value)}
        </span>
        {trend && <TrendChip trend={trend} />}
        {hint && (
          <span
            data-testid="kpi-hint"
            className="ml-auto text-[11px] text-zinc-500 dark:text-zinc-400"
          >
            {hint}
          </span>
        )}
      </div>

      {showSpark && (
        <div className="mt-2">
          <InlineSparkbar data={spark!} tone={safeTone} />
        </div>
      )}

      {showProgress && (
        <div className="mt-2">
          <InlineProgress
            progress={progress!}
            ariaLabel={`${label} progress: ${progress!.value} of ${progress!.max}`}
          />
        </div>
      )}
    </div>
  );
}

export default KpiTile;
