import { useState } from "react";
import { useTasks, useProjects, useUsageSummary, useUsageBreakdown, useTaskStats, useAIKeys } from "@/lib/hooks";
import { formatTokens, formatDuration } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/stat-card";
import {
  ListTodo,
  FolderGit2,
  DollarSign,
  Hash,
  ArrowDownToLine,
  ArrowUpFromLine,
  DatabaseZap,
  BookOpen,
  Server,
  CheckCircle,
  XCircle,
  Clock,
  Loader,
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
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  CHART_TICK_STYLE as TICK_STYLE,
  CHART_GRID_STROKE as GRID_STROKE,
  CHART_TOOLTIP_PROPS,
} from "@/lib/chart-theme";

const POLL_INTERVAL = 30_000;

const PERIOD_OPTIONS = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "" },
];

const STATUS_COLORS: Record<string, string> = {
  queued: "#94a3b8",
  assigned: "#a78bfa",
  running: "#3b82f6",
  completed: "#22c55e",
  done: "#22c55e",
  failed: "#ef4444",
  timed_out: "#f97316",
  cancelled: "#6b7280",
};

export default function DashboardPage() {
  const [period, setPeriod] = useState("30d");
  const [aiKeyId, setAiKeyId] = useState("");
  const periodParam = period || undefined;
  const aiKeyParam = aiKeyId || undefined;

  const tasksQuery = useTasks(0, 50, undefined, { refetchInterval: POLL_INTERVAL });
  const projectsQuery = useProjects({ refetchInterval: POLL_INTERVAL });
  const taskStatsQuery = useTaskStats(undefined, { refetchInterval: POLL_INTERVAL });
  const aiKeysQuery = useAIKeys();

  const usageQuery = useUsageSummary(
    { period: periodParam, ai_provider_key_id: aiKeyParam },
    { refetchInterval: POLL_INTERVAL },
  );

  const usageOverTimeQuery = useUsageBreakdown(
    { group_by: "day", period: periodParam, ai_provider_key_id: aiKeyParam },
    { refetchInterval: POLL_INTERVAL },
  );

  const costByProjectQuery = useUsageBreakdown(
    { group_by: "project", period: periodParam, ai_provider_key_id: aiKeyParam },
    { refetchInterval: POLL_INTERVAL },
  );

  const costByProviderQuery = useUsageBreakdown(
    { group_by: "provider", period: periodParam, ai_provider_key_id: aiKeyParam },
    { refetchInterval: POLL_INTERVAL },
  );

  const costByModelQuery = useUsageBreakdown(
    { group_by: "model", period: periodParam, ai_provider_key_id: aiKeyParam },
    { refetchInterval: POLL_INTERVAL },
  );

  const activeTasks = (tasksQuery.data?.items ?? []).filter(
    (t) => t.status === "running",
  ).length;

  const projectCount = projectsQuery.data?.length ?? 0;
  const usage = usageQuery.data;
  const totalTokens = (usage?.total_input_tokens ?? 0) + (usage?.total_output_tokens ?? 0);

  const periodLabel = PERIOD_OPTIONS.find(o => o.value === period)?.label ?? "All time";

  // Task status distribution for pie chart
  const taskStatsData = taskStatsQuery.data;
  const taskPieData = taskStatsData
    ? Object.entries(taskStatsData)
        .filter(([k, v]) => k !== "total" && k !== "avg_duration_seconds" && (v as number) > 0)
        .map(([k, v]) => ({ name: k, value: v as number, fill: STATUS_COLORS[k] ?? "#94a3b8" }))
    : [];

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="mb-1 text-xl font-bold sm:text-2xl">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Flockctl</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      {/* Row 1: Summary stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={ListTodo}
          label="Active Tasks"
          value={activeTasks}
          isLoading={tasksQuery.isLoading}
        />
        <StatCard
          icon={FolderGit2}
          label="Projects"
          value={projectCount}
          isLoading={projectsQuery.isLoading}
        />
        <StatCard
          icon={DollarSign}
          label={`${periodLabel} Spend`}
          value={`$${(usage?.total_cost_usd ?? 0).toFixed(2)}`}
          isLoading={usageQuery.isLoading}
        />
        <StatCard
          icon={Hash}
          label={`${periodLabel} Tokens`}
          value={formatTokens(totalTokens)}
          subtitle={`in: ${formatTokens(usage?.total_input_tokens ?? 0)} / out: ${formatTokens(usage?.total_output_tokens ?? 0)}`}
          isLoading={usageQuery.isLoading}
        />
      </div>

      {/* Row 2: Token breakdown */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={ArrowDownToLine}
          label="Input Tokens"
          value={formatTokens(usage?.total_input_tokens ?? 0)}
          isLoading={usageQuery.isLoading}
        />
        <StatCard
          icon={ArrowUpFromLine}
          label="Output Tokens"
          value={formatTokens(usage?.total_output_tokens ?? 0)}
          isLoading={usageQuery.isLoading}
        />
        <StatCard
          icon={DatabaseZap}
          label="Cache Creation"
          value={formatTokens(usage?.total_cache_creation_tokens ?? 0)}
          isLoading={usageQuery.isLoading}
        />
        <StatCard
          icon={BookOpen}
          label="Cache Read"
          value={formatTokens(usage?.total_cache_read_tokens ?? 0)}
          isLoading={usageQuery.isLoading}
        />
      </div>

      {/* Charts row 1: Usage Over Time + Cost by Project */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Usage Over Time" isLoading={usageOverTimeQuery.isLoading} isEmpty={(usageOverTimeQuery.data?.items ?? []).length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={(usageOverTimeQuery.data?.items ?? []).map((item) => ({ date: item.scope_id ?? "", cost: item.cost_usd }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
              <Line type="monotone" dataKey="cost" stroke="var(--primary)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Project" isLoading={costByProjectQuery.isLoading} isEmpty={(costByProjectQuery.data?.items ?? []).length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={(costByProjectQuery.data?.items ?? []).map((item) => ({ name: item.scope_label ?? item.scope_id ?? "Unknown", cost: item.cost_usd }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="name" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
              <Bar dataKey="cost" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Charts row 2: Cost by Provider + Cost by Model */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Cost by Provider" isLoading={costByProviderQuery.isLoading} isEmpty={(costByProviderQuery.data?.items ?? []).length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={(costByProviderQuery.data?.items ?? []).map((item) => ({ name: item.scope_label ?? item.scope_id ?? "Unknown", cost: item.cost_usd }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="name" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
              <Bar dataKey="cost" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Model" isLoading={costByModelQuery.isLoading} isEmpty={(costByModelQuery.data?.items ?? []).length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart layout="vertical" data={(costByModelQuery.data?.items ?? []).map((item) => ({ name: item.scope_label ?? item.scope_id ?? "Unknown", cost: item.cost_usd }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={TICK_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "var(--foreground)" }} width={160} />
              <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
              <Bar dataKey="cost" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Task Status Distribution */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Task Status Distribution" isLoading={taskStatsQuery.isLoading} isEmpty={taskPieData.length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={taskPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, value }) => `${name}: ${value}`}>
                {taskPieData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip {...CHART_TOOLTIP_PROPS} />
              <Legend wrapperStyle={{ color: "var(--foreground)" }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Task stats summary cards */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Task Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {taskStatsQuery.isLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <MiniStat icon={Hash} label="Total" value={taskStatsData?.total ?? 0} />
                <MiniStat icon={Clock} label="Queued" value={taskStatsData?.queued ?? 0} />
                <MiniStat icon={Loader} label="Running" value={taskStatsData?.running ?? 0} color="text-blue-500" />
                <MiniStat icon={CheckCircle} label="Completed" value={(taskStatsData?.completed ?? 0) + (taskStatsData?.done ?? 0)} color="text-green-500" />
                <MiniStat icon={XCircle} label="Failed" value={taskStatsData?.failed ?? 0} color="text-red-500" />
                <MiniStat icon={Clock} label="Timed Out" value={taskStatsData?.timed_out ?? 0} color="text-orange-500" />
                <div className="col-span-2 mt-2 border-t pt-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Server className="h-4 w-4" />
                    <span>Avg Duration:</span>
                    <span className="font-medium text-foreground">
                      {taskStatsData?.avg_duration_seconds != null
                        ? formatDuration(taskStatsData.avg_duration_seconds)
                        : "N/A"}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
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
          <Skeleton className="h-[300px] w-full" />
        ) : isEmpty ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            No data
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <Icon className={`h-4 w-4 ${color ?? "text-muted-foreground"}`} />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </div>
    </div>
  );
}

