import * as React from "react";

import { cn } from "@/lib/utils";

export type SparkbarTone = "emerald" | "indigo" | "amber" | "rose";

/**
 * Tone → static Tailwind class. We can't compose `text-${tone}-500` at
 * runtime because Tailwind's JIT only picks up class strings that appear
 * literally in the source, so we keep the mapping explicit.
 */
const TONE: Record<SparkbarTone, string> = {
  emerald: "text-emerald-500",
  indigo: "text-indigo-500",
  amber: "text-amber-500",
  rose: "text-rose-500",
};

export interface SparkbarProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  data: number[];
  tone?: SparkbarTone;
  /** Maximum number of bars to render (the most recent `maxBars` values). */
  maxBars?: number;
}

/**
 * Sparkbar — inline column-strip primitive built on the shared `.sparkbar`
 * CSS utility (see `ui/src/index.css`). The wrapper picks the tone via a
 * `text-*` class and `.sparkbar` inherits it through `currentColor`.
 *
 * Behaviour:
 *   - Empty `data` → renders nothing (returns null).
 *   - Slices to the most recent `maxBars` values (default 8).
 *   - Each bar's height is scaled to the [4, 28]px window from the
 *     min/max of the sliced data. A flat series (range = 0) collapses to
 *     the floor (4px) for every bar.
 */
export function Sparkbar({
  data,
  tone = "indigo",
  maxBars = 8,
  className,
  ...rest
}: SparkbarProps) {
  if (!data.length) return null;
  const slice = data.slice(-maxBars);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  const range = max - min || 1;
  return (
    <span
      {...rest}
      data-tone={tone}
      className={cn("mono text-[10px]", TONE[tone], className)}
    >
      {slice.map((v, i) => (
        <span
          key={i}
          className="sparkbar"
          style={{ height: `${4 + ((v - min) / range) * 24}px` }}
        />
      ))}
    </span>
  );
}

export default Sparkbar;
