import { useState } from "react";
import { useMetricsOverview, useAIKeys } from "@/lib/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/stat-card";
import {
  Timer,
  TrendingUp,
  DollarSign,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  RotateCcw,
  Code,
  Zap,
  DatabaseZap,
  CalendarClock,
  Activity,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

const PERIOD_OPTIONS = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "" },
];

const TICK_STYLE = { fontSize: 12, fill: "var(--foreground)" };
const GRID_STROKE = "var(--border)";
const TOOLTIP_STYLE = { backgroundColor: "var(--popover)", borderColor: "var(--border)", color: "var(--popover-foreground)" };

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "N/A";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function AnalyticsPage() {
  const [period, setPeriod] = useState("30d");
  const [aiKeyId, setAiKeyId] = useState("");
  const periodParam = period || undefined;
  const aiKeyParam = aiKeyId || undefined;

  const { data, isLoading } = useMetricsOverview({ period: periodParam, ai_provider_key_id: aiKeyParam });
  const aiKeysQuery = useAIKeys();

  const periodLabel = PERIOD_OPTIONS.find(o => o.value === period)?.label ?? "All time";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-muted-foreground">Agent performance and usage metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={aiKeyId}
            onChange={(e) => setAiKeyId(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">All AI Keys</option>
            {(aiKeysQuery.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {(k.label ?? k.name ?? k.provider) + (k.key_suffix ? ` ···${k.key_suffix}` : "")}
              </option>
            ))}
          </select>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Section: Time */}
      <SectionTitle>Time</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Timer}
          label="Total Agent Work Time"
          value={data ? formatDuration(data.time.total_work_seconds) : "—"}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          label="Avg Task Duration"
          value={data?.time.avg_duration_seconds != null ? formatDuration(data.time.avg_duration_seconds) : "N/A"}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          label="Median Task Duration"
          value={data?.time.median_duration_seconds != null ? formatDuration(data.time.median_duration_seconds) : "N/A"}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          label="Avg Queue Wait"
          value={data?.time.avg_queue_wait_seconds != null ? formatDuration(data.time.avg_queue_wait_seconds) : "N/A"}
          isLoading={isLoading}
        />
      </div>

      {/* Peak Hours Chart */}
      <div className="mt-4">
        <ChartCard title="Peak Activity Hours" isLoading={isLoading} isEmpty={!data?.time.peak_hours?.length}>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={buildPeakHoursData(data?.time.peak_hours ?? [])}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} />
              <Tooltip
                formatter={(value) => [value, "Tasks"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Section: Productivity */}
      <SectionTitle>Productivity</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={CheckCircle}
          label="Success Rate"
          value={formatPercent(data?.productivity.success_rate ?? null)}
          subtitle={data ? `${(data.productivity.tasks_by_status.completed ?? 0) + (data.productivity.tasks_by_status.done ?? 0)} succeeded` : undefined}
          isLoading={isLoading}
        />
        <StatCard
          icon={XCircle}
          label="Failed"
          value={data ? `${(data.productivity.tasks_by_status.failed ?? 0) + (data.productivity.tasks_by_status.timed_out ?? 0)}` : "—"}
          isLoading={isLoading}
        />
        <StatCard
          icon={RotateCcw}
          label="Retry Rate"
          value={formatPercent(data?.productivity.retry_rate ?? null)}
          isLoading={isLoading}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg Throughput"
          value={data?.productivity.avg_tasks_per_day != null ? `${data.productivity.avg_tasks_per_day.toFixed(1)}/day` : "N/A"}
          isLoading={isLoading}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Code}
          label="Tasks with Code Changes"
          value={data?.productivity.tasks_with_code_changes ?? 0}
          subtitle={data?.productivity.code_change_rate != null ? `${formatPercent(data.productivity.code_change_rate)} of all tasks` : undefined}
          isLoading={isLoading}
        />
        <StatCard
          icon={Activity}
          label={`Total Tasks (${periodLabel})`}
          value={data?.productivity.tasks_by_status.total ?? 0}
          isLoading={isLoading}
        />
      </div>

      {/* Tasks per Day Chart */}
      <div className="mt-4">
        <ChartCard title="Tasks Completed Per Day" isLoading={isLoading} isEmpty={!data?.productivity.tasks_per_day?.length}>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data?.productivity.tasks_per_day ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="day" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} allowDecimals={false} />
              <Tooltip
                formatter={(value) => [value, "Tasks"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Bar dataKey="count" fill="#22c55e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Section: Cost & Tokens */}
      <SectionTitle>Cost & Tokens</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label={`Total Spend (${periodLabel})`}
          value={formatCost(data?.cost.total_cost_usd ?? 0)}
          isLoading={isLoading}
        />
        <StatCard
          icon={Zap}
          label="Burn Rate"
          value={data?.cost.burn_rate_per_day != null ? `${formatCost(data.cost.burn_rate_per_day)}/day` : "N/A"}
          subtitle={data?.cost.burn_rate_per_day != null ? `~${formatCost(data.cost.burn_rate_per_day * 30)}/month` : undefined}
          isLoading={isLoading}
        />
        <StatCard
          icon={DollarSign}
          label="Avg Cost/Task"
          value={data?.cost.avg_cost_per_task != null ? formatCost(data.cost.avg_cost_per_task) : "N/A"}
          isLoading={isLoading}
        />
        <StatCard
          icon={DatabaseZap}
          label="Cache Hit Rate"
          value={formatPercent(data?.cost.cache_hit_rate ?? null)}
          subtitle={data ? `${formatTokens(data.cost.total_cache_read)} tokens saved` : undefined}
          isLoading={isLoading}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Daily Cost Chart */}
        <ChartCard title="Daily Spend" isLoading={isLoading} isEmpty={!data?.cost.daily_costs?.length}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data?.cost.daily_costs ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="day" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} />
              <Tooltip
                formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Line type="monotone" dataKey="cost" stroke="var(--primary)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Cost by Outcome */}
        <ChartCard title="Cost by Outcome" isLoading={isLoading} isEmpty={!data?.cost.cost_by_outcome?.length}>
          <div className="space-y-3 pt-4">
            {(data?.cost.cost_by_outcome ?? []).map((item) => (
              <div key={item.outcome} className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-2">
                  {item.outcome === "success" || item.outcome === "completed" || item.outcome === "done" ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm font-medium capitalize">{item.outcome}</span>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium">{formatCost(item.total_cost)}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.task_count} tasks &middot; avg {formatCost(item.avg_cost)}
                  </p>
                </div>
              </div>
            ))}
            {(!data?.cost.cost_by_outcome?.length && !isLoading) && (
              <p className="py-8 text-center text-sm text-muted-foreground">No data</p>
            )}
          </div>
        </ChartCard>
      </div>

      {/* Token breakdown */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStatCard label="Input Tokens" value={formatTokens(data?.cost.total_input_tokens ?? 0)} isLoading={isLoading} />
        <MiniStatCard label="Output Tokens" value={formatTokens(data?.cost.total_output_tokens ?? 0)} isLoading={isLoading} />
        <MiniStatCard label="Cache Created" value={formatTokens(data?.cost.total_cache_creation ?? 0)} isLoading={isLoading} />
        <MiniStatCard label="Cache Read" value={formatTokens(data?.cost.total_cache_read ?? 0)} isLoading={isLoading} />
      </div>

      {/* Section: Chats */}
      <SectionTitle>Chats</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={MessageSquare}
          label="Total Chat Sessions"
          value={data?.chats.total_chats ?? 0}
          isLoading={isLoading}
        />
        <StatCard
          icon={MessageSquare}
          label="Avg Messages/Chat"
          value={data?.chats.avg_messages_per_chat != null ? data.chats.avg_messages_per_chat.toFixed(1) : "N/A"}
          isLoading={isLoading}
        />
        <StatCard
          icon={Timer}
          label="Total Chat Time"
          value={data ? formatDuration(data.chats.total_chat_time_seconds) : "—"}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          label="Avg Chat Duration"
          value={data?.chats.avg_chat_duration_seconds != null ? formatDuration(data.chats.avg_chat_duration_seconds) : "N/A"}
          isLoading={isLoading}
        />
      </div>

      {/* Section: Schedules */}
      <SectionTitle>Schedules</SectionTitle>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={CalendarClock}
          label="Total Schedules"
          value={data?.schedules.total ?? 0}
          isLoading={isLoading}
        />
        <StatCard
          icon={CheckCircle}
          label="Active"
          value={data?.schedules.active ?? 0}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          label="Paused"
          value={data?.schedules.paused ?? 0}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-8 text-lg font-semibold first:mt-0">{children}</h2>
  );
}

function ChartCard({
  title,
  isLoading,
  isEmpty,
  children,
}: {
  title: string;
  isLoading: boolean;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[250px] w-full" />
        ) : isEmpty ? (
          <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
            No data
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function MiniStatCard({ label, value, isLoading }: { label: string; value: string | number; isLoading: boolean }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        {isLoading ? <Skeleton className="mt-1 h-7 w-16" /> : <p className="text-xl font-bold">{value}</p>}
      </CardContent>
    </Card>
  );
}

function buildPeakHoursData(peakHours: Array<{ hour: number; count: number }>) {
  // Fill all 24 hours
  const map = new Map(peakHours.map(h => [h.hour, h.count]));
  return Array.from({ length: 24 }, (_, i) => ({
    label: `${String(i).padStart(2, "0")}:00`,
    count: map.get(i) ?? 0,
  }));
}
