import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { TaskStatus } from "@/lib/types";
import type { Task } from "@/lib/types";

/**
 * Colored status badge for tasks. Used by the tasks list, the task detail
 * rerun-chain card, and anywhere else a task status needs to be shown with
 * the same semantic color (green = done, red = failed, orange = timed out,
 * blue = running, amber = paused for rate limit). Keep this component as
 * the single source of truth for status colors — duplicating the color map
 * elsewhere leads to drift.
 *
 * `resume_at`: when status is `rate_limited`, the badge renders a live
 * countdown ("⏸ resumes in 14m 22s"). The interval re-renders once per
 * second and is cleaned up on unmount. We intentionally don't memoize
 * heavily — a 1Hz tick on a single component is far cheaper than the
 * useEffect plumbing it would take to share a clock across rows.
 */
export function TaskStatusBadge({
  status,
  resumeAt,
}: {
  status: Task["status"];
  resumeAt?: number | null;
}) {
  if (status === TaskStatus.rate_limited) {
    return <RateLimitedBadge resumeAt={resumeAt ?? null} />;
  }

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

function RateLimitedBadge({ resumeAt }: { resumeAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const label = resumeAt ? formatCountdown(Math.max(0, resumeAt - now)) : null;
  return (
    <Badge
      className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
      title={
        resumeAt
          ? `Rate-limited; will resume at ${new Date(resumeAt).toLocaleTimeString()}`
          : "Rate-limited"
      }
    >
      ⏸ {label ? `resumes in ${label}` : "rate-limited"}
    </Badge>
  );
}

/** Render a millisecond delta as the most useful coarse unit. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "moments";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
