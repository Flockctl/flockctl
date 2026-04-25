import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { statusBadge } from "@/components/status-badge";
import type { PlanSliceTree, SliceStatus } from "@/lib/types/plan";

// --- Slice Card (board view) ---
//
// NEW visual for the mission-control board layout. This is NOT a refactor of
// `SliceRow` — the tree view keeps rendering `SliceRow`; this card is the
// fresh, board-friendly visual that the board view reaches for when it wants
// to show a slice as a standalone tile.
//
// Visual anatomy (top → bottom):
//
//   ┌─┬──────────────────────────────────────────┐
//   │ │ <milestone breadcrumb>  [priority chip]  │
//   │ │ <slice title, 2-line clamp>              │
//   │ │ [status badge]                N/M tasks  │
//   │ │ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░ progress bar      │
//   └─┴──────────────────────────────────────────┘
//     ↑
//     3px left border, colored by status
//
// Colors for the left border mirror the visual-bucket mapping used by
// `status-badge.tsx`: pending/planning → muted, active → primary, verifying/
// merging → amber, completed → green, failed → destructive, skipped/cancelled
// → muted. Keeping this mapping local to the card (rather than importing
// from `statusBadge`) is intentional: the badge renders a pill with
// foreground text; the border needs a background-tinted color class.
//
// Progress: `done / total`, where "done" is the number of tasks whose status
// is `completed`. The percentage is clamped to `[0, 100]` so that a slice
// containing 50 tasks all of which are `completed` still renders as 100%,
// and an empty slice renders as 0%. This is covered by the
// `slice_card_0_task_and_50_task_progress_bar_corner_cases` test.
//
// Priority chip: the `priority` prop accepts `"high" | "medium" | "low"`.
// The chip is omitted when no priority is supplied so the card stays
// uncluttered for data shapes that don't carry priority yet (the `PlanSlice`
// type on the daemon side does not have a `priority` field today — this
// prop is a UI-side affordance for the board that the data layer will fill
// in later).

/** Priority levels rendered as a coloured chip. */
export type SlicePriority = "high" | "medium" | "low";

export interface SliceCardProps {
  /** Slice to render. `slice.tasks` drives the progress bar + counter. */
  slice: PlanSliceTree;
  /** Human-readable milestone title, shown as a muted breadcrumb above the slice title. */
  milestoneTitle: string;
  /** Optional priority — renders a coloured chip when present. */
  priority?: SlicePriority;
  /** When true, the card gets a focus ring to show it is the active selection. */
  selected?: boolean;
  /** Called with the slice id when the user clicks the card. */
  onSelect: (sliceId: string) => void;
  /** Optional extra classes merged onto the card root. */
  className?: string;
}

/**
 * Map a slice status to the Tailwind class used for the 3px left border.
 *
 * Keep this in lockstep with the visual-bucket grouping in `statusBadge()`
 * — anything that renders green in the badge should render green here.
 */
function statusBorderColor(status: SliceStatus): string {
  switch (status) {
    case "active":
      return "border-l-primary";
    case "verifying":
    case "merging":
      return "border-l-amber-500";
    case "completed":
      return "border-l-green-500";
    case "failed":
      return "border-l-destructive";
    case "skipped":
    case "pending":
    case "planning":
    default:
      return "border-l-muted-foreground/40";
  }
}

/**
 * Priority → chip variant + className. The three baselines are intentionally
 * distinct so the `high/medium/low priority visual baselines` corner-case
 * test can assert they render different DOM.
 */
function priorityChip(priority: SlicePriority) {
  switch (priority) {
    case "high":
      return (
        <Badge
          data-priority="high"
          variant="destructive"
          className="text-[10px]"
        >
          high
        </Badge>
      );
    case "medium":
      return (
        <Badge
          data-priority="medium"
          variant="secondary"
          className="text-[10px] border-amber-500/50 text-amber-600 dark:text-amber-400"
        >
          medium
        </Badge>
      );
    case "low":
    default:
      return (
        <Badge
          data-priority="low"
          variant="outline"
          className="text-[10px] text-muted-foreground"
        >
          low
        </Badge>
      );
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
  // Clamp to [0, 100] so an empty slice is 0%, and a fully-completed slice
  // with any number of tasks is exactly 100%.
  const pct = total === 0 ? 0 : Math.min(100, Math.max(0, (done / total) * 100));

  return (
    <Card
      size="sm"
      data-testid="slice-card"
      data-slice-id={slice.id}
      data-selected={selected ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(slice.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(slice.id);
        }
      }}
      className={cn(
        "cursor-pointer border-l-[3px] transition-colors hover:bg-muted/30",
        statusBorderColor(slice.status),
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        className,
      )}
    >
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span
            className="text-sm text-muted-foreground truncate"
            data-testid="slice-card-breadcrumb"
            title={milestoneTitle}
          >
            {milestoneTitle}
          </span>
          {priority && priorityChip(priority)}
        </div>

        <h3
          className="font-heading text-base font-medium leading-snug line-clamp-2"
          data-testid="slice-card-title"
          title={slice.title}
        >
          {slice.title}
        </h3>

        <div className="flex items-center justify-between gap-2">
          {statusBadge(slice.status)}
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="slice-card-task-count"
          >
            {done}/{total}
          </span>
        </div>

        <Progress
          value={pct}
          data-testid="slice-card-progress"
          aria-label={`Progress: ${done} of ${total} tasks completed`}
        />
      </CardContent>
    </Card>
  );
}

export default SliceCard;
