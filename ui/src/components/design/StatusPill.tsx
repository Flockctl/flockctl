import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusPillTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

export type StatusPillSize = "sm" | "md";

const TONE: Record<StatusPillTone, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  danger: "bg-red-500/15 text-red-600 dark:text-red-400",
  info: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  neutral: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

const SIZE: Record<StatusPillSize, string> = {
  md: "text-[11px]",
  sm: "text-[10px]",
};

export interface StatusPillProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusPillTone;
  size?: StatusPillSize;
  children: React.ReactNode;
}

/**
 * StatusPill — small, uppercase, semantic status indicator.
 *
 * Tones map to a shared semantic palette (success/warning/danger/info/neutral).
 * Size defaults to `md` (text-[11px]); pass `size="sm"` for the denser
 * text-[10px] variant. The wrapper applies `rounded px-1.5 py-0.5
 * uppercase tracking-wider font-semibold`.
 */
export function StatusPill({
  tone,
  size = "md",
  className,
  children,
  ...rest
}: StatusPillProps) {
  return (
    <span
      {...rest}
      data-tone={tone}
      data-size={size}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 uppercase tracking-wider font-semibold",
        SIZE[size],
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export default StatusPill;
