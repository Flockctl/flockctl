import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  useProject,
  useProjectConfig,
  useProjectTree,
  useCreateChat,
  useGeneratePlanStatus,
  useUsageSummary,
  useUsageBreakdown,
  useProjectStats,
  useStartAutoExecuteAll,
  useAttention,
} from "@/lib/hooks";
import { formatTokens as fmtTokens, formatDuration as fmtDuration } from "@/lib/format";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

import { StatCard } from "@/components/stat-card";
import {
  MessageSquare,
  Loader2,
  DollarSign,
  X,
  Hash,
  Target,
  Layers,
  Play,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Settings,
  ListChecks,
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

import type { ChatContext } from "./types";
import { ProjectSchedulesSection } from "./ProjectSchedulesSection";
import { ProjectTemplatesSection } from "./ProjectTemplatesSection";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { CreateTaskFromProjectDialog } from "./CreateTaskFromProjectDialog";
import { GeneratePlanDialog } from "./GeneratePlanDialog";
import { CreateMilestoneDialog } from "./CreateMilestoneDialog";
import { MilestoneCard } from "./MilestoneCard";
import { PlanFileEditor } from "./PlanFileEditor";
import { PlanChatPanel } from "./PlanChatPanel";
import { TodoMdDialog } from "@/components/todo-md-dialog";

/**
 * Full "tree" rendering of a project — header, stats, charts, planning tree,
 * templates, schedules, and the editor/chat modal.
 *
 * This component owns:
 *   - all data fetching (project, config, tree, usage, stats, attention, …)
 *   - expand/collapse state for milestones and slices
 *   - the `chatContext` dialog state (so deep-linked chat opens still work)
 *
 * It is rendered by `project-detail.tsx` whenever `useViewMode()` returns
 * `'tree'`. Other view modes receive a sibling stub until task 02 wires them
 * up. Behaviour here must stay byte-for-byte identical to the pre-extraction
 * page — the visual baseline is the acceptance test.
 */
export function ProjectDetailTreeView({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const createChat = useCreateChat();

  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
  } = useProject(projectId);

  const { data: projectConfig } = useProjectConfig(projectId);
  const baseBranch = projectConfig?.baseBranch ?? "main";

  const { data: planGenStatus } = useGeneratePlanStatus(projectId, {
    enabled: !!projectId,
  });
  const planGenerating = !!planGenStatus?.generating;

  const { data: tree, isLoading: treeLoading } = useProjectTree(
    projectId,
    { refetchInterval: planGenerating ? 3_000 : 30_000 },
  );

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

  const autoExecAll = useStartAutoExecuteAll(projectId);

  // Match the projects-tile behavior: surface a "N waiting" badge in the
  // project-detail header whenever this project has attention items
  // (e.g. tasks in pending_approval). Reuses the same destructive Badge
  // styling as the tile so both surfaces stay visually consistent.
  const { items: attentionItems } = useAttention();
  const attentionCount = useMemo(() => {
    if (!projectId) return 0;
    let count = 0;
    for (const item of attentionItems) {
      if (item.project_id === projectId) count += 1;
    }
    return count;
  }, [attentionItems, projectId]);

  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(
    new Set(),
  );
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(
    new Set(),
  );
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [todoOpen, setTodoOpen] = useState(false);

  function openChat(
    entity_type: ChatContext["entity_type"],
    entity_id: string,
    milestone_id: string | undefined,
    slice_id: string | undefined,
    title: string,
  ) {
    setChatContext({ entity_type, entity_id, milestone_id, slice_id, title });
  }

  function toggleMilestone(id: string) {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSlice(id: string) {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (projectLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (projectError) {
    return (
      <p className="text-destructive">
        Failed to load project: {projectError.message}
      </p>
    );
  }

  if (!project) {
    return <p className="text-muted-foreground">Project not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Project header */}
      <div className="flex items-start justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => navigate("/projects")}
          >
            &larr; Projects
          </Button>
          <div className="mt-2 flex items-center gap-2">
            <h1 className="text-2xl font-bold">{project.name}</h1>
            {attentionCount > 0 && (
              <Badge
                variant="destructive"
                className="cursor-pointer"
                aria-label={`${attentionCount} item${attentionCount === 1 ? "" : "s"} waiting on you`}
                onClick={() => navigate("/attention")}
              >
                {attentionCount} waiting
              </Badge>
            )}
          </div>
          {project.description && (
            <p className="mt-1 text-muted-foreground">
              {project.description}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="secondary">{project.repo_url}</Badge>
            <Badge variant="outline">{baseBranch}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <CreateTaskFromProjectDialog
            projectId={projectId}
            repoUrl={project.repo_url}
            baseBranch={baseBranch}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={createChat.isPending}
            onClick={() =>
              createChat
                .mutateAsync({ project_id: project.id })
                .then((chat) => navigate(`/chats/${chat.id}`))
            }
          >
            <MessageSquare className="mr-1 h-4 w-4" />
            {createChat.isPending ? "Creating…" : "Chat"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTodoOpen(true)}
          >
            <ListChecks className="mr-1 h-4 w-4" />
            TODO
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/projects/${projectId}/settings`)}
          >
            <Settings className="mr-1 h-4 w-4" />
            Settings
          </Button>
          <DeleteProjectDialog projectId={projectId} />
        </div>
      </div>

      {/* Project Stats Row 1 */}
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
          value={fmtTokens((projectUsage?.total_input_tokens ?? 0) + (projectUsage?.total_output_tokens ?? 0))}
          subtitle={`in: ${fmtTokens(projectUsage?.total_input_tokens ?? 0)} / out: ${fmtTokens(projectUsage?.total_output_tokens ?? 0)}`}
          isLoading={!projectUsage}
        />
        <StatCard
          icon={Target}
          label="Milestones"
          value={projectStats ? `${projectStats.milestones.in_progress} active / ${projectStats.milestones.total} total` : "0"}
          isLoading={statsLoading}
        />
        <StatCard
          icon={Layers}
          label="Slices"
          value={projectStats ? `${projectStats.slices.active} active / ${projectStats.slices.total} total` : "0"}
          isLoading={statsLoading}
        />
      </div>

      {/* Project Stats Row 2 */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Play}
          label="Running Tasks"
          value={projectStats?.tasks.running ?? 0}
          isLoading={statsLoading}
        />
        <StatCard
          icon={CheckCircle}
          label="Completed Tasks"
          value={(projectStats?.tasks.completed ?? 0) + (projectStats?.tasks.done ?? 0)}
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
          value={projectStats?.avg_task_duration_seconds != null ? fmtDuration(projectStats.avg_task_duration_seconds) : "N/A"}
          isLoading={statsLoading}
        />
      </div>

      {/* Charts: Usage Over Time + Token Breakdown */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Usage Over Time (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            {(usageByDay?.items ?? []).length === 0 ? (
              <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">No usage data</div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={(usageByDay?.items ?? []).map((item) => ({ date: item.scope_id ?? "", cost: item.cost_usd }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="date" tick={CHART_TICK_STYLE} />
                  <YAxis tick={CHART_TICK_STYLE} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [`$${Number(value).toFixed(4)}`, "Cost"]} />
                  <Line type="monotone" dataKey="cost" stroke="var(--primary)" strokeWidth={2} dot={false} />
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
                <BarChart data={[
                  { name: "Input", tokens: projectUsage.total_input_tokens },
                  { name: "Output", tokens: projectUsage.total_output_tokens },
                  { name: "Cache Create", tokens: projectUsage.total_cache_creation_tokens ?? 0 },
                  { name: "Cache Read", tokens: projectUsage.total_cache_read_tokens ?? 0 },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                  <XAxis dataKey="name" tick={CHART_TICK_STYLE} />
                  <YAxis tick={CHART_TICK_STYLE} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value) => [Number(value).toLocaleString(), "Tokens"]} />
                  <Bar dataKey="tokens" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Planning tree + editor+chat modal */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Planning Tree</h2>
          <div className="flex items-center gap-2">
            {tree && tree.milestones.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={autoExecAll.isPending || planGenerating}
                title={planGenerating ? "Plan is still being generated" : undefined}
                onClick={() => {
                  if (window.confirm("Start auto-execution for all milestones?")) {
                    autoExecAll.mutate();
                  }
                }}
              >
                {autoExecAll.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                Auto-Execute All
              </Button>
            )}
            <GeneratePlanDialog projectId={projectId} />
            <CreateMilestoneDialog projectId={projectId} />
          </div>
        </div>

        {planGenerating && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Plan is being generated
              {planGenStatus?.mode ? ` (${planGenStatus.mode} mode)` : ""}
              &hellip; milestones and slices will appear as the agent writes them. Launching is disabled until generation finishes.
            </span>
          </div>
        )}

        {treeLoading && !tree && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {tree && tree.milestones.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No milestones yet. Use &quot;Generate Plan&quot; to create them automatically from a description.
          </p>
        )}

        {tree && tree.milestones.length > 0 && (
          <div className="space-y-3">
            {tree.milestones.map((milestone) => (
              <MilestoneCard
                key={milestone.id}
                projectId={projectId}
                milestone={milestone}
                expanded={expandedMilestones.has(milestone.id)}
                onToggle={() => toggleMilestone(milestone.id)}
                expandedSlices={expandedSlices}
                onToggleSlice={toggleSlice}
                onOpenChat={openChat}
              />
            ))}
          </div>
        )}
      </div>

      {/* Full-screen editor + chat modal */}
      <Dialog open={!!chatContext} onOpenChange={(v) => { if (!v) setChatContext(null); }}>
        <DialogContent
          showCloseButton={false}
          className="!grid-cols-1 sm:!max-w-[95vw] !max-w-[95vw] !w-[95vw] !h-[90vh] !p-0 !gap-0 !flex !flex-col"
        >
          <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs capitalize">{chatContext?.entity_type}</Badge>
              <span className="text-base font-semibold">{chatContext?.title}</span>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setChatContext(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Left: file editor */}
            <div className="flex-1 min-w-0 border-r h-full">
              {chatContext && (
                <PlanFileEditor
                  projectId={projectId}
                  context={chatContext}
                />
              )}
            </div>
            {/* Right: chat */}
            <div className="w-[400px] shrink-0 h-full">
              {chatContext && (
                <PlanChatPanel
                  // Remount on entity change so the panel re-resolves to the new
                  // entity's chatId from scratch (no leaking streamedContent or
                  // stale chatId across milestone → slice → task switches).
                  key={`${chatContext.entity_type}:${chatContext.entity_id}`}
                  projectId={projectId}
                  context={chatContext}
                  onClose={() => setChatContext(null)}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Separator />

      <ProjectTemplatesSection projectId={projectId} />

      <Separator />

      <ProjectSchedulesSection projectId={projectId} />

      <TodoMdDialog
        scope="project"
        projectId={projectId}
        open={todoOpen}
        onOpenChange={setTodoOpen}
        title={project.name}
      />
    </div>
  );
}
