import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * EmptyState — reusable "nothing here yet" panel for list pages.
 *
 * Restyled (M-EmptyState restyle): dim icon + title + optional CTA.
 * The previous variant wrapped the icon in a soft circle and stacked
 * a description and an action below it. The new look is intentionally
 * flatter — the icon is rendered directly in muted-foreground tone
 * (no background plate), the title carries the message, and the
 * description + action slots remain optional for callers that need
 * them. This gives the same component a quieter footprint when used
 * for "all caught up" states (e.g. the attention/inbox page) while
 * still supporting busier empty states like "No projects yet — + New
 * project".
 *
 * Slots:
 *   - `icon` — optional Lucide icon component, rendered ~28px in a
 *              dim, muted-foreground tone (no plate behind it).
 *   - `title` — bold, 1-line headline. Tells the user what's missing.
 *   - `description` — 1-2 sentence muted-tone explanation. Optional.
 *   - `action` — call-to-action node (typically a Button). Optional;
 *                rendered below the description with a little extra
 *                top spacing.
 *
 * Pure presentational — no animation, no data fetching, no shadow
 * gimmicks. Pages compose this when their list returns empty so the
 * UX is consistent everywhere.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  "data-testid": testId,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card/40 px-6 py-12 text-center ${className ?? ""}`}
    >
      {Icon && (
        <Icon
          className="h-7 w-7 text-muted-foreground/60"
          aria-hidden="true"
          data-testid="empty-state-icon"
        />
      )}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export default EmptyState;
