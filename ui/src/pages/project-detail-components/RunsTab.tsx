import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useUsageSummary,
  useUsageBreakdown,
  useProjectStats,
  useTasks,
} from "@/lib/hooks";
import { formatTokens as fmtTokens, formatDuration as fmtDuration } from "@/lib/format";
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
import { statusBadge } from "@/components/status-badge";
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

const STATUS_OPTIONS: Array<{ value: "" | TaskStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "assigned", label: "Assigned" },
  { value: "running", label: "Running" },
  { value: "pending_approval", label: "Awaiting approval" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "timed_out", label: "Timed out" },
];

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtCostCents(cost: number | null | undefined): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

function fmtDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return "—";
  return fmtDuration(ms / 1000);
}

export function RunsTab({ projectId }: { projectId: string }) {
  const [statusFilter, setStatusFilter] = useState<"" | TaskStatus>("");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const limit = 25;

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

  const { data: tasksPage, isLoading: tasksLoading } = useTasks(
    page * limit,
    limit,
    {
      project_id: projectId,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(agentFilter.trim() ? { agent: agentFilter.trim() } : {}),
    },
    { refetchInterval: 15_000 },
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
          value={`$${(projectUsage?.total_cost_usd ?? 0).toFixed(2)}`}
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
                      `$${Number(value).toFixed(4)}`,
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

      {/* Tasks table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-4">
          <CardTitle className="text-sm font-medium">Tasks</CardTitle>
          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as "" | TaskStatus);
                setPage(0);
              }}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
        </CardHeader>
        <CardContent className="p-0">
          {tasksLoading && items.length === 0 ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No tasks match the current filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left font-medium">Prompt / Agent</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Cost</th>
                    <th className="px-3 py-2 text-left font-medium">Duration</th>
                    <th className="px-3 py-2 text-left font-medium">Started</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((task) => (
                    <tr
                      key={task.id}
                      className="border-b last:border-b-0 hover:bg-muted/40"
                      data-testid={`project-runs-task-row-${task.id}`}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="line-clamp-2 max-w-[480px] text-xs">
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
                      </td>
                      <td className="px-3 py-2 align-top">
                        {statusBadge(task.status)}
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-xs">
                        {fmtCostCents(task.liveMetrics?.total_cost_usd)}
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-xs">
                        {fmtDurationMs(task.liveMetrics?.duration_ms)}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap text-xs text-muted-foreground">
                        {fmtDateTime(task.started_at ?? task.created_at)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                        >
                          <Link to={`/tasks/${task.id}`}>
                            Open
                            <ExternalLink className="ml-1 h-3 w-3" />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {items.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
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
        </CardContent>
      </Card>
    </div>
  );
}

export default RunsTab;
