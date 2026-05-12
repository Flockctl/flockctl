import { cn } from "@/lib/utils";
import { FlatCard } from "@/components/design/FlatCard";
import { StatusPill, type StatusPillTone } from "@/components/design/StatusPill";
import type { PlanSliceTree, SliceStatus } from "@/lib/types/plan";
import { clampPercent } from "@/lib/format";

// --- Slice Card (board view, design-system flavour) ---
//
// Visual anatomy (top → bottom):
//
//   ┌─────────────────────────────────────────────────────┐
//   │ <milestone prefix>             zinc-500 / 11px      │
//   │ <slice title>                  font-medium / 13.5px │
//   │ [StatusPill]            done/total · zinc-500 11px  │
//   │ ▓▓▓▓▓▓▓░░░░░░░░░░░ 1.5px gradient progress bar      │
//   └─────────────────────────────────────────────────────┘
//
// The card is a `<FlatCard interactive onClick>` so it inherits the
// hard-flat hover lift, focus-ring, and Enter/Space activation from the
// design-system primitive. We deliberately do NOT re-implement keyboard
// behaviour here — FlatCard owns it.
//
// Status → tone mapping (per design spec):
//   - completed                    → success
//   - active / verifying / merging → info        ("in progress")
//   - failed                       → warning     ("blocked")
//   - pending / planning / skipped → neutral
//
// Progress bar is a hand-rolled 1.5px track:
//   `h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden`
// with a `bg-gradient-to-r from-indigo-500 to-purple-500` fill whose
// width is the clamped `done / total` percentage. We avoid the shadcn
// `<Progress>` component on purpose — the new tokens-preview surface
// uses the gradient track everywhere and the abstraction in `<Progress>`
// would just be one more layer to override.

/** Priority levels rendered as a coloured chip. */
export type SlicePriority = "high" | "medium" | "low";

export interface SliceCardProps {
  /** Slice to render. `slice.tasks` drives the progress bar + counter. */
  slice: PlanSliceTree;
  /** Human-readable milestone title, shown as a muted prefix above the slice title. */
  milestoneTitle: string;
  /** Optional priority — renders a coloured pill when present. */
  priority?: SlicePriority;
  /** When true, the card gets a focus ring to show it is the active selection. */
  selected?: boolean;
  /** Called with the slice id (used as the slug) when the card is activated. */
  onSelect: (slug: string) => void;
  /** Optional extra classes merged onto the card root. */
  className?: string;
}

/** Map a slice status to a `StatusPill` tone (per design spec). */
function statusToTone(status: SliceStatus): StatusPillTone {
  switch (status) {
    case "completed":
      return "success";
    case "active":
    case "verifying":
    case "merging":
      return "info";
    case "failed":
      return "warning";
    case "pending":
    case "planning":
    case "skipped":
    default:
      return "neutral";
  }
}

/**
 * Map a slice status to the human-readable label rendered inside the
 * StatusPill. We collapse the daemon's 8 statuses into the 4 visual buckets
 * the design spec calls out (`pending`, `in progress`, `completed`, `blocked`)
 * so the card surface stays scannable; the full status remains available
 * via `data-status` for tooling that needs the raw value.
 */
function statusLabel(status: SliceStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "active":
    case "verifying":
    case "merging":
      return "in progress";
    case "failed":
      return "blocked";
    case "pending":
    case "planning":
      return "pending";
    case "skipped":
      return "skipped";
    default:
      return status;
  }
}

/** Tone for the priority pill — uses the same StatusPill primitive. */
function priorityTone(priority: SlicePriority): StatusPillTone {
  switch (priority) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
    default:
      return "neutral";
  }
}

export function SliceCard({
  slice,
  milestoneTitle,
  priority,
  selected = false,
  onSelect,
  className,
}: SliceCardProps) {
  const tasks = slice.tasks ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  // Clamp to [0, 100] so an empty slice is 0% and a fully-completed slice
  // with any number of tasks is exactly 100%.
  const pct = clampPercent(done, total);

  return (
    <FlatCard
      interactive
      onClick={() => onSelect(slice.id)}
      className={cn(
        "px-3 py-2.5",
        selected &&
          "ring-2 ring-indigo-500/60 ring-offset-2 ring-offset-background",
        className,
      )}
    >
      <div
        data-testid="slice-card"
        data-slice-id={slice.id}
        data-status={slice.status}
        data-selected={selected ? "true" : "false"}
        className="flex flex-col gap-1.5"
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className="text-[11px] text-zinc-500 truncate"
            data-testid="slice-card-breadcrumb"
            title={milestoneTitle}
          >
            {milestoneTitle}
          </span>
          {priority && (
            <StatusPill
              size="sm"
              tone={priorityTone(priority)}
              data-priority={priority}
              data-testid="slice-card-priority"
            >
              {priority}
            </StatusPill>
          )}
        </div>

        <h3
          className="text-[13.5px] font-medium leading-snug line-clamp-2"
          data-testid="slice-card-title"
          title={slice.title}
        >
          {slice.title}
        </h3>

        <div className="flex items-center justify-between gap-2">
          <StatusPill
            size="sm"
            tone={statusToTone(slice.status)}
            data-testid="slice-card-status"
          >
            {statusLabel(slice.status)}
          </StatusPill>
          <span
            className="text-[11px] tabular-nums text-zinc-500"
            data-testid="slice-card-task-count"
          >
            {done}/{total}
          </span>
        </div>

        <div
          className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progress: ${done} of ${total} tasks completed`}
          data-testid="slice-card-progress"
        >
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-[width]"
            style={{ width: `${pct}%` }}
            data-testid="slice-card-progress-fill"
          />
        </div>
      </div>
    </FlatCard>
  );
}

export default SliceCard;
