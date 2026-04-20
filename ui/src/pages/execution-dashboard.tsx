import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useExecutionGraph,
  useAutoExecStatus,
  useStartAutoExecute,
  useStopAutoExecute,
  useProjectTree,
} from "@/lib/hooks";
import type {
  ExecutionWave,
  PlanSlice,
} from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import ExecutionFlowGraph from "@/components/flow/ExecutionFlowGraph";

// --- Status badge helper (mirrors project-detail.tsx) ---

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "planning":
      return <Badge variant="secondary">planning</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "verifying":
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">verifying</Badge>;
    case "merging":
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">merging</Badge>;
    case "completed":
      return <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">completed</Badge>;
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
      return <Badge variant="outline">skipped</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

// --- Dashboard Header ---

function DashboardHeader({
  milestoneTitle,
  completedSlices,
  totalSlices,
  isAutoExecActive,
  projectId,
  milestoneId,
}: {
  milestoneTitle: string;
  completedSlices: number;
  totalSlices: number;
  isAutoExecActive: boolean;
  projectId: string;
  milestoneId: string;
}) {
  const startAutoExec = useStartAutoExecute(projectId);
  const stopAutoExec = useStopAutoExecute(projectId);
  const pct = totalSlices > 0 ? Math.round((completedSlices / totalSlices) * 100) : 0;

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-2 flex-1 mr-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{milestoneTitle}</h1>
          <Badge variant="outline">
            {completedSlices}/{totalSlices} slices
          </Badge>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-muted rounded-full h-2.5 max-w-md">
          <div
            className="bg-green-500 h-2.5 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isAutoExecActive ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={stopAutoExec.isPending}
            onClick={() => stopAutoExec.mutate(milestoneId)}
          >
            {stopAutoExec.isPending ? "Stopping..." : "Stop Auto-Exec"}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={startAutoExec.isPending}
            onClick={() => startAutoExec.mutate({ milestoneId })}
          >
            {startAutoExec.isPending ? "Starting..." : "Start Auto-Exec"}
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Active Slices Panel ---

function ActiveSlicesPanel({ waves, currentSliceIds }: { waves: ExecutionWave[]; currentSliceIds: string[] }) {
  const currentSet = useMemo(() => new Set(currentSliceIds), [currentSliceIds]);
  const activeSlices = useMemo(() => {
    const result: PlanSlice[] = [];
    for (const wave of waves) {
      for (const slice of wave.slices ?? []) {
        if (currentSet.has(slice.id) || slice.status === "active") {
          result.push(slice);
        }
      }
    }
    return result;
  }, [waves, currentSet]);

  if (activeSlices.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Active Slices</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No slices currently running.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Active Slices ({activeSlices.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {activeSlices.map((slice) => (
          <div key={slice.id} className="flex items-center justify-between py-1">
            <span className="text-sm font-medium">{slice.title}</span>
            <div className="flex items-center gap-2">
              {statusBadge(slice.status)}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// --- Errors Panel ---

function ErrorsPanel({ errors }: { errors: string[] | undefined | null }) {
  if (!errors || errors.length === 0) return null;

  return (
    <Card className="border-destructive">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-destructive">
          Errors ({errors.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {errors.map((err, idx) => (
          <p key={idx} className="text-sm text-destructive">
            {err}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

// --- Main Page ---

export default function ExecutionDashboardPage() {
  const { projectId, milestoneId } = useParams<{
    projectId: string;
    milestoneId: string;
  }>();
  const navigate = useNavigate();

  const [isAutoExecActive, setIsAutoExecActive] = useState(false);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null);

  // Adaptive polling: 5s when active, 30s otherwise
  const pollInterval = isAutoExecActive ? 5_000 : 30_000;

  const { data: execStatus } = useAutoExecStatus(
    projectId ?? "",
    milestoneId ?? "",
    { refetchInterval: pollInterval },
  );

  // Sync auto-exec active state
  const currentlyActive = execStatus?.status === "active";
  if (currentlyActive !== isAutoExecActive) {
    setIsAutoExecActive(currentlyActive);
  }

  const {
    data: graphData,
    isLoading: graphLoading,
    error: graphError,
  } = useExecutionGraph(projectId ?? "", milestoneId ?? "", {
    refetchInterval: pollInterval,
  });

  const { data: tree } = useProjectTree(projectId ?? "", {
    refetchInterval: pollInterval,
  });

  // Find milestone title from tree
  const milestone = tree?.milestones?.find((m) => m.id === milestoneId);
  const milestoneTitle = milestone?.title ?? "Execution Dashboard";
  const completedSlices = execStatus?.completed_slices ?? 0;
  const totalSlices = execStatus?.total_slices ?? 0;
  const currentSliceIds = execStatus?.current_slice_ids ?? [];

  if (!projectId || !milestoneId) {
    return <p className="text-destructive">Missing project or milestone ID.</p>;
  }

  if (graphLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-64 w-full" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  if (graphError) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => navigate(`/projects/${projectId}`)}
        >
          &larr; Back to Project
        </Button>
        <p className="text-destructive">
          Failed to load execution graph: {graphError.message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => navigate(`/projects/${projectId}`)}
      >
        &larr; Back to Project
      </Button>

      {/* Header with progress and auto-exec controls */}
      <DashboardHeader
        milestoneTitle={milestoneTitle}
        completedSlices={completedSlices}
        totalSlices={totalSlices}
        isAutoExecActive={isAutoExecActive}
        projectId={projectId}
        milestoneId={milestoneId}
      />

      <Separator />

      {/* Errors Panel */}
      {graphData && <ErrorsPanel errors={graphData.errors ?? []} />}

      {/* Interactive Flow Graph */}
      {graphData ? (
        <ExecutionFlowGraph
          waves={graphData.waves}
          criticalPath={graphData.critical_path}
          currentSliceIds={currentSliceIds}
          tree={tree}
          milestoneId={milestoneId}
          parallelismFactor={graphData.parallelism_factor}
          selectedSliceId={selectedSliceId}
          onSliceSelect={setSelectedSliceId}
          sliceWorkers={graphData.slice_workers ?? {}}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No graph data available.</p>
      )}

      {/* Bottom panels */}
      {graphData && (
        <ActiveSlicesPanel
          waves={graphData.waves}
          currentSliceIds={currentSliceIds}
        />
      )}
    </div>
  );
}
