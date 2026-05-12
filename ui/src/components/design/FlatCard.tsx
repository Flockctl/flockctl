import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * FlatCard — a hard-flat replacement for the shadcn `<Card>` primitive.
 *
 * Rationale
 * ---------
 * The dev tokens preview's flat surface theme calls for a card with:
 *   - rounded-xl outer radius,
 *   - a single `border` + `divider-y` (border-color tracks `--border`),
 *   - `bg-card` background,
 *   - an optional `footer` slot separated by a top hairline divider,
 *   - and a `card-hover` lift when the card is interactive.
 *
 * That's three more responsibilities than `<Card>` carries (which is a
 * generic wrapper plus `CardHeader`/`CardContent`/`CardFooter`
 * subcomponents) and the resulting component is small enough that
 * inheriting from shadcn would just pull in style we'd then have to
 * override. So this is a flat, self-contained primitive.
 *
 * Interactive vs. clickable
 * -------------------------
 * `interactive` is intentionally decoupled from `onClick`:
 *   - `interactive=true` adds `role="button"`, `tabIndex={0}`, the hover
 *     lift, the cursor pointer, and Enter/Space keyboard activation.
 *   - `onClick` is wired up only when `interactive=true` (otherwise the
 *     surface is non-interactive and a click handler would be misleading).
 *   - `interactive=true` *without* `onClick` is allowed — the parent may
 *     wire up clicks via event delegation. We log a `console.warn` in
 *     development so a forgotten handler doesn't go unnoticed.
 */
export interface FlatCardProps {
  interactive?: boolean;
  onClick?: () => void;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function FlatCard({
  interactive,
  onClick,
  footer,
  className,
  children,
}: FlatCardProps): React.JSX.Element {
  // Dev-only nudge: an interactive card without an onClick prop is the
  // shape that event-delegation parents use, but it's also the easiest
  // way to forget to wire a click handler. Warn once on render so the
  // misuse case shows up in the console without affecting prod bundles.
  if (
    process.env.NODE_ENV !== "production" &&
    interactive === true &&
    onClick === undefined
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      "[FlatCard] interactive=true without onClick — make sure a parent " +
        "handles clicks via event delegation, or pass onClick.",
    );
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={handleKeyDown}
      onClick={interactive ? onClick : undefined}
      className={cn(
        "rounded-xl border divider-y bg-card",
        interactive && "card-hover cursor-pointer",
        className,
      )}
    >
      {children}
      {footer && (
        <div className="border-t divider-y px-4 py-2">{footer}</div>
      )}
    </div>
  );
}

export default FlatCard;
