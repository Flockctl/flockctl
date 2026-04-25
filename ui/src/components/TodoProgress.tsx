import { Progress } from "@/components/ui/progress";

/**
 * Counts shape mirrors the server's `TodoCounts` (see src/services/todo-store.ts).
 * Field names are snake_case because apiFetch normalizes server responses that
 * way and the WS envelope uses the same casing.
 */
export interface TodoProgressCounts {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
}

interface TodoProgressProps {
  counts: TodoProgressCounts;
  /** Optional className appended to the wrapper for layout tuning per caller. */
  className?: string;
}

/**
 * Compact progress indicator for agent-side TodoWrite snapshots.
 *
 * Renders a shadcn Progress bar plus a short "N / M done" label. Uses the
 * underlying Radix Progress primitive, so aria-valuenow / aria-valuemax are
 * wired automatically when `value` + `max` are passed — screen readers see the
 * same numeric snapshot the label shows.
 */
export function TodoProgress({ counts, className }: TodoProgressProps) {
  const total = Math.max(0, counts.total);
  const completed = Math.min(Math.max(0, counts.completed), total);
  // Guard against divide-by-zero when called with total === 0 (callers should
  // gate on counts.total > 0, but the primitive must not NaN regardless).
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div
      data-testid="todo-progress"
      className={
        "flex items-center gap-3 text-xs text-muted-foreground" +
        (className ? " " + className : "")
      }
    >
      <Progress
        value={percent}
        max={100}
        aria-label="Agent task progress"
        aria-valuenow={completed}
        aria-valuemax={total}
        aria-valuemin={0}
        className="flex-1"
      />
      <span className="tabular-nums whitespace-nowrap">
        {completed} / {total} done
        {counts.in_progress > 0 && (
          <span className="ml-1 text-muted-foreground/70">
            · {counts.in_progress} in progress
          </span>
        )}
      </span>
    </div>
  );
}
