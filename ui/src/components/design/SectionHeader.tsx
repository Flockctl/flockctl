import type { ReactNode } from "react";

/**
 * SectionHeader — flat heading primitive used by every redesigned page
 * surface (M23–M25). Two sizes:
 *
 *   - `size="page"` (default): the page title block. Renders an `<h1>`
 *     in `text-2xl font-semibold` with an optional subtitle below it
 *     and an optional `action` slot pinned to the right (typically a
 *     primary button or a small toolbar). Bottom margin `mb-6` so the
 *     content below sits at the prototype's spacing without callers
 *     having to remember it.
 *
 *   - `size="section"`: a tighter in-page section divider. Renders an
 *     `<h2>` in `font-semibold`, an optional small zinc-500 subtitle
 *     (typically a count, e.g. "12 items"), an optional leading colour
 *     swatch (`leadingSwatch` is a Tailwind class string applied to a
 *     2.5×2.5 rounded-sm span), and a horizontal hairline that fills
 *     the remaining row width. The hairline is what makes the prototype
 *     feel "flat" rather than "carded".
 *
 * No state, no animation, no theming knobs. Pure layout. The colour
 * tokens (`text-zinc-500`, `bg-zinc-200 dark:bg-zinc-800`) match the
 * `.flockctl/plan/ui-prototype.html` source verbatim.
 */
export interface SectionHeaderProps {
  /** Heading text. Required. */
  title: string;
  /** Secondary line — page-size description, or section-size count. */
  subtitle?: string;
  /** Right-aligned slot. Buttons, badges, toolbars — whatever. */
  action?: ReactNode;
  /** `page` (default) renders an h1; `section` renders an h2 + hairline. */
  size?: "page" | "section";
  /**
   * Section-only: Tailwind background class for the leading 10px square
   * (e.g. `"bg-emerald-500"`). Ignored at `size="page"`.
   */
  leadingSwatch?: string;
  /** Test hook. */
  "data-testid"?: string;
}

export function SectionHeader({
  title,
  subtitle,
  action,
  size = "page",
  leadingSwatch,
  "data-testid": testId,
}: SectionHeaderProps) {
  if (size === "section") {
    return (
      <div
        data-testid={testId ?? "section-header"}
        data-size="section"
        className="flex items-center gap-2 mb-2.5"
      >
        {leadingSwatch && (
          <span
            data-testid="section-header-swatch"
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-sm ${leadingSwatch}`}
          />
        )}
        <h2 className="text-[13px] font-semibold leading-tight">{title}</h2>
        {subtitle && (
          <span className="text-[11px] text-zinc-500">{subtitle}</span>
        )}
        <div
          aria-hidden="true"
          className="flex-1 h-px bg-zinc-200 dark:bg-zinc-800 ml-2"
        />
        {action && <>{action}</>}
      </div>
    );
  }

  // size === "page"
  return (
    <div
      data-testid={testId ?? "section-header"}
      data-size="page"
      className="flex items-end justify-between mb-4"
    >
      <div>
        <h1 className="text-[15px] font-semibold leading-tight">{title}</h1>
        {subtitle && (
          <p className="text-zinc-500 mt-0.5 text-[11px] leading-tight">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

export default SectionHeader;
