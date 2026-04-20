import { useState, useEffect, useRef, useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  useWebSocket,
  type WSMessage,
} from "./ws";
import type {
  PaginatedResponse,
  Task,
  TaskLog,
  TaskMetrics,
  TaskTemplate,
  TaskTemplateCreate,
  Schedule,
  ScheduleCreate,
  TaskCreate,
  TaskUpdate,
  TaskFilters,
  ScheduleFilters,
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
  WorkspaceWithProjects,
  Project,
  ProjectCreate,
  ProjectUpdate,
  ProjectTree,
  MilestoneCreate,
  MilestoneUpdate,
  PlanSliceCreate,
  PlanSliceUpdate,
  PlanTaskCreate,
  PlanTaskUpdate,
  ActivateRequest,
  AutoExecuteRequest,
  AutoExecuteStatusResponse,
  ExecutionGraphResponse,
  ProjectExecutionOverviewResponse,
  ChatCreate,
  ChatResponse,
  ChatDetailResponse,
  ChatMessageResponse,
  ChatMessageCreate,
  ChatUpdate,
  GeneratePlanRequest,
  GeneratePlanStatus,
  ToolExecution,
  UsageSummary,
  UsageBreakdownResponse,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
  TaskStats,
  ProjectStats,
  MetricsOverview,
} from "./types";
import {
  fetchTasks,
  fetchTask,
  fetchTaskLogs,
  createTask,
  updateTask,
  cancelTask,
  rerunTask,
  approveTask,
  rejectTask,
  fetchTemplates,
  fetchTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  fetchSchedules,
  fetchSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  fetchScheduleTasks,
  fetchWorkspaces,
  fetchWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addProjectToWorkspace,
  removeProjectFromWorkspace,
  fetchWorkspaceDashboard,
  fetchWorkspaceDependencyGraph,
  fetchProjects,
  fetchProject,
  createProject,
  updateProject,
  deleteProject,
  fetchProjectTree,
  createMilestone,
  deleteMilestone,
  updateMilestone,
  createSlice,
  deleteSlice,
  updateSlice,
  createPlanTask,
  deletePlanTask,
  updatePlanTask,
  activateSlice,
  startAutoExecute,
  stopAutoExecute,
  fetchAutoExecStatus,
  fetchExecutionGraph,
  fetchProjectExecutionOverview,
  fetchProjectSchedules,
  createChat,
  fetchChats,
  fetchChat,
  fetchEntityChat,
  sendMessage,
  streamMessage,
  deleteChat,
  updateChat,
  fetchChatMetrics,
  generatePlan,
  fetchGeneratePlanStatus,
  fetchUsageSummary,
  fetchUsageBreakdown,
  fetchTaskStats,
  fetchProjectStats,
  fetchAIKeys,
  createAIKey,
  updateAIKey,
  deleteAIKey,
  fetchMeta,
  updateMetaDefaults,
  fetchPlanFile,
  updatePlanFile,
  startAutoExecuteAll,
  fetchBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
  fetchProjectConfig,
  updateProjectConfig,
  fetchWorkspaceConfig,
  updateWorkspaceConfig,
  fetchProjectAgentsMd,
  updateProjectAgentsMd,
  fetchWorkspaceAgentsMd,
  updateWorkspaceAgentsMd,
  fetchGlobalSkills,
  fetchWorkspaceSkills,
  fetchProjectSkills,
  createGlobalSkill,
  createWorkspaceSkill,
  createProjectSkill,
  deleteWorkspaceSkill,
  deleteProjectSkill,
  fetchGlobalMcpServers,
  fetchWorkspaceMcpServers,
  fetchProjectMcpServers,
  createGlobalMcpServer,
  createWorkspaceMcpServer,
  createProjectMcpServer,
  deleteGlobalMcpServer,
  deleteWorkspaceMcpServer,
  deleteProjectMcpServer,
  fetchWorkspaceDisabledSkills,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  fetchProjectDisabledSkills,
  disableProjectSkill,
  enableProjectSkill,
  fetchWorkspaceDisabledMcpServers,
  disableWorkspaceMcpServer,
  enableWorkspaceMcpServer,
  fetchProjectDisabledMcpServers,
  disableProjectMcpServer,
  enableProjectMcpServer,
  fetchGlobalSecrets,
  upsertGlobalSecret,
  deleteGlobalSecret,
  fetchWorkspaceSecrets,
  upsertWorkspaceSecret,
  deleteWorkspaceSecret,
  fetchProjectSecrets,
  upsertProjectSecret,
  deleteProjectSecret,
  fetchMetricsOverview,
  fetchPendingChatPermissions,
} from "./api";

// --- Query keys ---

export const queryKeys = {
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  taskLogs: (id: string) => ["tasks", id, "logs"] as const,
  templates: ["templates"] as const,
  template: (id: string) => ["templates", id] as const,
  schedules: ["schedules"] as const,
  schedule: (id: string) => ["schedules", id] as const,
  scheduleTasks: (id: string) => ["schedules", id, "tasks"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspaces", id] as const,
  workspaceDashboard: (id: string) => ["workspaces", id, "dashboard"] as const,
  workspaceDependencyGraph: (id: string) => ["workspaces", id, "dependency-graph"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  projectTree: (id: string) => ["projects", id, "tree"] as const,
  generatePlanStatus: (projectId: string) =>
    ["projects", projectId, "generate-plan", "status"] as const,
  autoExecStatus: (projectId: string, milestoneId: string) =>
    ["projects", projectId, "milestones", milestoneId, "auto-exec"] as const,
  projectSchedules: (projectId: string) =>
    ["projects", projectId, "schedules"] as const,
  executionGraph: (projectId: string, milestoneId: string) =>
    ["projects", projectId, "milestones", milestoneId, "execution-graph"] as const,
  executionOverview: (projectId: string) =>
    ["projects", projectId, "execution-overview"] as const,
  chats: ["chats"] as const,
  chat: (id: string) => ["chats", id] as const,
  usageSummary: (params: Record<string, string | undefined>) =>
    ["usage-summary", params] as const,
  usageBreakdown: (params: Record<string, string | undefined>) =>
    ["usage-breakdown", params] as const,
  aiKeys: ["ai-keys"] as const,
  meta: ["meta"] as const,
  taskStats: (projectId?: string) => ["task-stats", projectId] as const,
  projectStats: (id: string) => ["projects", id, "stats"] as const,
  planFile: (projectId: string, type: string, entityId: string) =>
    ["projects", projectId, "plan-file", type, entityId] as const,
  budgets: ["budgets"] as const,
  projectConfig: (id: string) => ["projects", id, "config"] as const,
  workspaceConfig: (id: string) => ["workspaces", id, "config"] as const,
  projectAgentsMd: (id: string) => ["projects", id, "agents-md"] as const,
  workspaceAgentsMd: (id: string) => ["workspaces", id, "agents-md"] as const,
  globalSkills: ["skills", "global"] as const,
  workspaceSkills: (id: string) => ["skills", "workspace", id] as const,
  projectSkills: (wsId: string, pId: string) => ["skills", "project", wsId, pId] as const,
  globalMcpServers: ["mcp", "global"] as const,
  workspaceMcpServers: (id: string) => ["mcp", "workspace", id] as const,
  projectMcpServers: (wsId: string, pId: string) => ["mcp", "project", wsId, pId] as const,
  workspaceDisabledSkills: (id: string) => ["skills", "workspace", id, "disabled"] as const,
  projectDisabledSkills: (pid: string) => ["skills", "project", pid, "disabled"] as const,
  workspaceDisabledMcpServers: (id: string) => ["mcp", "workspace", id, "disabled"] as const,
  projectDisabledMcpServers: (pid: string) => ["mcp", "project", pid, "disabled"] as const,
  globalSecrets: ["secrets", "global"] as const,
  workspaceSecrets: (id: string) => ["secrets", "workspace", id] as const,
  projectSecrets: (id: string) => ["secrets", "project", id] as const,
  metricsOverview: (params: Record<string, string | undefined>) =>
    ["metrics-overview", params] as const,
};

// --- Task hooks ---

export function useTasks(
  offset = 0,
  limit = 50,
  filters?: TaskFilters,
  options?: Partial<UseQueryOptions<PaginatedResponse<Task>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.tasks, { offset, limit, ...filters }],
    queryFn: () => fetchTasks(offset, limit, filters),
    ...options,
  });
}

export function useTask(
  taskId: string,
  options?: Partial<UseQueryOptions<Task>>,
) {
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => fetchTask(taskId),
    enabled: !!taskId,
    ...options,
  });
}

export function useTaskLogs(
  taskId: string,
  options?: Partial<UseQueryOptions<TaskLog[]>>,
) {
  return useQuery({
    queryKey: queryKeys.taskLogs(taskId),
    queryFn: () => fetchTaskLogs(taskId),
    enabled: !!taskId,
    ...options,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TaskCreate) => createTask(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => cancelTask(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useRerunTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => rerunTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useApproveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => approveTask(taskId, note),
    onSuccess: (_result, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useRejectTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => rejectTask(taskId, note),
    onSuccess: (_result, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

// --- Permission request type ---

interface PermissionRequestUI {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  title: string | null;
  display_name: string | null;
  description: string | null;
  decision_reason: string | null;
  tool_use_id: string;
}

// --- Live log stream hook ---

export function useTaskLogStream(taskId: string) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [metrics, setMetrics] = useState<TaskMetrics | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequestUI[]>([]);
  const seenIds = useRef(new Set<string>());
  const queryClient = useQueryClient();

  // Fetch historical logs
  const {
    data: historicalLogs,
    isLoading,
    error,
  } = useTaskLogs(taskId);

  // Seed logs from REST response
  useEffect(() => {
    if (historicalLogs) {
      seenIds.current = new Set(historicalLogs.map((l) => l.id));
      setLogs(historicalLogs);
    }
  }, [historicalLogs]);

  // Stable onMessage ref to avoid WebSocket reconnects
  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback(
    (msg: WSMessage) => {
      // Backend sends { type, payload: {...} } or flat { type, ...fields }
      const data = (msg.payload ?? msg) as Record<string, unknown>;
      if (msg.type === "log_line") {
        const logId =
          String(data.id ?? `ws-${data.timestamp ?? Date.now()}`);
        if (!seenIds.current.has(logId)) {
          seenIds.current.add(logId);
          const newLog: TaskLog = {
            id: logId,
            task_id: String(data.task_id ?? taskId),
            content: String(data.content ?? ""),
            stream_type: String(data.stream_type ?? "stdout"),
            timestamp:
              String(data.timestamp ?? new Date().toISOString()),
          };
          setLogs((prev) => [...prev, newLog]);
        }
      } else if (msg.type === "task_metrics" || (msg as any).type === "task_metrics") {
        setMetrics({
          input_tokens: Number(data.input_tokens ?? 0),
          output_tokens: Number(data.output_tokens ?? 0),
          cache_creation_tokens: Number(data.cache_creation_tokens ?? 0),
          cache_read_tokens: Number(data.cache_read_tokens ?? 0),
          total_cost_usd: Number(data.total_cost_usd ?? 0),
          turns: Number(data.turns ?? 0),
          duration_ms: Number(data.duration_ms ?? 0),
        });
        // Also invalidate usage queries so the Cost card updates
        queryClient.invalidateQueries({
          queryKey: queryKeys.usageSummary({ task_id: taskId }),
        });
      } else if (msg.type === "permission_request") {
        const req: PermissionRequestUI = {
          request_id: String(data.request_id),
          tool_name: String(data.tool_name),
          tool_input: (data.tool_input as Record<string, unknown>) ?? {},
          title: data.title ? String(data.title) : null,
          display_name: data.display_name ? String(data.display_name) : null,
          description: data.description ? String(data.description) : null,
          decision_reason: data.decision_reason ? String(data.decision_reason) : null,
          tool_use_id: String(data.tool_use_id ?? ""),
        };
        setPermissionRequests((prev) => [...prev, req]);
      } else if (
        msg.type === "task_started" ||
        msg.type === "task_done" ||
        msg.type === "task_status"
      ) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.task(taskId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.usageSummary({ task_id: taskId }),
        });
      }
    },
    [taskId, queryClient],
  );

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  const { state: connectionState } = useWebSocket({
    path: `/ws/ui/tasks/${taskId}/logs`,
    onMessage: stableOnMessage,
    enabled: !!taskId,
  });

  // Refetch task status when WebSocket reconnects (handles missed messages)
  const prevConnectionState = useRef(connectionState);
  useEffect(() => {
    if (
      prevConnectionState.current !== "open" &&
      connectionState === "open"
    ) {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.usageSummary({ task_id: taskId }),
      });
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, taskId, queryClient]);

  const dismissPermissionRequest = useCallback((requestId: string) => {
    setPermissionRequests((prev) => prev.filter((r) => r.request_id !== requestId));
  }, []);

  return { logs, metrics, permissionRequests, dismissPermissionRequest, isLoading, error, connectionState };
}

// --- Template hooks ---

export function useTemplates(
  offset = 0,
  limit = 50,
  projectId?: string,
  options?: Partial<UseQueryOptions<PaginatedResponse<TaskTemplate>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.templates, { offset, limit, projectId }],
    queryFn: () => fetchTemplates(offset, limit, projectId),
    ...options,
  });
}

export function useTemplate(
  templateId: string,
  options?: Partial<UseQueryOptions<TaskTemplate>>,
) {
  return useQuery({
    queryKey: queryKeys.template(templateId),
    queryFn: () => fetchTemplate(templateId),
    enabled: !!templateId,
    ...options,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TaskTemplateCreate) => createTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<TaskTemplateCreate>;
    }) => updateTemplate(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.template(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}

// --- Schedule hooks ---

export function useSchedules(
  offset = 0,
  limit = 50,
  filters?: ScheduleFilters,
  options?: Partial<UseQueryOptions<PaginatedResponse<Schedule>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.schedules, { offset, limit, ...filters }],
    queryFn: () => fetchSchedules(offset, limit, filters),
    ...options,
  });
}

export function useSchedule(
  scheduleId: string,
  options?: Partial<UseQueryOptions<Schedule>>,
) {
  return useQuery({
    queryKey: queryKeys.schedule(scheduleId),
    queryFn: () => fetchSchedule(scheduleId),
    enabled: !!scheduleId,
    ...options,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ScheduleCreate) => createSchedule(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<ScheduleCreate>;
    }) => updateSchedule(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function usePauseSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pauseSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useResumeSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => resumeSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useScheduleTasks(
  scheduleId: string,
  offset = 0,
  limit = 20,
  options?: Partial<UseQueryOptions<PaginatedResponse<Task>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.scheduleTasks(scheduleId), { offset, limit }],
    queryFn: () => fetchScheduleTasks(scheduleId, offset, limit),
    enabled: !!scheduleId,
    ...options,
  });
}

export function useTriggerSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => triggerSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduleTasks(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

// --- Project Schedule hooks ---

export function useProjectSchedules(
  projectId: string,
  offset = 0,
  limit = 50,
  options?: Partial<UseQueryOptions<PaginatedResponse<Schedule>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.projectSchedules(projectId), { offset, limit }],
    queryFn: () => fetchProjectSchedules(projectId, offset, limit),
    enabled: !!projectId,
    ...options,
  });
}

// --- Workspace hooks ---

export function useWorkspaces(
  options?: Partial<UseQueryOptions<Workspace[]>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => fetchWorkspaces(),
    ...options,
  });
}

export function useWorkspace(
  id: string,
  options?: Partial<UseQueryOptions<WorkspaceWithProjects>>,
) {
  return useQuery({
    queryKey: queryKeys.workspace(id),
    queryFn: () => fetchWorkspace(id),
    enabled: !!id,
    ...options,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkspaceCreate) => createWorkspace(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkspaceUpdate }) =>
      updateWorkspace(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useAddProjectToWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      projectId,
    }: {
      workspaceId: string;
      projectId: string;
    }) => addProjectToWorkspace(workspaceId, projectId),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
    },
  });
}

export function useRemoveProjectFromWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      projectId,
    }: {
      workspaceId: string;
      projectId: string;
    }) => removeProjectFromWorkspace(workspaceId, projectId),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
    },
  });
}

export function useWorkspaceDashboard(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceDashboard>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceDashboard(workspaceId),
    queryFn: () => fetchWorkspaceDashboard(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    ...options,
  });
}

export function useWorkspaceDependencyGraph(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceDependencyGraph>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceDependencyGraph(workspaceId),
    queryFn: () => fetchWorkspaceDependencyGraph(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    ...options,
  });
}

// --- Project hooks ---

export function useProjects(
  options?: Partial<UseQueryOptions<Project[]>>,
) {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => fetchProjects(),
    ...options,
  });
}

export function useProject(
  id: string,
  options?: Partial<UseQueryOptions<Project>>,
) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => fetchProject(id),
    enabled: !!id,
    ...options,
  });
}

export function useProjectTree(
  id: string,
  options?: Partial<UseQueryOptions<ProjectTree>>,
) {
  return useQuery({
    queryKey: queryKeys.projectTree(id),
    queryFn: () => fetchProjectTree(id),
    enabled: !!id,
    ...options,
  });
}

export function useAutoExecStatus(
  projectId: string,
  milestoneId: string,
  options?: Partial<UseQueryOptions<AutoExecuteStatusResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
    queryFn: () => fetchAutoExecStatus(projectId, milestoneId),
    enabled: !!projectId && !!milestoneId,
    ...options,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectCreate) => createProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProjectUpdate }) =>
      updateProject(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useCreateMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MilestoneCreate) => createMilestone(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useGeneratePlan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: GeneratePlanRequest) => generatePlan(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.generatePlanStatus(projectId),
      });
    },
  });
}

export function useGeneratePlanStatus(
  projectId: string,
  options?: Partial<UseQueryOptions<GeneratePlanStatus>>,
) {
  return useQuery<GeneratePlanStatus>({
    queryKey: queryKeys.generatePlanStatus(projectId),
    queryFn: () => fetchGeneratePlanStatus(projectId),
    refetchInterval: (query) =>
      query.state.data?.generating ? 3_000 : 15_000,
    ...options,
  });
}

export function useDeleteMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) =>
      deleteMilestone(projectId, milestoneId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdateMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data: MilestoneUpdate;
    }) => updateMilestone(projectId, milestoneId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useCreateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data: PlanSliceCreate;
    }) => createSlice(projectId, milestoneId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useDeleteSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
    }: {
      milestoneId: string;
      sliceId: string;
    }) => deleteSlice(projectId, milestoneId, sliceId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data: PlanSliceUpdate;
    }) => updateSlice(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useCreatePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data: PlanTaskCreate;
    }) => createPlanTask(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useDeletePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      taskId,
    }: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
    }) => deletePlanTask(projectId, milestoneId, sliceId, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdatePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      taskId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
      data: PlanTaskUpdate;
    }) => updatePlanTask(projectId, milestoneId, sliceId, taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useActivateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data?: ActivateRequest;
    }) => activateSlice(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useStartAutoExecute(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data?: AutoExecuteRequest;
    }) => startAutoExecute(projectId, milestoneId, data),
    onSuccess: (_result, { milestoneId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
      });
    },
  });
}

export function useStopAutoExecute(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) =>
      stopAutoExecute(projectId, milestoneId),
    onSuccess: (_result, milestoneId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
      });
    },
  });
}

// --- Plan File hooks ---

export function usePlanFile(
  projectId: string,
  params: { type: string; milestone?: string; slice?: string; task?: string },
  options?: Partial<UseQueryOptions<{ content: string; path: string }>>,
) {
  return useQuery({
    queryKey: queryKeys.planFile(projectId, params.type, params.milestone ?? params.slice ?? params.task ?? ""),
    queryFn: () => fetchPlanFile(projectId, params),
    enabled: !!projectId && !!params.type,
    ...options,
  });
}

export function useUpdatePlanFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; milestone?: string; slice?: string; task?: string; content: string }) =>
      updatePlanFile(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

// --- Auto-Execute All hook ---

export function useStartAutoExecuteAll(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startAutoExecuteAll(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

// --- Execution Graph hook ---

export function useExecutionGraph(
  projectId: string,
  milestoneId: string,
  options?: Partial<UseQueryOptions<ExecutionGraphResponse>> & {
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: queryKeys.executionGraph(projectId, milestoneId),
    queryFn: () => fetchExecutionGraph(projectId, milestoneId),
    enabled: !!projectId && !!milestoneId,
    ...options,
  });
}

export function useProjectExecutionOverview(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectExecutionOverviewResponse>> & {
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: queryKeys.executionOverview(projectId),
    queryFn: () => fetchProjectExecutionOverview(projectId),
    enabled: !!projectId,
    ...options,
  });
}

// --- Chat hooks ---

export function useChats(
  projectId?: string,
  options?: Partial<UseQueryOptions<ChatResponse[]>>,
) {
  return useQuery({
    queryKey: [...queryKeys.chats, { projectId }],
    queryFn: () => fetchChats({ projectId }),
    ...options,
  });
}

export function useEntityChat(
  projectId: string | undefined,
  entityType: string | undefined,
  entityId: string | undefined,
) {
  return useQuery({
    queryKey: ["entityChat", projectId, entityType, entityId],
    queryFn: () => fetchEntityChat(projectId!, entityType!, entityId!),
    enabled: !!projectId && !!entityType && !!entityId,
  });
}

export function useChat(
  chatId: string | null,
  options?: Partial<UseQueryOptions<ChatDetailResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.chat(chatId!),
    queryFn: () => fetchChat(chatId!),
    enabled: !!chatId,
    ...options,
  });
}

export function useCreateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ChatCreate) => createChat(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

export function useSendMessage(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ChatMessageCreate) => sendMessage(chatId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    },
  });
}

export function useDeleteChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => deleteChat(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

export function useUpdateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: ChatUpdate }) =>
      updateChat(chatId, data),
    onSuccess: (_, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: TaskUpdate }) =>
      updateTask(taskId, data),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useChatMetrics(chatId: string | null) {
  return useQuery({
    queryKey: ["chatMetrics", chatId],
    queryFn: () => fetchChatMetrics(chatId!),
    enabled: !!chatId,
  });
}

export function useChatEventStream(chatId: string | null) {
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequestUI[]>([]);
  const [sessionRunning, setSessionRunning] = useState<boolean | null>(null);
  const queryClient = useQueryClient();

  // Reset live session flag when switching chats — otherwise a previous chat's
  // running state leaks into a new selection until the first WS event arrives.
  useEffect(() => {
    setSessionRunning(null);
    setPermissionRequests([]);
  }, [chatId]);

  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback((msg: WSMessage) => {
    const raw = msg as unknown as Record<string, unknown>;
    // Messages from broadcastChat carry a top-level `chatId` — filter on it so
    // cross-chat events don't leak into this stream.
    if (!chatId || String(raw.chatId ?? "") !== chatId) return;
    const data = (msg.payload ?? msg) as Record<string, unknown>;
    if (msg.type === "permission_request") {
      const req: PermissionRequestUI = {
        request_id: String(data.request_id),
        tool_name: String(data.tool_name),
        tool_input: (data.tool_input as Record<string, unknown>) ?? {},
        title: data.title ? String(data.title) : null,
        display_name: data.display_name ? String(data.display_name) : null,
        description: data.description ? String(data.description) : null,
        decision_reason: data.decision_reason ? String(data.decision_reason) : null,
        tool_use_id: String(data.tool_use_id ?? ""),
      };
      setPermissionRequests((prev) =>
        prev.some((r) => r.request_id === req.request_id) ? prev : [...prev, req],
      );
    } else if (msg.type === "session_started") {
      setSessionRunning(true);
    } else if (msg.type === "session_ended") {
      setSessionRunning(false);
      // Session finished on the server — the assistant message is now persisted.
      // Refetch the chat so the stored message appears even if the client's SSE
      // stream was interrupted (e.g. the page was closed mid-response).
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    }
  }, [chatId, queryClient]);

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  useWebSocket({
    path: chatId ? `/ws/ui/chats/${chatId}/events` : "",
    onMessage: stableOnMessage,
    enabled: !!chatId,
  });

  const dismissPermissionRequest = useCallback((requestId: string) => {
    setPermissionRequests((prev) => prev.filter((r) => r.request_id !== requestId));
  }, []);

  return { permissionRequests, dismissPermissionRequest, sessionRunning };
}

export function useChatStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toolExecutions, setToolExecutions] = useState<ToolExecution[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastInvalidationRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const queryClient = useQueryClient();

  // Track unmount to suppress errors from background streams
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const startStream = useCallback(async (chatId: string, data: ChatMessageCreate, opts?: { projectId?: string }) => {
    setIsStreaming(true);
    setStreamedContent('');
    setError(null);
    setToolExecutions([]);
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    // Optimistic update: show the user message immediately
    queryClient.setQueryData(queryKeys.chat(chatId), (old: ChatDetailResponse | undefined) => {
      if (!old) return old;
      const optimisticMsg: ChatMessageResponse = {
        id: `optimistic-${Date.now()}`,
        chat_id: chatId,
        role: 'user' as const,
        content: data.content,
        created_at: new Date().toISOString(),
      };
      return { ...old, messages: [...old.messages, optimisticMsg] };
    });

    try {
      const res = await streamMessage(chatId, data, signal);
      if (!res.ok) throw new Error(`Stream failed: ${res.status}`);
      if (!res.body) throw new Error("Response body is null");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let json;
          try {
            json = JSON.parse(line.slice(6));
          } catch {
            console.warn("Failed to parse SSE data:", line);
            continue;
          }
          if ('error' in json) { setError(json.error); break; }
          if ('done' in json) {
            queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
            queryClient.invalidateQueries({ queryKey: queryKeys.chats });
            queryClient.invalidateQueries({ queryKey: ["entityChat"] });
            if (opts?.projectId) {
              queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
            }
            break;
          }
          if ('content' in json) setStreamedContent(prev => prev + json.content);
          if ('tool_use' in json) {
            const tu = json.tool_use;
            setToolExecutions(prev => [...prev, {
              id: tu.id,
              name: tu.name,
              input: tu.input,
              status: 'pending',
            }]);
          }
          if ('tool_result' in json) {
            const tr = json.tool_result;
            setToolExecutions(prev => prev.map(te =>
              te.id === tr.tool_use_id
                ? {
                    ...te,
                    status: tr.result.success ? 'success' : 'error',
                    result: tr.result.result,
                    error: tr.result.error,
                  }
                : te
            ));
            const now = Date.now();
            if (now - lastInvalidationRef.current >= 1000) {
              lastInvalidationRef.current = now;
              if (opts?.projectId) {
                queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
              }
            }
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError' && mountedRef.current) setError(e.message);
    } finally {
      if (mountedRef.current) setIsStreaming(false);
      abortRef.current = null;
      if (opts?.projectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
      }
    }
  }, [queryClient]);

  const cancelStream = useCallback(() => { abortRef.current?.abort(); }, []);

  const clearChat = useCallback(() => {
    setStreamedContent('');
    setError(null);
    setToolExecutions([]);
  }, []);

  return { startStream, cancelStream, clearChat, isStreaming, streamedContent, error, toolExecutions };
}

/** Alias for useChatStream — used in plan-entity chat dialogs. */
export const usePlanChatStream = useChatStream;

// --- Usage hooks ---

export function useUsageSummary(
  params: {
    project_id?: string;
    user_id?: string;
    task_id?: string;
    chat_id?: string;
    period?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<UsageSummary>>,
) {
  return useQuery({
    queryKey: queryKeys.usageSummary(params),
    queryFn: () => fetchUsageSummary(params),
    ...options,
  });
}

export function useUsageBreakdown(
  params: {
    group_by: string;
    project_id?: string;
    user_id?: string;
    task_id?: string;
    chat_id?: string;
    period?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.usageBreakdown(params),
    queryFn: () => fetchUsageBreakdown(params),
    ...options,
  });
}

// --- Task Stats hook ---

export function useTaskStats(
  projectId?: string,
  options?: Partial<UseQueryOptions<TaskStats>>,
) {
  return useQuery({
    queryKey: queryKeys.taskStats(projectId),
    queryFn: () => fetchTaskStats(projectId),
    refetchInterval: 30_000,
    ...options,
  });
}

// --- Project Stats hook ---

export function useProjectStats(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectStats>>,
) {
  return useQuery({
    queryKey: queryKeys.projectStats(projectId),
    queryFn: () => fetchProjectStats(projectId),
    enabled: !!projectId,
    refetchInterval: 30_000,
    ...options,
  });
}

// --- AI Key hooks ---

export function useAIKeys() {
  return useQuery({
    queryKey: queryKeys.aiKeys,
    queryFn: () => fetchAIKeys().then((res) => res.items),
  });
}

export function useCreateAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAIKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

export function useUpdateAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, data }: { keyId: string; data: { is_active?: boolean; label?: string; config_dir?: string } }) =>
      updateAIKey(keyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

export function useDeleteAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => deleteAIKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

// --- Budget hooks ---

export function useBudgets() {
  return useQuery({
    queryKey: queryKeys.budgets,
    queryFn: fetchBudgets,
  });
}

export function useCreateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { scope: string; scope_id?: number | null; period: string; limit_usd: number; action?: string }) =>
      createBudget(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}

export function useUpdateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { limit_usd?: number; action?: string; is_active?: boolean } }) =>
      updateBudget(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}

export function useDeleteBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteBudget(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}

// --- Project Config hooks ---

export function useProjectConfig(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectConfig(projectId),
    queryFn: () => fetchProjectConfig(projectId),
    enabled: !!projectId,
  });
}

export function useUpdateProjectConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: string; config: Record<string, any> }) =>
      updateProjectConfig(projectId, config),
    onSuccess: (_result, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectConfig(projectId) });
    },
  });
}

// --- Workspace Config hooks ---

export function useWorkspaceConfig(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceConfig(workspaceId),
    queryFn: () => fetchWorkspaceConfig(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useUpdateWorkspaceConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, config }: { workspaceId: string; config: Record<string, any> }) =>
      updateWorkspaceConfig(workspaceId, config),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfig(workspaceId) });
    },
  });
}

// --- AGENTS.md hooks ---

export function useProjectAgentsMd(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectAgentsMd(projectId),
    queryFn: () => fetchProjectAgentsMd(projectId),
    enabled: !!projectId,
  });
}

export function useUpdateProjectAgentsMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, content }: { projectId: string; content: string }) =>
      updateProjectAgentsMd(projectId, content),
    onSuccess: (_result, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectAgentsMd(projectId) });
    },
  });
}

export function useWorkspaceAgentsMd(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceAgentsMd(workspaceId),
    queryFn: () => fetchWorkspaceAgentsMd(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useUpdateWorkspaceAgentsMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, content }: { workspaceId: string; content: string }) =>
      updateWorkspaceAgentsMd(workspaceId, content),
    onSuccess: (_result, { workspaceId }) => {
      // Workspace edits cascade to all child projects, so invalidate broadly.
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAgentsMd(workspaceId) });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

// --- Meta hooks ---

export function useMeta() {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: fetchMeta,
    staleTime: 60_000, // re-check every 60s
  });
}

export function useUpdateMetaDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { default_model?: string | null; default_key_id?: number | null }) =>
      updateMetaDefaults(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.meta });
    },
  });
}

// --- Skills hooks ---

export function useGlobalSkills() {
  return useQuery({
    queryKey: queryKeys.globalSkills,
    queryFn: fetchGlobalSkills,
  });
}

export function useWorkspaceSkills(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceSkills(workspaceId),
    queryFn: () => fetchWorkspaceSkills(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectSkills(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectSkills(workspaceId, projectId),
    queryFn: () => fetchProjectSkills(workspaceId, projectId),
    enabled: !!workspaceId && !!projectId,
  });
}

export function useCreateGlobalSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createGlobalSkill(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalSkills }); },
  });
}

export function useCreateWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createWorkspaceSkill(workspaceId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills(workspaceId) }); },
  });
}

export function useCreateProjectSkill(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createProjectSkill(workspaceId, projectId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectSkills(workspaceId, projectId) }); },
  });
}

export function useDeleteWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSkill(workspaceId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills(workspaceId) }); },
  });
}

export function useDeleteProjectSkill(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectSkill(workspaceId, projectId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectSkills(workspaceId, projectId) }); },
  });
}

// --- MCP Server hooks ---

export function useGlobalMcpServers() {
  return useQuery({
    queryKey: queryKeys.globalMcpServers,
    queryFn: fetchGlobalMcpServers,
  });
}

export function useWorkspaceMcpServers(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceMcpServers(workspaceId),
    queryFn: () => fetchWorkspaceMcpServers(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectMcpServers(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectMcpServers(workspaceId, projectId),
    queryFn: () => fetchProjectMcpServers(workspaceId, projectId),
    enabled: !!workspaceId && !!projectId,
  });
}

export function useCreateGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("./types").McpServerConfig }) => createGlobalMcpServer(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalMcpServers }); },
  });
}

export function useCreateWorkspaceMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("./types").McpServerConfig }) => createWorkspaceMcpServer(workspaceId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMcpServers(workspaceId) }); },
  });
}

export function useCreateProjectMcpServer(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("./types").McpServerConfig }) => createProjectMcpServer(workspaceId, projectId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectMcpServers(workspaceId, projectId) }); },
  });
}

export function useDeleteGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteGlobalMcpServer(name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalMcpServers }); },
  });
}

export function useDeleteWorkspaceMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceMcpServer(workspaceId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMcpServers(workspaceId) }); },
  });
}

export function useDeleteProjectMcpServer(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectMcpServer(workspaceId, projectId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectMcpServers(workspaceId, projectId) }); },
  });
}

// --- Disabled skill/mcp list hooks ---

export function useWorkspaceDisabledSkills(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceDisabledSkills(workspaceId),
    queryFn: () => fetchWorkspaceDisabledSkills(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useToggleWorkspaceDisabledSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("./types").DisableLevel; disable: boolean }) =>
      disable
        ? disableWorkspaceSkill(workspaceId, { name, level })
        : enableWorkspaceSkill(workspaceId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDisabledSkills(workspaceId) }); },
  });
}

export function useProjectDisabledSkills(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectDisabledSkills(projectId),
    queryFn: () => fetchProjectDisabledSkills(projectId),
    enabled: !!projectId,
  });
}

export function useToggleProjectDisabledSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("./types").DisableLevel; disable: boolean }) =>
      disable
        ? disableProjectSkill(projectId, { name, level })
        : enableProjectSkill(projectId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectDisabledSkills(projectId) }); },
  });
}

export function useWorkspaceDisabledMcpServers(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceDisabledMcpServers(workspaceId),
    queryFn: () => fetchWorkspaceDisabledMcpServers(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useToggleWorkspaceDisabledMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("./types").DisableLevel; disable: boolean }) =>
      disable
        ? disableWorkspaceMcpServer(workspaceId, { name, level })
        : enableWorkspaceMcpServer(workspaceId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDisabledMcpServers(workspaceId) }); },
  });
}

export function useProjectDisabledMcpServers(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectDisabledMcpServers(projectId),
    queryFn: () => fetchProjectDisabledMcpServers(projectId),
    enabled: !!projectId,
  });
}

export function useToggleProjectDisabledMcpServer(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("./types").DisableLevel; disable: boolean }) =>
      disable
        ? disableProjectMcpServer(projectId, { name, level })
        : enableProjectMcpServer(projectId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectDisabledMcpServers(projectId) }); },
  });
}

// --- Metrics hooks ---

export function useMetricsOverview(
  params: {
    period?: string;
    date_from?: string;
    date_to?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<MetricsOverview>>,
) {
  return useQuery({
    queryKey: queryKeys.metricsOverview(params),
    queryFn: () => fetchMetricsOverview(params),
    refetchInterval: 60_000,
    ...options,
  });
}

// --- Chat list live state (running + pending approvals per chat) ---

export interface ChatListLiveState {
  /** chatId → number of pending permission requests awaiting UI response */
  pendingCount: Record<string, number>;
  /** chatId → whether a chat session is currently active on the server */
  running: Record<string, boolean>;
}

/**
 * Subscribes to the global chat event stream and tracks live per-chat state
 * for the chat list: whether a session is running and how many permission
 * requests are waiting for the user. Seeded from GET /chats/pending-permissions
 * so reloads mid-session still show the right indicators.
 */
export function useChatListLiveState(enabled = true): ChatListLiveState {
  const [pendingCount, setPendingCount] = useState<Record<string, number>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();

  // Seed + refetch whenever the hook is (re-)enabled.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPendingChatPermissions()
      .then((snap) => {
        if (cancelled) return;
        setPendingCount(snap.pending ?? {});
        const runMap: Record<string, boolean> = {};
        for (const id of snap.running ?? []) runMap[id] = true;
        setRunning(runMap);
      })
      .catch(() => { /* non-fatal — WS will fill in state as events arrive */ });
    return () => { cancelled = true; };
  }, [enabled]);

  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback((msg: WSMessage) => {
    const raw = msg as unknown as Record<string, unknown>;
    const chatId = raw.chatId != null ? String(raw.chatId) : null;
    if (!chatId) return;

    if (msg.type === "session_started") {
      setRunning((prev) => (prev[chatId] ? prev : { ...prev, [chatId]: true }));
    } else if (msg.type === "session_ended") {
      setRunning((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      // A finished session invalidates any outstanding permission requests.
      setPendingCount((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      // Chat list metrics (message count, cost) changed — refresh it.
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    } else if (msg.type === "permission_request") {
      setPendingCount((prev) => ({ ...prev, [chatId]: (prev[chatId] ?? 0) + 1 }));
    } else if (msg.type === "permission_resolved") {
      setPendingCount((prev) => {
        const curr = prev[chatId] ?? 0;
        if (curr <= 0) return prev;
        const next = { ...prev };
        if (curr <= 1) delete next[chatId];
        else next[chatId] = curr - 1;
        return next;
      });
    }
  }, [queryClient]);

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  useWebSocket({
    path: "/ws/ui/chats/events",
    onMessage: stableOnMessage,
    enabled,
  });

  return { pendingCount, running };
}

// --- Secrets hooks ---

export function useGlobalSecrets() {
  return useQuery({
    queryKey: queryKeys.globalSecrets,
    queryFn: fetchGlobalSecrets,
  });
}

export function useWorkspaceSecrets(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceSecrets(workspaceId),
    queryFn: () => fetchWorkspaceSecrets(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectSecrets(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectSecrets(projectId),
    queryFn: () => fetchProjectSecrets(projectId),
    enabled: !!projectId,
  });
}

export function useUpsertGlobalSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertGlobalSecret(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.globalSecrets });
    },
  });
}

export function useUpsertWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertWorkspaceSecret(workspaceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSecrets(workspaceId) });
    },
  });
}

export function useUpsertProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertProjectSecret(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSecrets(projectId) });
    },
  });
}

export function useDeleteGlobalSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteGlobalSecret(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.globalSecrets });
    },
  });
}

export function useDeleteWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSecret(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSecrets(workspaceId) });
    },
  });
}

export function useDeleteProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSecrets(projectId) });
    },
  });
}
