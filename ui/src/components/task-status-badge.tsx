import { Badge } from "@/components/ui/badge";
import { TaskStatus } from "@/lib/types";
import type { Task } from "@/lib/types";

/**
 * Colored status badge for tasks. Used by the tasks list, the task detail
 * rerun-chain card, and anywhere else a task status needs to be shown with
 * the same semantic color (green = done, red = failed, orange = timed out,
 * blue = running). Keep this component as the single source of truth for
 * status colors — duplicating the color map elsewhere leads to drift.
 */
export function TaskStatusBadge({ status }: { status: Task["status"] }) {
  const variants: Record<string, string> = {
    [TaskStatus.running]: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    [TaskStatus.done]: "bg-green-500/15 text-green-700 dark:text-green-400",
    [TaskStatus.failed]: "bg-red-500/15 text-red-700 dark:text-red-400",
    [TaskStatus.timed_out]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="secondary">{status}</Badge>;
}
