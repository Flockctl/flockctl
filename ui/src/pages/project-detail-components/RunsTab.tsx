import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useUsageSummary,
  useUsageBreakdown,
  useProjectStats,
  useTasks,
} from "@/lib/hooks";
import { useWsAwarePolling } from "@/lib/global-ws";
import {
  formatTokens as fmtTokens,
  formatDuration as fmtDuration,
  formatCost,
  formatCostFine,
  formatDateTime,
} from "@/lib/format";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/stat-card";
import {
  FlatCard,
  SegmentToggle,
  StatusPill,
} from "@/components/design";
import { statusPillTone, statusPillLabel } from "@/lib/task-status";
import {
  DollarSign,
  Hash,
  Target,
  Layers,
  Play,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  CHART_TICK_STYLE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_PROPS,
} from "@/lib/chart-theme";
import type { TaskStatus } from "@/lib/types";

/**
 * "Runs" tab of the redesigned project-detail page.
 *
 * Owns the analytics + history side of the project:
 *   - eight stat cards (spend, tokens, milestones, slices, running,
 *     completed, failed, avg duration) that used to live in the old tree
 *     view header;
 *   - two charts (Usage Over Time, Token Breakdown) that also came out of
 *     the old tree view;
 *   - a new flat tasks table scoped to this project, with status + agent
 *     filters, so users have a single place to scan every task without
 *     drilling into milestones/slices.
 *
 * Intentionally has no write mutations — every action links out to the task
 * detail page. Keeping this tab read-only prevents it from becoming a second
 * "planning" surface that competes with the Plan tab.
 */

/**
 * Coarse-grained status filter buckets surfaced as a 4-way SegmentToggle
 * above the runs table. The original status dropdown exposed the full
 * `TaskStatus` enum (8 values) which is too noisy for the redesigned tab —
 * the redesigned slice (M23 / 00-project-detail / T05) collapses the
 * filter down to the four states an operator scans for at a glance:
 *
 *   - All        → no filter, shows every status the API returns.
 *   - Running    → `status=running`.
 *   - Completed  → `status=done` (the terminal-success state).
 *   - Failed     → `status=failed`.
 *
 * Statuses outside that bucket (`queued`, `assigned`, `pending_approval`,
 * `timed_out`, `rate_limited`) only ever surface in the "All" view.
 * Filtering by them is a power-user operation we'd rather expose via a
 * future advanced-filters drawer than clutter the segmented control.
 */
type RunsFilterBucket = "all" | "running" | "completed" | "failed";

const FILTER_OPTIONS: Array<{ value: RunsFilterBucket; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function bucketToStatus(bucket: RunsFilterBucket): TaskStatus | undefined {
  switch (bucket) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "all":
    default:
      return undefined;
  }
}

// Status pill mapping + label helper live in `@/lib/task-status` so RunsTab
// and TasksTable stay in lockstep. `formatDateTime` lives in `@/lib/format`.

/**
 * Local USD-input wrapper around `formatCost` that distinguishes "no data"
 * (`null` → `—`), "exactly zero" (`$0`), and "below cent" (`<$0.01`) from
 * the regular two-decimals path. Misnamed — the input is USD, not cents —
 * but kept under the same export name to avoid churning the call sites.
 */
function fmtCostCents(cost: number | null | undefined): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  return formatCost(cost);
}

function fmtDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return "—";
  return fmtDuration(ms / 1000);
}

export function RunsTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [statusBucket, setStatusBucket] = useState<RunsFilterBucket>("all");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const limit = 25;

  const statusFilter = useMemo(() => bucketToStatus(statusBucket), [statusBucket]);

  const { data: projectUsage } = useUsageSummary(
    { project_id: projectId },
    { enabled: !!projectId },
  );

  const { data: projectStats, isLoading: statsLoading } = useProjectStats(
    projectId,
    { enabled: !!projectId },
  );

  const { data: usageByDay } = useUsageBreakdown(
    { group_by: "day", project_id: projectId, period: "30d" },
    { enabled: !!projectId },
  );

  const tasksRefetchInterval = useWsAwarePolling(15_000);
  const { data: tasksPage, isLoading: tasksLoading } = useTasks(
    page * limit,
    limit,
    {
      project_id: projectId,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(agentFilter.trim() ? { agent: agentFilter.trim() } : {}),
    },
    { refetchInterval: tasksRefetchInterval },
  );

  const items = tasksPage?.items ?? [];
  const total = tasksPage?.total ?? 0;
  const hasPrev = page > 0;
  const hasNext = (page + 1) * limit < total;

  return (
    <div className="space-y-4" data-testid="project-runs-tab">
      {/* Stats row 1 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Project Spend"
          value={formatCost(projectUsage?.total_cost_usd ?? 0)}
          isLoading={!projectUsage}
        />
        <StatCard
          icon={Hash}
          label="Total Tokens"
          value={fmtTokens(
            (projectUsage?.total_input_tokens ?? 0) +
              (projectUsage?.total_output_tokens ?? 0),
          )}
          subtitle={`in: ${fmtTokens(projectUsage?.total_input_tokens ?? 0)} / out: ${fmtTokens(projectUsage?.total_output_tokens ?? 0)}`}
          isLoading={!projectUsage}
        />
        <StatCard
          icon={Target}
          label="Milestones"
          value={
            projectStats
              ? `${projectStats.milestones.in_progress} active / ${projectStats.milestones.total} total`
              : "0"
          }
          isLoading={statsLoading}
        />
        <StatCard
          icon={Layers}
          label="Slices"
          value={
            projectStats
              ? `${projectStats.slices.active} active / ${projectStats.slices.total} total`
              : "0"
          }
          isLoading={statsLoading}
        />
      </div>

      {/* Stats row 2 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Play}
          label="Running Tasks"
          value={projectStats?.tasks.running ?? 0}
          isLoading={statsLoading}
        />
        <StatCard
          icon={CheckCircle}
          label="Completed Tasks"
          value={
            (projectStats?.tasks.completed ?? 0) +
            (projectStats?.tasks.done ?? 0)
          }
          isLoading={statsLoading}
        />
        <StatCard
          icon={XCircle}
          label="Failed Tasks"
          value={projectStats?.tasks.failed ?? 0}
          isLoading={statsLoading}
        />
        <StatCard
          icon={Clock}
          label="Avg Duration"
          value={
            projectStats?.avg_task_duration_seconds != null
              ? fmtDuration(projectStats.avg_task_duration_seconds)
              : "N/A"
          }
          isLoading={statsLoading}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Usage Over Time (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(usageByDay?.items ?? []).length === 0 ? (
              <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
                No usage data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={(usageByDay?.items ?? []).map((item) => ({
                    date: item.scope_id ?? "",
                    cost: item.cost_usd,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="date" tick={CHART_TICK_STYLE} />
                  <YAxis tick={CHART_TICK_STYLE} />
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    formatter={(value) => [
                      formatCostFine(Number(value)),
                      "Cost",
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="cost"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Token Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {!projectUsage ? (
              <Skeleton className="h-[250px] w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart
                  data={[
                    { name: "Input", tokens: projectUsage.total_input_tokens },
                    { name: "Output", tokens: projectUsage.total_output_tokens },
                    {
                      name: "Cache Create",
                      tokens: projectUsage.total_cache_creation_tokens ?? 0,
                    },
                    {
                      name: "Cache Read",
                      tokens: projectUsage.total_cache_read_tokens ?? 0,
                    },
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="name" tick={CHART_TICK_STYLE} />
                  <YAxis tick={CHART_TICK_STYLE} />
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    formatter={(value) => [
                      Number(value).toLocaleString(),
                      "Tokens",
                    ]}
                  />
                  <Bar dataKey="tokens" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tasks table — flat card surface with header / rows / footer slots
          separated by `border-b divider-y` hairlines. The filter row at
          the top hosts the SegmentToggle (All / Running / Completed /
          Failed) which is the redesigned status filter; the agent text
          filter and total count sit alongside it. Row click navigates to
          the task detail page; the existing "Open" button stays so
          keyboard / middle-click discoverability is preserved. */}
      <FlatCard className="overflow-hidden">
        {/* Header / filter row. */}
        <div
          className="flex flex-row flex-wrap items-center justify-between gap-3 border-b divider-y px-3 py-2"
          data-testid="project-runs-filter-row"
        >
          <h3 className="text-sm font-medium">Tasks</h3>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentToggle<RunsFilterBucket>
              options={FILTER_OPTIONS}
              value={statusBucket}
              onChange={(next) => {
                setStatusBucket(next);
                setPage(0);
              }}
              size="sm"
              aria-label="Filter by status"
              data-testid="project-runs-status-filter"
            />
            <Input
              aria-label="Filter by agent"
              placeholder="Agent…"
              value={agentFilter}
              onChange={(e) => {
                setAgentFilter(e.target.value);
                setPage(0);
              }}
              className="h-8 w-36 text-xs"
            />
            <span className="text-xs text-muted-foreground">
              {total} total
            </span>
          </div>
        </div>

        {/* Header row + rows. Both are 6-col grids so the column widths
            line up vertically. The header uses uppercase tracking-wider
            zinc-500 per the redesigned slice. */}
        <div
          className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_5rem_8rem_4rem] gap-3 border-b divider-y px-4 py-2 text-[11px] uppercase tracking-wider font-semibold text-zinc-500"
          data-testid="project-runs-header-row"
        >
          <div>Prompt / Agent</div>
          <div>Status</div>
          <div>Cost</div>
          <div>Duration</div>
          <div>Started</div>
          <div className="sr-only">Actions</div>
        </div>

        {tasksLoading && items.length === 0 ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-4 text-center text-[12px] text-muted-foreground">
            No tasks match the current filters.
          </p>
        ) : (
          <div data-testid="project-runs-rows">
            {items.map((task) => (
              <div
                key={task.id}
                role="row"
                tabIndex={0}
                onClick={() => navigate(`/tasks/${task.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/tasks/${task.id}`);
                  }
                }}
                className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_5rem_8rem_4rem] gap-3 border-b divider-y last:border-b-0 px-3 py-2 cursor-pointer hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                data-testid={`project-runs-task-row-${task.id}`}
              >
                <div className="min-w-0">
                  <div className="line-clamp-2 text-xs">
                    {task.prompt ?? (
                      <span className="text-muted-foreground">
                        (no prompt)
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {task.agent ?? "—"}
                    {task.model ? ` · ${task.model}` : ""}
                  </div>
                </div>
                <div>
                  <StatusPill tone={statusPillTone(task.status)}>
                    {statusPillLabel(task.status)}
                  </StatusPill>
                </div>
                <div className="font-mono text-xs">
                  {fmtCostCents(task.liveMetrics?.total_cost_usd)}
                </div>
                <div className="font-mono text-xs">
                  {fmtDurationMs(task.liveMetrics?.duration_ms)}
                </div>
                <div className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(task.started_at ?? task.created_at)}
                </div>
                <div className="flex items-center justify-end">
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Link to={`/tasks/${task.id}`}>
                      Open
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <div
            className="flex items-center justify-between gap-2 border-t divider-y px-4 py-2 text-xs text-muted-foreground"
            data-testid="project-runs-pagination"
          >
            <span>
              Showing {page * limit + 1}–{page * limit + items.length} of{" "}
              {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="h-7 px-2 text-xs"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext}
                onClick={() => setPage((p) => p + 1)}
                className="h-7 px-2 text-xs"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </FlatCard>
    </div>
  );
}

export default RunsTab;
