// Shared recharts theme tokens.
//
// All dashboard/analytics charts MUST import these constants instead of
// defining their own inline styles. Keeps tooltips, axes and grids
// consistent across light and dark themes and — crucially — guarantees
// readable tooltip text (popover-foreground on popover background) so
// we never ship a white-on-white tooltip again.

export const CHART_TICK_STYLE = {
  fontSize: 12,
  fill: "var(--foreground)",
} as const;

export const CHART_GRID_STROKE = "var(--border)";

export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "var(--popover)",
  borderColor: "var(--border)",
  color: "var(--popover-foreground)",
  borderRadius: "6px",
} as const;

export const CHART_TOOLTIP_ITEM_STYLE = {
  color: "var(--popover-foreground)",
} as const;

export const CHART_TOOLTIP_LABEL_STYLE = {
  color: "var(--popover-foreground)",
  fontWeight: 500,
} as const;

export const CHART_TOOLTIP_CURSOR_FILL = "var(--muted)";

export const CHART_LEGEND_WRAPPER_STYLE = {
  color: "var(--foreground)",
} as const;

// Convenience object — spread into <Tooltip {...CHART_TOOLTIP_PROPS} /> so
// every chart gets identical tooltip styling with one import.
export const CHART_TOOLTIP_PROPS = {
  contentStyle: CHART_TOOLTIP_CONTENT_STYLE,
  itemStyle: CHART_TOOLTIP_ITEM_STYLE,
  labelStyle: CHART_TOOLTIP_LABEL_STYLE,
  cursor: { fill: CHART_TOOLTIP_CURSOR_FILL, fillOpacity: 0.3 },
} as const;
