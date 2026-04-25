import { Link } from "react-router-dom";
import { useScheduleTasks } from "@/lib/hooks";
import { statusBadge } from "@/components/status-badge";
import { formatTimestamp as formatTime } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Inline "latest tasks" expansion row rendered under each schedule row on the
 * /schedules page. Extracted so the main table component only has to wire
 * expand-state — the fetch + rendering of the child task list lives here,
 * where it's scoped to one schedule id.
 */
export function ScheduleTasksRow({
  scheduleId,
  colSpan,
}: {
  scheduleId: string;
  colSpan: number;
}) {
  const { data, isLoading, error } = useScheduleTasks(scheduleId, 0, 20, {
    refetchInterval: 10_000,
  });

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={colSpan} className="p-4">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading tasks…</p>
        )}
        {error && (
          <p className="text-xs text-destructive">
            Failed to load tasks: {error.message}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No tasks have been created by this schedule yet.
          </p>
        )}
        {data && data.items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {data.total} task{data.total !== 1 ? "s" : ""} created by this schedule
              {data.total > data.items.length && ` (showing latest ${data.items.length})`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="w-[140px]">Status</TableHead>
                  <TableHead className="w-[180px]">Created</TableHead>
                  <TableHead className="w-[180px]">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="underline hover:text-foreground"
                      >
                        {String(task.id).slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate">
                      {task.prompt ?? "\u2014"}
                    </TableCell>
                    <TableCell>{statusBadge(task.status)}</TableCell>
                    <TableCell className="text-xs">
                      {formatTime(task.created_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatTime(task.completed_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
