import { ChevronRight, CheckCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MilestoneTree } from "@/lib/types";

/**
 * MilestoneRail — left-rail milestone selector for the redesigned
 * project-detail page (slice 23-00 T04).
 *
 * The rail renders milestones as a vertical list of flush row buttons.
 * Each row carries:
 *
 *   [ChevronRight (collapse marker, decorative)] [CheckCircle (only if
 *   completed)] [Milestone title — truncated, full text in `title=`]
 *
 * Visual contract (matches the prototype in
 * `docs/prototypes/mission-control.html`, lines ~720–1200):
 *
 *   - Active milestone: `bg-zinc-100 dark:bg-zinc-800`
 *   - Hover (any row): `hover:bg-zinc-100 dark:hover:bg-zinc-800`
 *   - Idle:            transparent background
 *   - Chevron:         `text-zinc-400`     (decorative; aria-hidden)
 *   - Completed icon:  `text-emerald-500`  (with screen-reader label)
 *   - Title:           `truncate flex-1 text-left`, `title={title}` so
 *                      the full string is always available on hover.
 *
 * Behavioural contract:
 *
 *   - Selection is **prop-driven**. The parent (`ProjectDetailBoardView`
 *     / `PlanTab`) wires `activeMilestoneId` and `onSelectMilestone`
 *     to {@link useSelection} so the URL `?milestone=<id>` stays the
 *     single source of truth — that contract is preserved across tab
 *     switches because the URL outlives a tab change. We deliberately
 *     do NOT call `useSelection` here so the rail stays trivially
 *     testable without a router context wrapper, AND so an alternate
 *     parent (e.g. a future swimlane view) can drive selection from
 *     local state without leaking router coupling into this file.
 *   - Clicking the active milestone fires `onSelectMilestone(id)` again
 *     (idempotent). Parents may treat that as a no-op or use it to
 *     signal "user clicked the same row". We do NOT special-case it
 *     here — that would surprise parents who rely on the click event
 *     for a non-URL side effect (e.g. closing a mobile drawer).
 *   - The button is `type="button"` so a parent `<form>` does not
 *     submit when the user picks a milestone.
 *
 * Truncation contract (negative test pin):
 *
 *   - `truncate` clips overflow with an ellipsis at the row width.
 *   - `title={milestone.title}` puts the full string in the native
 *     tooltip so an 80-char-plus title remains discoverable. The DOM
 *     `title` attribute is the simplest accessibility-safe affordance
 *     here; we are not introducing a Radix/HoverCard tooltip for
 *     parity with the rest of the rail (no other affordance uses
 *     that pattern).
 *
 * Empty / missing data:
 *
 *   - An empty `milestones` array renders an empty `<nav>` with
 *     `data-testid="milestone-rail-empty"` so the parent can decide
 *     whether to overlay an empty-state CTA. The rail itself stays
 *     dumb so a future "Generate plan" affordance can land in the
 *     same slot without retrofitting state into this file.
 *
 * Test-id surface (consumed by `project-detail-milestone-rail.test.tsx`):
 *
 *   - `milestone-rail`             root `<nav>`
 *   - `milestone-rail-empty`       root when `milestones.length === 0`
 *   - `milestone-rail-item`        every row button
 *   - `milestone-rail-item-<id>`   per-row pin (lets the test target a
 *                                  specific row by milestone id without
 *                                  scanning by text).
 */

export interface MilestoneRailProps {
  /** Milestones to render, in display order (caller-sorted). */
  milestones: MilestoneTree[];
  /**
   * Currently-active milestone id (typically read from `?milestone=`
   * via `useSelection`). When `null`/`undefined`, no row is
   * highlighted.
   */
  activeMilestoneId?: string | null;
  /**
   * Click handler for a row. Fired with the milestone id that was
   * clicked. The parent is responsible for writing the id back to the
   * URL so the selection survives a tab switch / page reload.
   */
  onSelectMilestone?: (id: string) => void;
  /** Optional extra classes merged onto the outer `<nav>` container. */
  className?: string;
}

export function MilestoneRail({
  milestones,
  activeMilestoneId,
  onSelectMilestone,
  className,
}: MilestoneRailProps) {
  if (milestones.length === 0) {
    return (
      <nav
        aria-label="Milestones"
        data-testid="milestone-rail-empty"
        className={cn("flex flex-col gap-0.5 p-2", className)}
      />
    );
  }

  return (
    <nav
      aria-label="Milestones"
      data-testid="milestone-rail"
      className={cn("flex flex-col gap-0.5 p-2", className)}
    >
      {milestones.map((milestone) => {
        const isActive = milestone.id === activeMilestoneId;
        const isCompleted = milestone.status === "completed";
        return (
          <button
            key={milestone.id}
            type="button"
            data-testid="milestone-rail-item"
            data-milestone-id={milestone.id}
            data-active={isActive ? "true" : undefined}
            aria-current={isActive ? "true" : undefined}
            // The full title is duplicated into `title=` so an 80-char
            // string clipped by `truncate` is still discoverable on
            // hover. Negative test pin:
            // milestone-rail.test.tsx::milestone title 80 chars
            // truncates with title attr.
            title={milestone.title}
            onClick={() => onSelectMilestone?.(milestone.id)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[13px]",
              "hover:bg-zinc-100 dark:hover:bg-zinc-800",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive && "bg-zinc-100 dark:bg-zinc-800",
            )}
          >
            <ChevronRight
              className="h-4 w-4 shrink-0 text-zinc-400"
              aria-hidden="true"
            />
            {isCompleted && (
              <CheckCircle
                className="h-4 w-4 shrink-0 text-emerald-500"
                aria-label="Completed"
                data-testid={`milestone-rail-item-${milestone.id}-completed`}
              />
            )}
            <span className="truncate flex-1 text-left">
              {milestone.title}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export default MilestoneRail;
