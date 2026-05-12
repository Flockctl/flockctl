// Analytics chart palette wiring (T00 of slice 25-02-analytics).
//
// Single source of truth for every Recharts surface inside
// `ui/src/pages/analytics.tsx` and the `analytics-components/` family
// (SpendChart, TokenChart, etc. authored in T01–T04).
//
// Wiring rule
// ===========
// All chart styling reads from CSS variables defined in
// `ui/src/index.css` (light + `.dark`). This guarantees:
//   - Recharts axes/grids/tooltips track the active theme without
//     a remount or a useEffect dance.
//   - Future palette tweaks happen in one place (the `:root` block),
//     not scattered hex literals across 5+ chart components.
//
// Where Recharts requires a literal (the `<defs>` gradient case —
// `<stop stopColor=…>` does NOT accept `var(--…)`), use
// `resolveCssVar` to read the computed value from `:root` at mount
// time, then re-resolve on theme toggle. See `useChartPalette` in
// T02 for the consumer pattern.
//
// Re-export pass-through
// ----------------------
// Where the shared `@/lib/chart-theme` already exposes a constant
// with the right wiring, we re-export under a stable name so every
// analytics chart imports from this single module instead of
// drilling into `lib/chart-theme`. Prevents the situation where a
// future contributor copies the SpendChart and pulls a hex literal
// from a sibling chart.

export {
  CHART_TICK_STYLE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  CHART_TOOLTIP_CURSOR_FILL,
  CHART_TOOLTIP_PROPS,
  CHART_LEGEND_WRAPPER_STYLE,
} from "@/lib/chart-theme";

// ---------------------------------------------------------------
// Per-series colours (CSS-variable reads).
//
// These are passed into `<Bar fill=… />` / `<Line stroke=… />`
// where Recharts accepts a `var(--…)` string directly (Recharts
// forwards the prop to SVG, which resolves the var natively).
// ---------------------------------------------------------------

/** Indigo accent — primary metric series (e.g. spend, peak hours). */
export const CHART_SERIES_PRIMARY = "var(--primary)";

/** Emerald success — completed tasks, positive throughput. */
export const CHART_SERIES_SUCCESS = "var(--chart-success, #10b981)";

/** Amber warning — retry rate, queue wait. */
export const CHART_SERIES_WARNING = "var(--chart-warning, #f59e0b)";

/** Red destructive — failed tasks, error trend. */
export const CHART_SERIES_DANGER = "var(--destructive)";

/** Purple — special / mission-related series. */
export const CHART_SERIES_MISSION = "var(--chart-mission, #a855f7)";

/** Muted reference — secondary lines, "previous period" overlays. */
export const CHART_SERIES_MUTED = "var(--muted-foreground)";

/**
 * Categorical palette for "by-model" / "by-project" bars where each
 * series needs a stable distinct colour. Order matches the prototype's
 * stack order (indigo first, then alternating warm/cool).
 *
 * Recharts maps `dataKey` order → palette index in T02's `<Bar>` stack.
 */
export const CHART_CATEGORICAL_PALETTE = [
  CHART_SERIES_PRIMARY,
  CHART_SERIES_MISSION,
  CHART_SERIES_SUCCESS,
  CHART_SERIES_WARNING,
  CHART_SERIES_DANGER,
] as const;

// ---------------------------------------------------------------
// <defs> gradient handling.
//
// Recharts 2.x renders <linearGradient><stop stopColor=…> inside an
// SVG <defs> block. The browser does NOT resolve `var(--…)` inside
// `stopColor` (the SVG paint server resolves at use site, not at
// element-attribute evaluation time, and Recharts re-renders the
// gradient on data change anyway).
//
// To keep gradients on the new palette, components that draw a
// gradient (the prototype's "Spend by model" indigo→purple stacked
// bars are the canonical case) must:
//
//   1. On mount, read the resolved value of the relevant variables
//      from `getComputedStyle(document.documentElement)` via
//      `resolveCssVar` below.
//   2. Pass those resolved hex/oklch strings into the `<stop>`
//      elements.
//   3. Re-run resolution when the theme toggles (subscribe to the
//      `class` mutation on `<html>`, or re-derive in a `useTheme`
//      effect — see T02 SpendChart for the canonical hook).
//
// This is the only place where a hex literal may legitimately leak
// into an analytics chart, and even then it must originate from a
// CSS variable read.
// ---------------------------------------------------------------

/**
 * Read the resolved value of a CSS custom property from `:root`.
 * Returns the trimmed computed value, or `fallback` when the variable
 * is unset or the call happens server-side (no `document`).
 *
 * Always pass the leading `--` (e.g. `resolveCssVar("--primary")`).
 */
export function resolveCssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Convenience: returns the two-stop gradient definition for the
 * spend-by-model bars (indigo → purple). Resolved at call site so
 * the consumer can re-derive on theme toggle.
 *
 *   const { from, to } = getSpendGradientStops();
 *   <stop offset="0%" stopColor={from} />
 *   <stop offset="100%" stopColor={to} />
 */
export function getSpendGradientStops(): { from: string; to: string } {
  return {
    from: resolveCssVar("--primary", "#6366f1"),
    to: resolveCssVar("--chart-mission", "#a855f7"),
  };
}
