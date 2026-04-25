import { Badge } from "@/components/ui/badge";
import type { TodoProgressCounts } from "@/components/TodoProgress";

interface TodoBadgeProps {
  /** Latest TodoWrite snapshot counts, shaped by the server's `TodoCounts`.
   *  When `null`/`undefined` (chat never emitted a TodoWrite call) the badge
   *  renders nothing — callers don't need their own guard. */
  counts: TodoProgressCounts | null | undefined;
  /** Optional extra classes for layout tuning per caller. */
  className?: string;
}

/**
 * Compact `N/M` todo badge for chat list rows.
 *
 * Shows `completed/total` as a small neutral (secondary) shadcn Badge next to
 * a chat title. Pure derivation — reads the `todos_counts` already present in
 * the chat-list payload (`GET /chats` metrics), no extra request per row.
 *
 * Hidden when there are no todos (counts is null or counts.total === 0). The
 * `completed` value is clamped to `[0, total]` defensively so a malformed
 * snapshot can never render `9/3`.
 */
export function TodoBadge({ counts, className }: TodoBadgeProps) {
  if (!counts || counts.total <= 0) return null;

  const total = Math.max(0, counts.total);
  const completed = Math.min(Math.max(0, counts.completed), total);

  return (
    <Badge
      variant="secondary"
      data-testid="todo-badge"
      className={
        "h-4 px-1.5 text-[10px] tabular-nums font-medium" +
        (className ? " " + className : "")
      }
      aria-label={`${completed} of ${total} todos done`}
      title={`${completed} of ${total} todos done`}
    >
      {completed}/{total}
    </Badge>
  );
}
