import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Check,
  Copy,
  DollarSign,
  FileCode,
  FileText,
  MessageSquare,
  Play,
  RotateCcw,
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
import {
  usePlanEditor,
  type PlanEditorController,
} from "./plan-editor-context";

/**
 * Right-rail detail panel for the mission-control `ProjectDetailBoardView`.
 *
 * Design notes:
 *
 * - **Zero new fetches.** Reads the slice directly from the shared
 *   `useProjectTree(projectId)` React-Query cache — the tree panel on the
 *   left and this rail hit the same key, so mounting the rail does NOT fan
 *   out a second `/projects/:id/tree` request.
 * - **Selection-derived view.** Nothing about this component computes derived
 *   state inside an effect; memoized lookups (`useMemo`) keep the render
 *   path flat so re-renders stay well under the 16ms frame budget even with
 *   20+ tasks. The scroll container caps the height so long task lists
 *   virtualize via the browser (native `overflow-y-auto`) rather than
 *   forcing a layout of 20 rows.
 * - **Title wraps to 3 lines + ellipsis** via the standard `line-clamp-3`
 *   Tailwind utility. Hover reveals the full title via `title=...`.
 * - **Re-run** fires the project-level `useStartAutoExecute` mutation scoped
 *   to the slice's owning milestone. If auto-execution is already in flight
 *   for that milestone (reported by `useAutoExecStatus`) the button is
 *   disabled with a tooltip explaining why — matches the
 *   `rerun-already-running disabled` corner case in the brief.
 * - **Chat** follows the unified-chat-endpoint rule in CLAUDE.md: create a
 *   chat with `entityType: "slice"` + `entityId: sliceId` via
 *   `useCreateChat`, then navigate to `/chats/:id` so the existing composer
 *   owns the streaming call.
 * - **Task row → existing Logs modal.** Each task with a materialized
 *   `task_id` links to `/tasks/:task_id` (the same route `TaskRow` in the
 *   tree view uses for "View Logs"). Unmaterialized tasks show a muted
 *   placeholder instead of a broken link.
 * - **Not-found state.** If the project tree has loaded but no slice with
 *   `sliceId` exists (e.g. the slice was just deleted from another tab), we
 *   render a muted "slice not found" message instead of blanking.
 */

export interface SliceDetailPanelProps {
  /** Project owning the slice — required to key into `useProjectTree`. */
  projectId: string;
  /**
   * Slice whose details to show. `undefined` means "no slice selected" — the
   * rail renders an empty-state hint in that case. (The rail is typically
   * mounted inside `SliceDetailTabs`, whose parent passes the current
   * selection through.)
   */
  sliceId?: string;
  /** Optional extra classes merged onto the outer container. */
  className?: string;
}

// --- Cache lookup ------------------------------------------------------------

/**
 * Cheap structural lookup: walk the already-cached milestone tree once to find
 * the slice + its owning milestone. We intentionally do NOT flatten the tree
 * into a `Map` — the tree is tiny (O(milestones × slices) ~ 100s at most),
 * and a `useMemo` over `tree` is re-computed only when the cache invalidates,
 * which happens on mutations that also change the visible rail anyway.
 */
function findSliceWithParent(
  tree: { milestones: MilestoneTree[] } | undefined,
  sliceId: string | undefined,
): { slice: PlanSliceTree; milestone: MilestoneTree } | undefined {
  if (!tree || !sliceId) return undefined;
  for (const m of tree.milestones) {
    const s = m.slices.find((x) => x.id === sliceId);
    if (s) return { slice: s, milestone: m };
  }
  return undefined;
}

// --- Last-run stats ----------------------------------------------------------

interface LastRunStats {
  /** ISO timestamp of the most recent task update, or null if no tasks. */
  timestampIso: string | null;
  /** Summed duration in milliseconds across tasks that reported one. */
  durationMs: number | null;
  /** Summed USD cost across tasks that reported one. */
  costUsd: number | null;
}

/**
 * Derive a "last-run" stats triple from the slice's tasks. `PlanTask.summary`
 * is a loose `Record<string, unknown>` bag — the only convention we rely on is
 * the keys populated by the task executor (`duration_ms`, `total_cost_usd`).
 * Any task that hasn't recorded one of those fields simply doesn't contribute,
 * so pending or never-run slices degrade gracefully to `—`.
 */
function computeLastRunStats(tasks: PlanTask[]): LastRunStats {
  if (tasks.length === 0) {
    return { timestampIso: null, durationMs: null, costUsd: null };
  }

  let durationMs: number | null = null;
  let costUsd: number | null = null;
  let latest: string | null = null;

  for (const t of tasks) {
    if (!latest || (t.updated_at && t.updated_at > latest)) {
      latest = t.updated_at ?? latest;
    }
    const summary = t.summary as
      | { duration_ms?: unknown; total_cost_usd?: unknown }
      | null;
    if (summary) {
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

  return { timestampIso: latest, durationMs, costUsd };
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function formatCost(usd: number | null): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// --- Panel ------------------------------------------------------------------

export function SliceDetailPanel({
  projectId,
  sliceId,
  className,
}: SliceDetailPanelProps) {
  const navigate = useNavigate();
  const { data: tree, isLoading } = useProjectTree(projectId);

  // Look up the slice + its owning milestone out of the shared cache.
  const found = useMemo(
    () => findSliceWithParent(tree, sliceId),
    [tree, sliceId],
  );

  // We only need the auto-exec status to gate the Re-run button. The hook
  // is parked until we know the milestone id — otherwise it would fire with
  // an empty string the moment the panel mounts without a selection.
  const milestoneId = found?.milestone.id ?? "";
  const autoExecStatus = useAutoExecStatus(projectId, milestoneId, {
    enabled: !!milestoneId,
  });

  const startAutoExecute = useStartAutoExecute(projectId);
  const createChat = useCreateChat();
  const planEditor = usePlanEditor();

  const [copied, setCopied] = useState(false);

  // Memo hooks must run unconditionally on every render — hoist the
  // derived values here, before any early returns below.
  const tasksArray = found?.slice.tasks ?? EMPTY_TASKS;
  const sortedTasks = useMemo(
    () => [...tasksArray].sort((a, b) => a.order_index - b.order_index),
    [tasksArray],
  );
  const stats = useMemo(() => computeLastRunStats(tasksArray), [tasksArray]);

  const onCopyId = useCallback(() => {
    if (!sliceId) return;
    try {
      void navigator.clipboard?.writeText(sliceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* jsdom / insecure contexts: silently no-op. */
    }
  }, [sliceId]);

  const onRerun = useCallback(() => {
    if (!found) return;
    startAutoExecute.mutate({ milestoneId: found.milestone.id });
  }, [found, startAutoExecute]);

  const onChat = useCallback(() => {
    if (!found) return;
    void createChat
      .mutateAsync({
        project_id: projectId,
        entityType: "slice",
        entityId: found.slice.id,
        title: found.slice.title,
      })
      .then((chat) => navigate(`/chats/${chat.id}`));
  }, [createChat, found, navigate, projectId]);

  // --- Empty slots -----------------------------------------------------

  if (!sliceId) {
    return (
      <div
        data-testid="slice-detail-panel-empty"
        className={cn(
          "flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        Select a slice to see its details.
      </div>
    );
  }

  if (isLoading && !tree) {
    return (
      <div
        data-testid="slice-detail-panel-loading"
        className={cn("space-y-3 p-4", className)}
      >
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!found) {
    return (
      <div
        data-testid="slice-detail-panel-not-found"
        className={cn(
          "flex h-full flex-col items-center justify-center gap-1 p-4 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium text-muted-foreground">
          Slice not found
        </p>
        <p className="text-xs text-muted-foreground/80">
          It may have been deleted or the plan was regenerated.
        </p>
      </div>
    );
  }

  const { slice, milestone } = found;

  const autoExecRunning =
    autoExecStatus.data?.status === "running" ||
    autoExecStatus.data?.current_slice_ids?.includes(slice.id);
  const rerunDisabled = autoExecRunning || startAutoExecute.isPending;
  const rerunTitle = autoExecRunning
    ? "Auto-execution is already running for this milestone"
    : undefined;

  // A slice that has never been kicked off ("pending" / "planning") reads as
  // a first-time "Run", not a "Re-run". Any other status — active, verifying,
  // merging, completed, failed, skipped — implies the slice has already been
  // touched at least once, so the retry affordance is accurate.
  const isFirstRun = slice.status === "pending" || slice.status === "planning";
  const runLabel = startAutoExecute.isPending
    ? "Starting…"
    : isFirstRun
      ? "Run"
      : "Re-run";
  const RunIcon = isFirstRun ? Play : RotateCcw;

  return (
    <aside
      data-testid="slice-detail-panel"
      data-slice-id={slice.id}
      className={cn(
        "flex h-full w-full flex-col gap-4 overflow-hidden p-4",
        className,
      )}
      aria-label="Slice detail"
    >
      {/* --- Header --- */}
      <header className="flex flex-col gap-2">
        <p
          className="text-xs text-muted-foreground truncate"
          title={milestone.title}
          data-testid="slice-detail-panel-milestone"
        >
          {milestone.title}
        </p>
        <h2
          className="font-heading text-base font-semibold leading-snug line-clamp-3"
          data-testid="slice-detail-panel-title"
          title={slice.title}
        >
          {slice.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {statusBadge(slice.status)}
        </div>
      </header>

      {/* --- Action buttons --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={onRerun}
          disabled={rerunDisabled}
          title={rerunTitle}
          data-testid="slice-detail-panel-rerun"
        >
          <RunIcon className="mr-1 h-4 w-4" />
          {runLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onChat}
          disabled={createChat.isPending}
          data-testid="slice-detail-panel-chat"
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
                entity_type: "slice",
                entity_id: slice.id,
                milestone_id: milestone.id,
                slice_id: slice.id,
                title: slice.title,
              })
            }
            data-testid="slice-detail-panel-edit-files"
          >
            <FileCode className="mr-1 h-4 w-4" />
            Edit files
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopyId}
          data-testid="slice-detail-panel-copy-id"
          aria-label="Copy slice ID"
        >
          {copied ? (
            <Check className="mr-1 h-4 w-4" />
          ) : (
            <Copy className="mr-1 h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy ID"}
        </Button>
      </div>

      {/* --- Last-run stats --- */}
      <section
        aria-label="Last run stats"
        data-testid="slice-detail-panel-stats"
        className="grid grid-cols-3 gap-2 rounded-md border bg-muted/30 p-2"
      >
        <StatCell
          icon={<Timer className="h-3.5 w-3.5" aria-hidden />}
          label="Duration"
          value={formatDuration(stats.durationMs)}
          testId="slice-detail-panel-stat-duration"
        />
        <StatCell
          icon={<FileText className="h-3.5 w-3.5" aria-hidden />}
          label="Last update"
          value={formatTimestamp(stats.timestampIso)}
          testId="slice-detail-panel-stat-timestamp"
        />
        <StatCell
          icon={<DollarSign className="h-3.5 w-3.5" aria-hidden />}
          label="Cost"
          value={formatCost(stats.costUsd)}
          testId="slice-detail-panel-stat-cost"
        />
      </section>

      {/* --- Tasks list --- */}
      <section
        aria-label={`Tasks (${sortedTasks.length})`}
        data-testid="slice-detail-panel-tasks"
        className="flex min-h-0 flex-1 flex-col gap-1"
      >
        <p className="text-xs font-medium text-muted-foreground">
          Tasks ({sortedTasks.length})
        </p>
        {sortedTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground/80">
            No tasks on this slice yet.
          </p>
        ) : (
          <ul
            data-testid="slice-detail-panel-task-list"
            // max-h lets the rail host the first ~6 tasks without scroll;
            // more than that and the list scrolls within the rail — covered
            // by the 20-task corner case in the brief.
            className="flex max-h-[60vh] min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
          >
            {sortedTasks.map((task) => (
              <TaskLink
                key={task.id}
                task={task}
                milestoneId={milestone.id}
                sliceId={slice.id}
                planEditor={planEditor}
              />
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

/**
 * Stable empty-array sentinel. Sharing one reference keeps `useMemo`
 * dependencies stable across renders where the panel has no selected slice
 * — swapping in a fresh `[]` every render would invalidate the sort / stats
 * memos unnecessarily.
 */
const EMPTY_TASKS: PlanTask[] = [];

// --- Presentational bits ---------------------------------------------------

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
      <span
        className="truncate text-sm tabular-nums"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function TaskLink({
  task,
  milestoneId,
  sliceId,
  planEditor,
}: {
  task: PlanTask;
  milestoneId: string;
  sliceId: string;
  planEditor: PlanEditorController | null;
}) {
  const rowClasses =
    "flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60";

  const inner = (
    <>
      <span
        className="min-w-0 flex-1 truncate"
        title={task.title}
        data-testid={`slice-detail-panel-task-title-${task.id}`}
      >
        {task.title}
      </span>
      <span className="shrink-0">{statusBadge(task.status)}</span>
    </>
  );

  // Icon-only affordance that mirrors the "Edit files" button on the slice
  // header — opens the same Plan editor modal but scoped to this task's plan
  // file. Hidden when no provider is mounted (e.g. storybook), same contract
  // as the slice-level trigger.
  const planButton = planEditor && (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      onClick={() =>
        planEditor.open({
          entity_type: "task",
          entity_id: task.id,
          milestone_id: milestoneId,
          slice_id: sliceId,
          title: task.title,
        })
      }
      aria-label={`Open plan for ${task.title}`}
      title="Open task plan"
      data-testid={`slice-detail-panel-open-plan-${task.id}`}
    >
      <FileCode className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );

  if (task.task_id) {
    return (
      <li className="flex items-center gap-1">
        <Link
          to={`/tasks/${task.task_id}`}
          className={cn(rowClasses, "min-w-0 flex-1 cursor-pointer text-foreground")}
          data-testid={`slice-detail-panel-task-${task.id}`}
          data-task-ref={task.task_id}
        >
          {inner}
        </Link>
        {planButton}
      </li>
    );
  }

  return (
    <li className="flex items-center gap-1">
      <div
        className={cn(rowClasses, "min-w-0 flex-1 text-muted-foreground")}
        data-testid={`slice-detail-panel-task-${task.id}`}
        aria-disabled="true"
        title="No run yet"
      >
        {inner}
      </div>
      {planButton}
    </li>
  );
}

export default SliceDetailPanel;
