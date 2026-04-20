import { useMemo, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { statusBadge } from "@/components/status-badge";
import { ChevronDown, ChevronRight, Layers, GitBranch, CheckCircle, XCircle, Clock, Zap } from "lucide-react";
import type {
  OverviewMilestone,
  OverviewWave,
  OverviewSlice,
  OverviewTask,
} from "@/lib/types";

// --- Risk badge ---

function riskBadge(risk: string) {
  switch (risk) {
    case "high":
      return <Badge variant="destructive" className="text-[10px] px-1.5 py-0">high</Badge>;
    case "medium":
      return <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500 text-amber-600 dark:text-amber-400">med</Badge>;
    case "low":
      return <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500 text-green-600 dark:text-green-400">low</Badge>;
    default:
      return null;
  }
}

// --- Task status icon ---

function taskStatusIcon(status: string, verified: boolean | null) {
  if (status === "completed") {
    return verified === false
      ? <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
      : <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  }
  if (status === "active" || status === "running") {
    return <Zap className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-pulse" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  }
  return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

// --- Task row ---

function TaskRow({ task }: { task: OverviewTask }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-6">
      {taskStatusIcon(task.status, task.verification_passed)}
      <span className="text-xs text-muted-foreground truncate">{task.title}</span>
      {task.depends && task.depends.length > 0 && (
        <span className="text-[10px] text-muted-foreground/60">
          ← {task.depends.join(", ")}
        </span>
      )}
    </div>
  );
}

// --- Task waves within a slice ---

function TaskWavesView({ slice }: { slice: OverviewSlice }) {
  const taskMap = useMemo(() => new Map(slice.tasks.map(t => [t.id, t])), [slice.tasks]);

  if (slice.tasks.length === 0) {
    return <p className="text-xs text-muted-foreground pl-6 py-1">No tasks</p>;
  }

  // If there are no explicit task waves or just one wave, show flat list
  if (!slice.task_waves || slice.task_waves.length <= 1) {
    return (
      <div className="space-y-0">
        {slice.tasks.map(t => <TaskRow key={t.id} task={t} />)}
      </div>
    );
  }

  // Show task waves with parallel grouping
  return (
    <div className="space-y-1">
      {slice.task_waves.map((tw) => (
        <div key={tw.waveIndex}>
          {tw.task_ids.length > 1 && (
            <div className="flex items-center gap-1 pl-4">
              <GitBranch className="h-3 w-3 text-muted-foreground/50 rotate-180" />
              <span className="text-[10px] text-muted-foreground/60">
                parallel ({tw.task_ids.length})
              </span>
            </div>
          )}
          {tw.task_ids.map(tid => {
            const task = taskMap.get(tid);
            return task ? <TaskRow key={tid} task={task} /> : null;
          })}
        </div>
      ))}
    </div>
  );
}

// --- Expandable slice card ---

function SliceCard({ slice }: { slice: OverviewSlice }) {
  const [expanded, setExpanded] = useState(false);
  const completedTasks = slice.tasks.filter(t => t.status === "completed").length;
  const totalTasks = slice.tasks.length;
  const isActive = slice.status === "active";

  return (
    <div
      className={`border rounded-md transition-colors ${
        isActive ? "border-blue-500/50 bg-blue-500/5" : "border-border"
      }`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-medium truncate flex-1">{slice.title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {riskBadge(slice.risk)}
          {statusBadge(slice.status)}
          {totalTasks > 0 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {completedTasks}/{totalTasks}
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          {slice.goal && (
            <p className="text-xs text-muted-foreground mb-2 pl-6">{slice.goal}</p>
          )}
          <TaskWavesView slice={slice} />
        </div>
      )}
    </div>
  );
}

// --- Wave row: group of parallel slices ---

function WaveGroup({ wave, waveIndex, isLast }: { wave: OverviewWave; waveIndex: number; isLast: boolean }) {
  const isParallel = wave.slices.length > 1;

  return (
    <div className="relative">
      {/* Wave label */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium tabular-nums">
            {waveIndex + 1}
          </div>
          {isParallel && (
            <div className="flex items-center gap-1">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground rotate-180" />
              <span className="text-xs text-muted-foreground">
                {wave.slices.length} parallel
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Slices in this wave */}
      <div className={`space-y-2 ${isParallel ? "pl-3 border-l-2 border-dashed border-muted-foreground/20 ml-2.5" : "pl-7"}`}>
        {wave.slices.map((slice) => (
          <SliceCard key={slice.id} slice={slice} />
        ))}
      </div>

      {/* Arrow to next wave */}
      {!isLast && (
        <div className="flex justify-center py-1.5">
          <div className="h-4 w-px bg-muted-foreground/30" />
        </div>
      )}
    </div>
  );
}

// --- Milestone section ---

function MilestoneSection({ milestone }: { milestone: OverviewMilestone }) {
  const [expanded, setExpanded] = useState(milestone.status === "active");
  const pct = milestone.total_slices > 0
    ? Math.round((milestone.completed_slices / milestone.total_slices) * 100)
    : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          className="flex items-center justify-between w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle className="text-sm font-semibold">{milestone.title}</CardTitle>
            {statusBadge(milestone.status)}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {milestone.parallelism_factor > 1 && (
              <div className="flex items-center gap-1">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  ×{milestone.parallelism_factor}
                </span>
              </div>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              {milestone.completed_slices}/{milestone.total_slices} slices
            </span>
          </div>
        </button>
        {/* Progress bar */}
        <div className="w-full bg-muted rounded-full h-1.5 mt-2 ml-6 max-w-[calc(100%-1.5rem)]">
          <div
            className="bg-green-500 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-2">
          {milestone.waves.length === 0 ? (
            <p className="text-sm text-muted-foreground">No slices in this milestone.</p>
          ) : (
            <div className="space-y-1">
              {milestone.waves.map((wave, idx) => (
                <WaveGroup
                  key={wave.waveIndex}
                  wave={wave}
                  waveIndex={idx}
                  isLast={idx === milestone.waves.length - 1}
                />
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// --- Main component ---

interface ProjectExecutionOverviewProps {
  milestones: OverviewMilestone[];
}

export default function ProjectExecutionOverview({ milestones }: ProjectExecutionOverviewProps) {
  // Compute global stats
  const stats = useMemo(() => {
    let totalSlices = 0;
    let completedSlices = 0;
    let activeSlices = 0;
    let totalTasks = 0;
    let completedTasks = 0;
    let maxParallelism = 1;

    for (const m of milestones) {
      totalSlices += m.total_slices;
      completedSlices += m.completed_slices;
      activeSlices += m.active_slice_ids.length;
      if (m.parallelism_factor > maxParallelism) maxParallelism = m.parallelism_factor;

      for (const w of m.waves) {
        for (const s of w.slices) {
          totalTasks += s.tasks.length;
          completedTasks += s.tasks.filter(t => t.status === "completed").length;
        }
      }
    }

    return { totalSlices, completedSlices, activeSlices, totalTasks, completedTasks, maxParallelism };
  }, [milestones]);

  if (milestones.length === 0) {
    return null;
  }

  const slicePct = stats.totalSlices > 0 ? Math.round((stats.completedSlices / stats.totalSlices) * 100) : 0;
  const taskPct = stats.totalTasks > 0 ? Math.round((stats.completedTasks / stats.totalTasks) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Execution Overview</h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Slices: {stats.completedSlices}/{stats.totalSlices} ({slicePct}%)</span>
          <span>Tasks: {stats.completedTasks}/{stats.totalTasks} ({taskPct}%)</span>
          {stats.activeSlices > 0 && (
            <Badge variant="default" className="text-[10px]">
              {stats.activeSlices} running
            </Badge>
          )}
          {stats.maxParallelism > 1 && (
            <div className="flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" />
              <span>max ×{stats.maxParallelism}</span>
            </div>
          )}
        </div>
      </div>

      {/* Overall progress */}
      <div className="flex gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">Slices</span>
            <span className="text-xs text-muted-foreground tabular-nums">{slicePct}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-green-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${slicePct}%` }}
            />
          </div>
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">Tasks</span>
            <span className="text-xs text-muted-foreground tabular-nums">{taskPct}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${taskPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Milestone sections */}
      <div className="space-y-3">
        {milestones.map((m) => (
          <MilestoneSection key={m.milestone_id} milestone={m} />
        ))}
      </div>
    </div>
  );
}
