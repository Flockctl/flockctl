import { XIcon, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import type { PlanSliceTree } from "@/lib/types";

function taskStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
          completed
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function sliceStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "planning":
      return <Badge variant="secondary">planning</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "verifying":
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
          verifying
        </Badge>
      );
    case "merging":
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
          merging
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
          completed
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
      return <Badge variant="outline">skipped</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

interface SliceDetailPanelProps {
  slice: PlanSliceTree | null;
  onClose: () => void;
  sliceWorkers: string[];
}

export default function SliceDetailPanel({
  slice,
  onClose,
  sliceWorkers,
}: SliceDetailPanelProps) {
  if (!slice) return null;

  const sortedTasks = [...slice.tasks].sort(
    (a, b) => a.order_index - b.order_index,
  );

  return (
    <Card className="w-[320px] shrink-0 overflow-y-auto max-h-[500px]">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold leading-snug">
            {slice.title}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={onClose}
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {sliceStatusBadge(slice.status)}
          {slice.risk && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              {slice.risk}
            </Badge>
          )}
        </div>
        {slice.description && (
          <p className="text-xs text-muted-foreground mt-1">
            {slice.description}
          </p>
        )}
        {sliceWorkers.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-1">
            Workers: {sliceWorkers.join(", ")}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Tasks ({sortedTasks.length})
        </p>
        {sortedTasks.map((task) => (
          <div
            key={task.id}
            className="flex items-start justify-between gap-2 py-1.5 border-b last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate" title={task.title}>
                {task.title}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {taskStatusBadge(task.status)}
                {task.verification_passed !== null && (
                  task.verification_passed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-500" />
                  )
                )}
              </div>
            </div>
          </div>
        ))}
        {sortedTasks.length === 0 && (
          <p className="text-xs text-muted-foreground">No tasks.</p>
        )}
      </CardContent>
    </Card>
  );
}
