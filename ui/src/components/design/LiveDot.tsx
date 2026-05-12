import * as React from "react";

import { cn } from "@/lib/utils";

export type LiveDotState = "idle" | "live" | "error";
export type LiveDotSize = "xs" | "sm";

/**
 * LiveDot — minimal "is this thing alive?" status dot.
 *
 * The prototype repeats this pattern in the title bar, sidebar rows, and
 * project tiles to signal connection / activity. It's three states and two
 * sizes, no more:
 *   - `idle`  — zinc dot, static. The default rest state.
 *   - `live`  — emerald dot with an emerald-400 halo that uses Tailwind's
 *               `animate-ping` keyframes (scale-up + fade-out, 1s loop).
 *   - `error` — red dot, static.
 *
 * Halo / pulse semantics
 * ----------------------
 * The `pulse` prop is what gates the animated halo. Its default depends
 * on `state` (only `live` pulses by default), but a caller can pass
 * `pulse={false}` to render a static green dot when motion would be
 * distracting (e.g. inside a denser table row), or `pulse={true}` on
 * idle/error if a future caller wants attention without changing tone.
 * The halo only renders when `pulse` is true *and* the state is `live` —
 * the prototype never paints a red or zinc halo, so we don't either.
 *
 * Reduced-motion
 * --------------
 * Tailwind's `animate-ping` does NOT respect `prefers-reduced-motion: reduce`
 * by default, so we layer `motion-reduce:animate-none` on the halo span.
 * That zeros the keyframes for users who've opted out of motion at the OS
 * level, while keeping the dot itself visible (the halo collapses to a
 * static translucent ring, which still reads as "live"). The unit test
 * asserts the class is present; the Playwright reduced-motion tier
 * verifies `getAnimations()` is empty under `reducedMotion: 'reduce'`.
 */
const SIZE_CLASSES: Record<LiveDotSize, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
};

const TONE_CLASSES: Record<LiveDotState, string> = {
  idle: "bg-zinc-400",
  live: "bg-emerald-500",
  error: "bg-red-500",
};

export interface LiveDotProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  state: LiveDotState;
  size?: LiveDotSize;
  /**
   * Animate a halo ring. Defaults to `true` for `live`, `false` for
   * `idle`/`error`. The halo only paints when state is `live` regardless
   * of this flag — non-live halos are intentionally not implemented.
   */
  pulse?: boolean;
}

export function LiveDot({
  state,
  size = "xs",
  pulse,
  className,
  ...rest
}: LiveDotProps): React.JSX.Element {
  const effectivePulse = pulse ?? state === "live";
  const showHalo = state === "live" && effectivePulse;

  return (
    <span
      {...rest}
      data-state={state}
      data-size={size}
      data-pulse={effectivePulse ? "true" : "false"}
      className={cn(
        "relative inline-flex",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {showHalo && (
        <span
          aria-hidden="true"
          data-testid="live-dot-halo"
          className={cn(
            "absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60",
            "animate-ping motion-reduce:animate-none",
          )}
        />
      )}
      <span
        data-testid="live-dot-core"
        className={cn(
          "relative inline-flex rounded-full",
          SIZE_CLASSES[size],
          TONE_CLASSES[state],
        )}
      />
    </span>
  );
}

export default LiveDot;
