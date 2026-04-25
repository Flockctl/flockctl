import {
  useProjectSchedules,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
} from "@/lib/hooks";
import type { Schedule } from "@/lib/types";
import { ScheduleStatus, ScheduleType } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { CreateScheduleDialog } from "@/pages/schedules";

// --- Scheduled Tasks Section ---

function ScheduleStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    [ScheduleStatus.active]:
      "bg-green-500/15 text-green-700 dark:text-green-400",
    [ScheduleStatus.paused]:
      "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  };
  const className = variants[status];
  if (className) {
    return <Badge className={className}>{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function formatScheduleTime(iso: string | null): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString();
}

export function ProjectSchedulesSection({ projectId }: { projectId: string }) {
  const { data, isLoading } = useProjectSchedules(projectId, 0, 50, {
    refetchInterval: 10_000,
  });
  const pauseSchedule = usePauseSchedule();
  const resumeSchedule = useResumeSchedule();
  const deleteSchedule = useDeleteSchedule();
  const deleteConfirm = useConfirmDialog();

  const schedules: Schedule[] = data?.items ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Scheduled Tasks</h2>
        <CreateScheduleDialog projectId={projectId} buttonSize="sm" />
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {!isLoading && schedules.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No scheduled tasks for this project.
        </p>
      )}

      {!isLoading && schedules.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next Fire</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((sched) => (
              <TableRow key={sched.id}>
                <TableCell className="font-medium">
                  {sched.template_name}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{sched.schedule_type}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {sched.schedule_type === ScheduleType.cron
                    ? sched.cron_expression ?? "\u2014"
                    : formatScheduleTime(sched.run_at)}
                </TableCell>
                <TableCell>
                  <ScheduleStatusBadge status={sched.status} />
                </TableCell>
                <TableCell className="text-xs">
                  {formatScheduleTime(sched.next_fire_time)}
                </TableCell>
                <TableCell>
                  <div
                    className="flex gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sched.status === ScheduleStatus.active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={pauseSchedule.isPending}
                        onClick={() => pauseSchedule.mutate(sched.id)}
                      >
                        Pause
                      </Button>
                    )}
                    {sched.status === ScheduleStatus.paused && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={resumeSchedule.isPending}
                        onClick={() => resumeSchedule.mutate(sched.id)}
                      >
                        Resume
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={deleteSchedule.isPending}
                      onClick={() => deleteConfirm.requestConfirm(sched.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Schedule"
        description="This will permanently delete this schedule. This action cannot be undone."
        isPending={deleteSchedule.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            deleteSchedule.mutate(deleteConfirm.targetId, {
              onSuccess: () => deleteConfirm.reset(),
            });
          }
        }}
      />
    </div>
  );
}
