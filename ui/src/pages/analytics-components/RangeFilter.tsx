import * as React from "react";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { SegmentToggle } from "@/components/design";

/**
 * RangeFilter — URL-backed date-range filter for the analytics page.
 *
 * Renders a 4-option segmented toggle (24h / 7d / 30d / all) and drives
 * `?range=` on the URL via `useSearchParams`. The query param is the
 * single source of truth so a copy-pasted link reproduces the same
 * view. Anything outside the allow-list silently falls back to the
 * default (`7d`) and emits a `console.warn` so the operator can spot a
 * bad URL during smoke testing without the page crashing.
 *
 * Default is `7d` (NOT `24h` — the analytics page is a multi-day cost
 * dashboard, not an "is it on fire right now" surface like the home
 * dashboard's `TimeRangeSelect`).
 *
 * Resolution precedence
 * ---------------------
 *   1. validated `?range=` query param,
 *   2. default `'7d'`.
 *
 * Composition
 * -----------
 * Wraps the shared `<SegmentToggle>` design primitive (M22) so the
 * keyboard contract (ArrowLeft / ArrowRight / Home / End / Enter) and
 * the radiogroup a11y wiring come for free. Pages should NEVER read or
 * write `?range=` directly — go through `useAnalyticsRange()` so the
 * validation and fallback logic stays consistent across panels.
 */

export type AnalyticsRange = "24h" | "7d" | "30d" | "all";

const ALLOWED_RANGES: readonly AnalyticsRange[] = [
  "24h",
  "7d",
  "30d",
  "all",
] as const;

const DEFAULT_RANGE: AnalyticsRange = "7d";

const OPTIONS = [
  { value: "24h" as const, label: "24h" },
  { value: "7d" as const, label: "7d" },
  { value: "30d" as const, label: "30d" },
  { value: "all" as const, label: "All" },
];

function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return (
    typeof value === "string" &&
    (ALLOWED_RANGES as readonly string[]).includes(value)
  );
}

export interface RangeFilterProps {
  /** Optional class merge for the outer wrapper. */
  className?: string;
  /**
   * Optional change hook, fired with the validated next range AFTER the
   * URL has been updated. Analytics panels that re-fetch on range
   * change generally subscribe via `useAnalyticsRange()` instead of
   * this callback — the prop is here for telemetry pings.
   */
  onChange?: (next: AnalyticsRange) => void;
  /**
   * Accessible label for the radiogroup. Defaults to "Date range".
   */
  "aria-label"?: string;
}

/**
 * Read-only sister hook for analytics panels that need to know the
 * active range without rendering the picker themselves.
 *
 * Returns the validated current range (or `7d` if `?range=` is absent
 * or invalid). Subscribes to URL changes via `useSearchParams` so the
 * panel re-renders when the operator picks a new range.
 */
export function useAnalyticsRange(): AnalyticsRange {
  const [params] = useSearchParams();
  const raw = params.get("range");
  return isAnalyticsRange(raw) ? raw : DEFAULT_RANGE;
}

export function RangeFilter({
  className,
  onChange,
  "aria-label": ariaLabel = "Date range",
}: RangeFilterProps): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawParam = searchParams.get("range");

  const value: AnalyticsRange = useMemo(() => {
    if (rawParam === null) return DEFAULT_RANGE;
    if (isAnalyticsRange(rawParam)) return rawParam;
    console.warn(
      `[RangeFilter] ignoring unknown ?range= value ${JSON.stringify(rawParam)}; falling back to ${DEFAULT_RANGE}`,
    );
    return DEFAULT_RANGE;
  }, [rawParam]);

  const handleChange = useCallback(
    (next: AnalyticsRange) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("range", next);
          return params;
        },
        { replace: true },
      );
      onChange?.(next);
    },
    [setSearchParams, onChange],
  );

  return (
    <SegmentToggle<AnalyticsRange>
      options={OPTIONS}
      value={value}
      onChange={handleChange}
      size="md"
      aria-label={ariaLabel}
      data-testid="analytics-range-filter"
      className={className}
    />
  );
}

export default RangeFilter;
