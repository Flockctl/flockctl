import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  CheckCircle2,
  Copy,
  DollarSign,
  FileCode,
  Layers,
  MessageSquare,
  Play,
  RotateCcw,
  Target,
  Timer,
} from "lucide-react";

import {
  useAutoExecStatus,
  useCreateChat,
  useProjectTree,
  useStartAutoExecute,
} from "@/lib/hooks";
import type { MilestoneTree, PlanSliceTree, PlanTask } from "@/lib/types";
import { statusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePlanEditor } from "./plan-editor-context";

/**
 * Right-rail detail panel that surfaces milestone-level context when the user
 * has selected a milestone in the tree but has NOT yet drilled into a slice.
 *
 * Before this panel existed the rail rendered a muted "No slice selected"
 * empty state for every milestone click — so users had no way to see the
 * milestone vision, status, or aggregate progress without opening a slice.
 *
 * Design notes (mirrors `SliceDetailPanel`):
 *
 * - **Zero new fetches.** Reads from the shared `useProjectTree(projectId)`
 *   cache. Clicking a milestone toggles the URL param only; no network call.
 * - **Aggregate duration + cost** sum the same `summary.duration_ms` /
 *   `summary.total_cost_usd` fields the slice panel uses, summed across every
 *   task under the milestone. These are populated by the backend tree
 *   enrichment in `GET /projects/:id/tree` (see `src/routes/projects.ts`).
 * - **Slice progress** counts how many slices under the milestone are
 *   already in a "completed" state so the rail communicates milestone-level
 *   readiness at a glance.
 * - **Chat** honors the unified-chat-endpoint rule: create a chat with
 *   `entityType: "milestone"` + `entityId: milestoneId`, navigate to the
 *   streaming composer. Same flow as `SliceDetailPanel`.
 */

export interface MilestoneDetailPanelProps {
  projectId: string;
  milestoneId?: string;
  className?: string;
}

interface MilestoneAggregate {
  sliceCount: number;
  completedSliceCount: number;
  taskCount: number;
  completedTaskCount: number;
  durationMs: number | null;
  costUsd: number | null;
}

function aggregateMilestone(milestone: MilestoneTree): MilestoneAggregate {
  let durationMs: number | null = null;
  let costUsd: number | null = null;
  let taskCount = 0;
  let completedTaskCount = 0;

  for (const s of milestone.slices) {
    for (const t of s.tasks) {
      taskCount++;
      if (t.status === "completed") completedTaskCount++;
      const summary = t.summary as
        | { duration_ms?: unknown; total_cost_usd?: unknown }
        | null;
      if (!summary) continue;
      const d = summary.duration_ms;
      if (typeof d === "number" && Number.isFinite(d)) {
        durationMs = (durationMs ?? 0) + d;
      }
      const c = summary.total_cost_usd;
      if (typeof c === "number" && Number.isFinite(c)) {
        costUsd = (costUsd ?? 0) + c;
      }
    }
  }

  return {
    sliceCount: milestone.slices.length,
    completedSliceCount: milestone.slices.filter((s) => s.status === "completed")
      .length,
    taskCount,
    completedTaskCount,
    durationMs,
    costUsd,
  };
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const mrem = m - h * 60;
  return `${h}h ${mrem}m`;
}

function formatCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function MilestoneDetailPanel({
  projectId,
  milestoneId,
  className,
}: MilestoneDetailPanelProps) {
  const navigate = useNavigate();
  const { data: tree, isLoading } = useProjectTree(projectId);
  const createChat = useCreateChat();
  const planEditor = usePlanEditor();
  const startAutoExecute = useStartAutoExecute(projectId);
  // Only gate on the auto-exec status when we actually know the id; the
  // hook will noop while disabled so a panel without a selection does not
  // poll an empty endpoint.
  const autoExecStatus = useAutoExecStatus(projectId, milestoneId ?? "", {
    enabled: !!milestoneId,
  });
  const [copied, setCopied] = useState(false);

  const milestone = useMemo<MilestoneTree | undefined>(() => {
    if (!tree || !milestoneId) return undefined;
    return tree.milestones.find((m) => m.id === milestoneId);
  }, [tree, milestoneId]);

  const aggregate = useMemo(
    () => (milestone ? aggregateMilestone(milestone) : null),
    [milestone],
  );

  const onCopyId = useCallback(() => {
    if (!milestoneId) return;
    try {
      void navigator.clipboard?.writeText(milestoneId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* jsdom / insecure contexts: silently no-op. */
    }
  }, [milestoneId]);

  const onChat = useCallback(() => {
    if (!milestone) return;
    void createChat
      .mutateAsync({
        project_id: projectId,
        entityType: "milestone",
        entityId: milestone.id,
        title: milestone.title,
      })
      .then((chat) => navigate(`/chats/${chat.id}`));
  }, [createChat, milestone, navigate, projectId]);

  const onRun = useCallback(() => {
    if (!milestone) return;
    startAutoExecute.mutate({ milestoneId: milestone.id });
  }, [milestone, startAutoExecute]);

  if (!milestoneId) {
    return (
      <div
        data-testid="milestone-detail-panel-empty"
        className={cn(
          "flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        Select a milestone to see its details.
      </div>
    );
  }

  if (isLoading && !tree) {
    return (
      <div
        data-testid="milestone-detail-panel-loading"
        className={cn("space-y-3 p-4", className)}
      >
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!milestone) {
    return (
      <div
        data-testid="milestone-detail-panel-not-found"
        className={cn(
          "flex h-full flex-col items-center justify-center gap-1 p-4 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium text-muted-foreground">
          Milestone not found
        </p>
        <p className="text-xs text-muted-foreground/80">
          It may have been deleted or the plan was regenerated.
        </p>
      </div>
    );
  }

  const completed = milestone.status === "completed";

  // Run / Re-run gating — same contract the slice panel uses so the two
  // rails stay in lockstep.
  //
  // - Pending / planning milestones (and milestones whose aggregate slice
  //   list is "completed 0 of N") read as a first-time **Run** with a
  //   play icon.
  // - Anything else (active / completed / failed / partially-run) reads as
  //   **Re-run** — we do not want the button to vanish on a completed
  //   milestone because "re-run everything" is a valid repair affordance.
  // - The button is disabled whenever the daemon reports auto-exec is
  //   already in flight for this milestone OR while our own mutation is
  //   pending, with a tooltip explaining why. Same corner case
  //   `rerun-already-running disabled` called out for `SliceDetailPanel`.
  const autoExecRunning = autoExecStatus.data?.status === "running";
  const runDisabled = autoExecRunning || startAutoExecute.isPending;
  const runTitle = autoExecRunning
    ? "Auto-execution is already running for this milestone"
    : undefined;
  const isFirstRun =
    milestone.status === "pending" ||
    milestone.status === "planning" ||
    (aggregate != null &&
      aggregate.completedSliceCount === 0 &&
      aggregate.completedTaskCount === 0);
  const runLabel = startAutoExecute.isPending
    ? "Starting…"
    : isFirstRun
      ? "Run"
      : "Re-run";
  const RunIcon = isFirstRun ? Play : RotateCcw;

  return (
    <aside
      data-testid="milestone-detail-panel"
      data-milestone-id={milestone.id}
      className={cn(
        "flex h-full w-full flex-col gap-4 overflow-hidden p-4",
        className,
      )}
      aria-label="Milestone detail"
    >
      {/* --- Header --- */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {completed ? (
            <CheckCircle2
              className="h-3.5 w-3.5 text-green-600 dark:text-green-500"
              aria-hidden
            />
          ) : (
            <Target className="h-3.5 w-3.5" aria-hidden />
          )}
          <span>Milestone</span>
        </div>
        <h2
          className="font-heading text-base font-semibold leading-snug line-clamp-3"
          data-testid="milestone-detail-panel-title"
          title={milestone.title}
        >
          {milestone.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {statusBadge(milestone.status)}
          {aggregate && (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              data-testid="milestone-detail-panel-progress"
            >
              {aggregate.completedSliceCount}/{aggregate.sliceCount} slices
            </span>
          )}
        </div>
      </header>

      {/* --- Action buttons --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={onRun}
          disabled={runDisabled}
          title={runTitle}
          data-testid="milestone-detail-panel-run"
        >
          <RunIcon className="mr-1 h-4 w-4" />
          {runLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onChat}
          disabled={createChat.isPending}
          data-testid="milestone-detail-panel-chat"
        >
          <MessageSquare className="mr-1 h-4 w-4" />
          {createChat.isPending ? "Opening…" : "Chat"}
        </Button>
        {planEditor && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              planEditor.open({
                entity_type: "milestone",
                entity_id: milestone.id,
                milestone_id: milestone.id,
                title: milestone.title,
              })
            }
            data-testid="milestone-detail-panel-edit-files"
          >
            <FileCode className="mr-1 h-4 w-4" />
            Edit files
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopyId}
          data-testid="milestone-detail-panel-copy-id"
          aria-label="Copy milestone ID"
        >
          {copied ? (
            <Check className="mr-1 h-4 w-4" />
          ) : (
            <Copy className="mr-1 h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy ID"}
        </Button>
      </div>

      {/* --- Aggregate stats --- */}
      {aggregate && (
        <section
          aria-label="Milestone aggregate stats"
          data-testid="milestone-detail-panel-stats"
          className="grid grid-cols-3 gap-2 rounded-md border bg-muted/30 p-2"
        >
          <StatCell
            icon={<Layers className="h-3.5 w-3.5" aria-hidden />}
            label="Tasks done"
            value={`${aggregate.completedTaskCount}/${aggregate.taskCount}`}
            testId="milestone-detail-panel-stat-tasks"
          />
          <StatCell
            icon={<Timer className="h-3.5 w-3.5" aria-hidden />}
            label="Duration"
            value={formatDuration(aggregate.durationMs)}
            testId="milestone-detail-panel-stat-duration"
          />
          <StatCell
            icon={<DollarSign className="h-3.5 w-3.5" aria-hidden />}
            label="Cost"
            value={formatCost(aggregate.costUsd)}
            testId="milestone-detail-panel-stat-cost"
          />
        </section>
      )}

      {/* --- Vision / description --- */}
      {(milestone.vision || milestone.description) && (
        <section
          aria-label="Milestone vision"
          data-testid="milestone-detail-panel-vision"
          className="flex flex-col gap-1"
        >
          <p className="text-xs font-medium text-muted-foreground">Vision</p>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {milestone.vision ?? milestone.description}
          </p>
        </section>
      )}

      {/* --- Slice list --- */}
      <section
        aria-label={`Slices (${milestone.slices.length})`}
        data-testid="milestone-detail-panel-slices"
        className="flex min-h-0 flex-1 flex-col gap-1"
      >
        <p className="text-xs font-medium text-muted-foreground">
          Slices ({milestone.slices.length})
        </p>
        {milestone.slices.length === 0 ? (
          <p className="text-xs text-muted-foreground/80">
            No slices on this milestone yet.
          </p>
        ) : (
          <ul
            data-testid="milestone-detail-panel-slice-list"
            className="flex max-h-[60vh] min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
          >
            {milestone.slices.map((slice) => (
              <SliceRow key={slice.id} slice={slice} />
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function StatCell({
  icon,
  label,
  value,
  testId,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="truncate text-sm tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

function SliceRow({ slice }: { slice: PlanSliceTree }) {
  const done = slice.tasks.filter((t: PlanTask) => t.status === "completed").length;
  const total = slice.tasks.length;
  const completed = slice.status === "completed";

  return (
    <li
      data-testid={`milestone-detail-panel-slice-${slice.id}`}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60"
    >
      {completed ? (
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500"
          aria-hidden
        />
      ) : (
        <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate" title={slice.title}>
        {slice.title}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </li>
  );
}

export default MilestoneDetailPanel;
