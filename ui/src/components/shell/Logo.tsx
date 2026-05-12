import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Logo — the canonical Flockctl brand mark, matching `public/favicon.svg`
 * (three flock-of-arrows chevrons in indigo `#863bff`). One source of
 * truth so the in-app chrome, the auth screens, and any future surfaces
 * (about dialog, empty states, share images, etc.) never drift from the
 * favicon.
 *
 * Render as inline SVG rather than `<img src="/favicon.svg">` so the
 * mark inherits theme colour when the consumer wants to override
 * (`color="currentColor"` use case) and so it never blocks first paint
 * on a network round-trip for the asset.
 */
export interface LogoProps extends React.SVGAttributes<SVGSVGElement> {
  /** Edge length in CSS pixels. Defaults to 16 (TitleBar size). */
  size?: number;
  /**
   * When true, the strokes use `currentColor` so a parent text colour
   * paints the mark — handy for monochrome contexts. Defaults to false
   * (uses the brand indigo `#863bff` so the logo reads as itself
   * regardless of nearby text colour).
   */
  monochrome?: boolean;
}

export function Logo({
  size = 16,
  monochrome = false,
  className,
  ...rest
}: LogoProps): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      <g
        stroke={monochrome ? "currentColor" : "#863bff"}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 26 L32 16 L44 26" />
        <path d="M6 46 L18 36 L30 46" />
        <path d="M34 46 L46 36 L58 46" />
      </g>
    </svg>
  );
}

export default Logo;
