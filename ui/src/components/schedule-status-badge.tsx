import { Badge } from "@/components/ui/badge";
import { ScheduleStatus } from "@/lib/types";

/**
 * Schedule status pill — single source of truth used by the standalone
 * `/schedules` page and the project-detail "Scheduled Tasks" section.
 *
 * Replaces two near-identical local copies (`pages/schedules.tsx` and
 * `pages/project-detail-components/ProjectSchedulesSection.tsx`) that
 * differed only in whether the dark-mode variant explicitly set
 * `dark:bg-...` (the project section omitted it). Keeping the explicit
 * dark-bg classes from the schedules page so the dark-mode rendering
 * stays consistent everywhere.
 */
export function ScheduleStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    [ScheduleStatus.active]:
      "bg-green-500/15 text-green-700 dark:text-green-400 dark:bg-green-500/20",
    [ScheduleStatus.paused]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400 dark:bg-orange-500/20",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}
