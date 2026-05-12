import * as React from "react";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * TimeRangeSelect — URL-backed time-range filter for dashboard slices.
 *
 * Renders a native `<select>` with three fixed options ("Last 24 hours",
 * "Last 7 days", "Last 30 days") and drives `?range=` on the URL via
 * `useSearchParams`. Source of truth is the query param; anything
 * outside the allow-list silently falls back to the default and emits a
 * `console.warn` so the operator can spot a bad URL during smoke
 * testing without the page crashing.
 *
 * Why native `<select>`
 * ---------------------
 * The dashboard already ships several headless / Radix popovers; for
 * a 3-option time picker the native control wins on:
 *   - a11y by default (label, keyboard, screen reader),
 *   - zero JS for the open/close interaction,
 *   - mobile UX (the platform sheet is better than any custom popup).
 *
 * Resolution precedence
 * ---------------------
 *   1. validated `?range=` query param,
 *   2. default `'24h'`.
 *
 * Localstorage persistence is intentionally NOT in scope — the dashboard
 * brief calls for the URL to be the single source of truth so a copy-
 * pasted link reproduces the same view.
 */

export type TimeRange = "24h" | "7d" | "30d";

const ALLOWED_RANGES: readonly TimeRange[] = ["24h", "7d", "30d"] as const;
const DEFAULT_RANGE: TimeRange = "24h";

const OPTION_LABELS: Record<TimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

function isTimeRange(value: unknown): value is TimeRange {
  return (
    typeof value === "string" &&
    (ALLOWED_RANGES as readonly string[]).includes(value)
  );
}

export interface TimeRangeSelectProps {
  /** Optional class merge for the outer `<select>`. */
  className?: string;
  /**
   * Optional change hook, fired with the validated next range AFTER the
   * URL has been updated. The dashboard wires this for analytics
   * pings; the component does not depend on it.
   */
  onChange?: (next: TimeRange) => void;
  /**
   * Optional explicit id for the select element — useful when a parent
   * label needs to point at it via `htmlFor`.
   */
  id?: string;
  /**
   * Accessible label override for screen readers when the parent does
   * not render a visible `<label htmlFor>`. Defaults to "Time range".
   */
  "aria-label"?: string;
}

/**
 * Read-only sister hook for callers that need to know the active range
 * without rendering the picker themselves (e.g. the KPI strip
 * fetching usage scoped to the same window).
 */
export function useTimeRange(): TimeRange {
  const [params] = useSearchParams();
  const raw = params.get("range");
  return isTimeRange(raw) ? raw : DEFAULT_RANGE;
}

export function TimeRangeSelect({
  className,
  onChange,
  id,
  "aria-label": ariaLabel = "Time range",
}: TimeRangeSelectProps): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawParam = searchParams.get("range");

  const value: TimeRange = useMemo(() => {
    if (rawParam === null) return DEFAULT_RANGE;
    if (isTimeRange(rawParam)) return rawParam;
    console.warn(
      `[TimeRangeSelect] ignoring unknown ?range= value ${JSON.stringify(rawParam)}; falling back to ${DEFAULT_RANGE}`,
    );
    return DEFAULT_RANGE;
  }, [rawParam]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      if (!isTimeRange(next)) return;
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
    <select
      id={id}
      data-testid="time-range-select"
      aria-label={ariaLabel}
      value={value}
      onChange={handleChange}
      className={cn(
        "px-2.5 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none",
        className,
      )}
    >
      {ALLOWED_RANGES.map((range) => (
        <option key={range} value={range}>
          {OPTION_LABELS[range]}
        </option>
      ))}
    </select>
  );
}

export default TimeRangeSelect;
