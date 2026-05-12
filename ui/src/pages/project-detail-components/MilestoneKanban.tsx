import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { FlatCard } from "@/components/design/FlatCard";
import { SliceCard, type SlicePriority } from "./SliceCard";
import type { PlanSliceTree, SliceStatus } from "@/lib/types/plan";

/**
 * MilestoneKanban — 3-column kanban for the redesigned project-detail
 * Plan tab (slice 23-00 T03).
 *
 * Layout
 * ------
 * Three flex columns, each rendered as a `<FlatCard>` with:
 *   - sticky header: column label (uppercase text-[11px] zinc-500) + count
 *     chip showing the number of slices currently in the column.
 *   - scrollable body: vertical stack of `<SliceCard>` instances; the
 *     body is `overflow-y-auto` so a milestone with 50+ slices scrolls
 *     within the column without inflating the page height.
 *   - empty placeholder: "No slices" text-zinc-500 / 12px / centered
 *     when the column is empty (matches the prototype).
 *
 * Slice → column mapping (per slice.md T03 / audit findings)
 * ----------------------------------------------------------
 * The task description's enum (`pending | in_progress | completed |
 * blocked | abandoned`) does not match the daemon's actual
 * {@link SliceStatus} enum (`pending | planning | active | verifying |
 * merging | completed | skipped | failed`). The audit findings in
 * slice.md ## Audit findings §5 reconcile the two with this mapping:
 *
 *   | Status      | Column    | Notes                                |
 *   | ----------- | --------- | ------------------------------------ |
 *   | pending     | Pending   | unstarted                            |
 *   | planning    | Pending   | plan generation in flight            |
 *   | failed      | Pending   | "blocked" → Pending + Lock icon      |
 *   | active      | Active    | currently executing                  |
 *   | verifying   | Active    | tasks done, verification running     |
 *   | merging     | Active    | auto-executor merge step             |
 *   | completed   | Completed | terminal success                     |
 *   | skipped     | (hidden)  | "abandoned" → not shown              |
 *
 * The Lock icon renders before the slice title for any slice that lands
 * in Pending because of a `failed` status. We pass it through to
 * `<SliceCard>` via the `leadingIcon` prop... except `<SliceCard>` does
 * not currently accept a leading icon. To avoid retrofitting `<SliceCard>`
 * (which already ships in the same task and has its own contract test),
 * we render the Lock icon as a sibling element inside the column body
 * — in front of the SliceCard, with `data-testid="milestone-kanban-blocked-lock"`
 * so the test can still pin the icon. This keeps each component's
 * contract narrow.
 *
 * Forward-compat
 * --------------
 * Any unknown / future slice status falls into the Pending column and
 * emits a `console.warn` in development so the user-visible kanban
 * never silently drops a slice. The `failure_modes.dep_fails` rule on
 * 03-milestone-kanban.md mandates this.
 *
 * Test-id surface
 * ---------------
 *   - `milestone-kanban`                        root grid
 *   - `milestone-kanban-column`                 every column FlatCard
 *   - `milestone-kanban-column-pending`         pending column (also
 *                                               `-active`, `-completed`)
 *   - `milestone-kanban-column-count-<id>`      per-column count chip
 *   - `milestone-kanban-column-empty-<id>`      empty placeholder
 *   - `milestone-kanban-column-body-<id>`       scrollable body
 *   - `milestone-kanban-blocked-lock-<sliceId>` Lock icon next to a
 *                                               failed/blocked slice
 */

/** A column in the 3-column kanban. */
type ColumnId = "pending" | "active" | "completed";

interface ColumnDef {
  id: ColumnId;
  label: string;
}

const COLUMNS: ColumnDef[] = [
  { id: "pending", label: "Pending" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
];

/**
 * Map a {@link SliceStatus} value to a kanban column id, or `null` if the
 * slice should be hidden entirely (`skipped` → "abandoned" per the spec).
 */
function statusToColumn(status: SliceStatus | string): ColumnId | null {
  switch (status) {
    case "pending":
    case "planning":
    case "failed": // "blocked" — surfaces in Pending with a Lock icon
      return "pending";
    case "active":
    case "verifying":
    case "merging":
      return "active";
    case "completed":
      return "completed";
    case "skipped":
      // "abandoned" — filtered out of the kanban entirely.
      return null;
    default:
      // Forward-compat: an unknown status is loud (warn) but still visible.
      if (
        process.env.NODE_ENV !== "production" &&
        typeof status === "string"
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[MilestoneKanban] unknown slice status "${status}" — falling back to Pending.`,
        );
      }
      return "pending";
  }
}

/** A slice rendered in the "Pending" column because it is failed/blocked. */
function isBlocked(status: SliceStatus | string): boolean {
  return status === "failed";
}

export interface MilestoneKanbanProps {
  /**
   * Title of the milestone whose slices are shown — passed through to
   * each `<SliceCard>` as the breadcrumb.
   */
  milestoneTitle: string;
  /** Slices to distribute across the columns, in caller-sorted order. */
  slices: PlanSliceTree[];
  /** Currently-selected slice id (the SliceCard renders a focus ring). */
  activeSliceId?: string | null;
  /** Click handler — receives the slice id (slug). */
  onSelectSlice?: (sliceId: string) => void;
  /** Optional priority lookup per slice id (drives the priority chip). */
  prioritiesBySliceId?: Record<string, SlicePriority>;
  /** Optional extra classes merged onto the outer container. */
  className?: string;
}

/**
 * Group slices into the three kanban columns in caller order. Slices that
 * map to `null` (i.e. `skipped`) are dropped here so neither the count
 * chips nor the body iterate over them.
 */
function groupByColumn(
  slices: PlanSliceTree[],
): Record<ColumnId, PlanSliceTree[]> {
  const buckets: Record<ColumnId, PlanSliceTree[]> = {
    pending: [],
    active: [],
    completed: [],
  };
  for (const slice of slices) {
    const col = statusToColumn(slice.status);
    if (col === null) continue;
    buckets[col].push(slice);
  }
  return buckets;
}

export function MilestoneKanban({
  milestoneTitle,
  slices,
  activeSliceId,
  onSelectSlice,
  prioritiesBySliceId,
  className,
}: MilestoneKanbanProps) {
  const grouped = groupByColumn(slices);

  return (
    <div
      data-testid="milestone-kanban"
      className={cn("grid grid-cols-1 md:grid-cols-3 gap-4", className)}
    >
      {COLUMNS.map((col) => {
        const items = grouped[col.id];
        return (
          <FlatCard
            key={col.id}
            className="flex flex-col min-h-[240px] max-h-[640px]"
          >
            <div
              data-testid="milestone-kanban-column"
              data-column-id={col.id}
              data-column={col.id}
              className="flex flex-col h-full"
            >
              {/* Sticky header */}
              <header
                data-testid={`milestone-kanban-column-${col.id}`}
                className={cn(
                  "sticky top-0 z-10 bg-card",
                  "flex items-center justify-between gap-2",
                  "px-3 py-2 border-b divider-y",
                  "rounded-t-xl",
                )}
              >
                <span
                  className="text-[11px] uppercase tracking-wider font-semibold text-zinc-500"
                  data-testid={`milestone-kanban-column-label-${col.id}`}
                >
                  {col.label}
                </span>
                <span
                  data-testid={`milestone-kanban-column-count-${col.id}`}
                  className={cn(
                    "inline-flex items-center justify-center",
                    "rounded-full px-2 py-0.5",
                    "text-[11px] tabular-nums font-semibold",
                    "bg-zinc-100 text-zinc-600",
                    "dark:bg-zinc-800 dark:text-zinc-400",
                  )}
                >
                  {items.length}
                </span>
              </header>

              {/* Scrollable body */}
              <div
                data-testid={`milestone-kanban-column-body-${col.id}`}
                className="flex-1 overflow-y-auto p-3 flex flex-col gap-2"
              >
                {items.length === 0 ? (
                  <div
                    data-testid={`milestone-kanban-column-empty-${col.id}`}
                    className="text-zinc-500 text-[12px] grid place-items-center min-h-[120px]"
                  >
                    No slices
                  </div>
                ) : (
                  items.map((slice) => {
                    const blocked = isBlocked(slice.status);
                    return (
                      <div
                        key={slice.id}
                        data-testid="milestone-kanban-slice-wrapper"
                        data-slice-id={slice.id}
                        data-blocked={blocked ? "true" : undefined}
                        className="flex items-start gap-1.5"
                      >
                        {blocked && (
                          <Lock
                            data-testid={`milestone-kanban-blocked-lock-${slice.id}`}
                            aria-label="Blocked"
                            className="h-3.5 w-3.5 mt-2 shrink-0 text-amber-600 dark:text-amber-400"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <SliceCard
                            slice={slice}
                            milestoneTitle={milestoneTitle}
                            priority={prioritiesBySliceId?.[slice.id]}
                            selected={slice.id === activeSliceId}
                            onSelect={(id) => onSelectSlice?.(id)}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </FlatCard>
        );
      })}
    </div>
  );
}

export default MilestoneKanban;
