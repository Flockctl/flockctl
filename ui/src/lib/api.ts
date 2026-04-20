import type {
  PaginatedResponse,
  Task,
  TaskLog,
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
  WorkspaceProject,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
  Project,
  ProjectCreate,
  ProjectScan,
  ProjectUpdate,
  ProjectTree,
  Milestone,
  MilestoneCreate,
  MilestoneUpdate,
  PlanSlice,
  PlanSliceCreate,
  PlanSliceUpdate,
  PlanTask,
  PlanTaskCreate,
  PlanTaskUpdate,
  ActivateResponse,
  ActivateRequest,
  AutoExecuteResponse,
  AutoExecuteRequest,
  AutoExecuteStatusResponse,
  ExecutionGraphResponse,
  ProjectExecutionOverviewResponse,
  ChatCreate,
  ChatResponse,
  ChatDetailResponse,
  ChatMessageCreate,
  ChatMessageResponse,
  ChatFullMetrics,
  ChatUpdate,
  GeneratePlanRequest,
  GeneratePlanResponse,
  GeneratePlanStatus,
  UsageSummary,
  UsageBreakdownResponse,
} from "./types";

import {
  getActiveServerId,
  getCachedToken,
  getServerUrl,
  LOCAL_SERVER_ID,
} from "./server-store";

/**
 * Build URL is the local fallback (origin-relative or VITE_API_URL). For
 * remote servers the URL comes from the in-memory ServerContext cache via
 * `getServerUrl(id)`.
 */
const LOCAL_API_URL: string = import.meta.env.VITE_API_URL ?? "";

export function getApiBaseUrl(): string {
  const id = getActiveServerId();
  if (id === LOCAL_SERVER_ID) return LOCAL_API_URL;
  return getServerUrl(id) ?? LOCAL_API_URL;
}

export function getAuthHeaders(): Record<string, string> {
  const id = getActiveServerId();
  if (id === LOCAL_SERVER_ID) return {};
  const token = getCachedToken(id);
  return token ? { Authorization: `Bearer ${token}` } : {};
}


// --- Key conversion utilities ---

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Deep-convert keys camelCase → snake_case and parse JSON-encoded strings */
function toSnakeKeys(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(toSnakeKeys);
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const snakeKey = camelToSnake(k);
      let converted = toSnakeKeys(tryParseJsonString(v));
      // DB returns integer PKs/FKs but frontend types expect string IDs
      if (typeof converted === "number" && (snakeKey === "id" || snakeKey.endsWith("_id"))) {
        converted = String(converted);
      }
      result[snakeKey] = converted;
    }
    return result;
  }
  return val;
}

/** Deep-convert keys snake_case → camelCase (for outgoing request bodies) */
function toCamelKeys(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(toCamelKeys);
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[snakeToCamel(k)] = v;
    }
    return result;
  }
  return val;
}

/** Try to parse a string as JSON array/object; return original if not JSON */
function tryParseJsonString(val: unknown): unknown {
  if (typeof val !== "string" || val.length < 2) return val;
  const c = val[0];
  if (c === "[" || c === "{") {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch { /* not JSON */ }
  }
  return val;
}

// --- Generic API fetcher (no auth — local tool) ---

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { rawKeys?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    ...(options?.headers as Record<string, string>),
  };

  // Convert outgoing body keys: snake_case → camelCase (unless rawKeys)
  let body = options?.body;
  if (typeof body === "string" && !options?.rawKeys) {
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify(toCamelKeys(parsed));
    } catch { /* not JSON, leave as-is */ }
  }

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers,
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errBody.error ?? errBody.detail ?? `API error ${res.status}`);
  }

  // Convert incoming response keys: camelCase → snake_case + parse JSON strings
  const text = await res.text();
  if (!text) return undefined as T;
  const json = JSON.parse(text);
  if (options?.rawKeys) return json as T;
  return toSnakeKeys(json) as T;
}

// --- Tasks ---

export function fetchTasks(
  offset = 0,
  limit = 50,
  filters?: TaskFilters,
): Promise<PaginatedResponse<Task>> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
  }
  return apiFetch(`/tasks?${params.toString()}`);
}

export function fetchTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}`);
}

export function fetchTaskLogs(taskId: string): Promise<TaskLog[]> {
  return apiFetch(`/tasks/${taskId}/logs`);
}

export function fetchTaskDiff(taskId: string): Promise<{
  commit_before: string;
  commit_after: string | null;
  summary: string | null;
  diff: string;
  truncated: boolean;
  total_lines: number;
}> {
  return apiFetch(`/tasks/${taskId}/diff`);
}

export function approveTask(taskId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function rejectTask(taskId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function respondToPermission(
  taskId: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/permission/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ behavior, message }),
  });
}

export function createTask(data: TaskCreate): Promise<Task> {
  return apiFetch("/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTask(taskId: string, data: TaskUpdate): Promise<Task> {
  return apiFetch(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function cancelTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}/cancel`, { method: "POST" });
}

export function rerunTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}/rerun`, { method: "POST" });
}

// --- Templates ---

export function fetchTemplates(
  offset = 0,
  limit = 50,
  projectId?: string,
): Promise<PaginatedResponse<TaskTemplate>> {
  let url = `/templates?offset=${offset}&limit=${limit}`;
  if (projectId) {
    url += `&project_id=${encodeURIComponent(projectId)}`;
  }
  return apiFetch(url);
}

export function fetchTemplate(templateId: string): Promise<TaskTemplate> {
  return apiFetch(`/templates/${templateId}`);
}

export function createTemplate(
  data: TaskTemplateCreate,
): Promise<TaskTemplate> {
  return apiFetch("/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTemplate(
  templateId: string,
  data: Partial<TaskTemplateCreate>,
): Promise<TaskTemplate> {
  return apiFetch(`/templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteTemplate(templateId: string): Promise<void> {
  return apiFetch(`/templates/${templateId}`, { method: "DELETE" });
}

// --- Schedules ---

export function fetchSchedules(
  offset = 0,
  limit = 50,
  filters?: ScheduleFilters,
): Promise<PaginatedResponse<Schedule>> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
  }
  return apiFetch(`/schedules?${params.toString()}`);
}

export function fetchSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}`);
}

export function createSchedule(data: ScheduleCreate): Promise<Schedule> {
  return apiFetch("/schedules", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateSchedule(
  scheduleId: string,
  data: Partial<ScheduleCreate>,
): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteSchedule(scheduleId: string): Promise<void> {
  return apiFetch(`/schedules/${scheduleId}`, { method: "DELETE" });
}

export function pauseSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/pause`, { method: "POST" });
}

export function resumeSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/resume`, { method: "POST" });
}

export function triggerSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/trigger`, { method: "POST" });
}

export function fetchScheduleTasks(
  scheduleId: string,
  offset = 0,
  limit = 20,
): Promise<PaginatedResponse<Task>> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  return apiFetch(`/schedules/${scheduleId}/tasks?${params.toString()}`);
}

export function fetchProjectSchedules(
  projectId: string,
  offset = 0,
  limit = 50,
): Promise<PaginatedResponse<Schedule>> {
  return apiFetch(
    `/projects/${projectId}/schedules?offset=${offset}&limit=${limit}`,
  );
}

// --- Workspaces ---

export function fetchWorkspaces(): Promise<Workspace[]> {
  return apiFetch<PaginatedResponse<Workspace>>("/workspaces").then((r) => r.items);
}

export function fetchWorkspace(id: string): Promise<WorkspaceWithProjects> {
  return apiFetch<WorkspaceWithProjects>(`/workspaces/${id}`);
}

export function createWorkspace(data: WorkspaceCreate): Promise<Workspace> {
  return apiFetch<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateWorkspace(
  id: string,
  data: WorkspaceUpdate,
): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiFetch<void>(`/workspaces/${id}`, { method: "DELETE" });
}

export function addProjectToWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceProject> {
  return apiFetch<WorkspaceProject>(
    `/workspaces/${workspaceId}/projects?project_id=${encodeURIComponent(projectId)}`,
    { method: "POST" },
  );
}

export function removeProjectFromWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<void> {
  return apiFetch<void>(`/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "DELETE",
  });
}

export function fetchWorkspaceDashboard(workspaceId: string): Promise<WorkspaceDashboard> {
  return apiFetch<WorkspaceDashboard>(`/workspaces/${workspaceId}/dashboard`);
}

export function fetchWorkspaceDependencyGraph(workspaceId: string): Promise<WorkspaceDependencyGraph> {
  return apiFetch<WorkspaceDependencyGraph>(`/workspaces/${workspaceId}/dependency-graph`);
}

// --- Projects ---

export function fetchProjects(): Promise<Project[]> {
  return apiFetch<PaginatedResponse<Project>>("/projects").then((r) => r.items);
}

export function fetchProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`);
}

export function createProject(data: ProjectCreate): Promise<Project> {
  return apiFetch<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function scanProjectPath(path: string): Promise<ProjectScan> {
  return apiFetch<ProjectScan>("/projects/scan", {
    method: "POST",
    body: JSON.stringify({ path }),
    rawKeys: true,
  });
}

export function updateProject(
  id: string,
  data: ProjectUpdate,
): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
}

// --- Project Tree ---

export function fetchProjectTree(projectId: string): Promise<ProjectTree> {
  return apiFetch<ProjectTree>(`/projects/${projectId}/tree`);
}

export function generatePlan(
  projectId: string,
  data: GeneratePlanRequest,
): Promise<GeneratePlanResponse> {
  return apiFetch<GeneratePlanResponse>(
    `/projects/${projectId}/generate-plan`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
}

export function fetchGeneratePlanStatus(
  projectId: string,
): Promise<GeneratePlanStatus> {
  return apiFetch<GeneratePlanStatus>(
    `/projects/${projectId}/generate-plan/status`,
  );
}

// --- Milestones ---

export function createMilestone(
  projectId: string,
  data: MilestoneCreate,
): Promise<Milestone> {
  return apiFetch<Milestone>(`/projects/${projectId}/milestones`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteMilestone(
  projectId: string,
  milestoneId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}`,
    { method: "DELETE" },
  );
}

export function updateMilestone(
  projectId: string,
  milestoneId: string,
  data: MilestoneUpdate,
): Promise<Milestone> {
  return apiFetch<Milestone>(
    `/projects/${projectId}/milestones/${milestoneId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Slices ---

export function createSlice(
  projectId: string,
  milestoneId: string,
  data: PlanSliceCreate,
): Promise<PlanSlice> {
  return apiFetch<PlanSlice>(
    `/projects/${projectId}/milestones/${milestoneId}/slices`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function deleteSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}`,
    { method: "DELETE" },
  );
}

export function updateSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data: PlanSliceUpdate,
): Promise<PlanSlice> {
  return apiFetch<PlanSlice>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Plan Tasks ---

export function createPlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data: PlanTaskCreate,
): Promise<PlanTask> {
  return apiFetch<PlanTask>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function deletePlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks/${taskId}`,
    { method: "DELETE" },
  );
}

export function updatePlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  data: PlanTaskUpdate,
): Promise<PlanTask> {
  return apiFetch<PlanTask>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks/${taskId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Execution ---

export function activateSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data?: ActivateRequest,
): Promise<ActivateResponse> {
  return apiFetch<ActivateResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/activate`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );
}

export function startAutoExecute(
  projectId: string,
  milestoneId: string,
  data?: AutoExecuteRequest,
): Promise<AutoExecuteResponse> {
  return apiFetch<AutoExecuteResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );
}

export function stopAutoExecute(
  projectId: string,
  milestoneId: string,
): Promise<AutoExecuteResponse> {
  return apiFetch<AutoExecuteResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
    { method: "DELETE" },
  );
}

export function fetchAutoExecStatus(
  projectId: string,
  milestoneId: string,
): Promise<AutoExecuteStatusResponse> {
  return apiFetch<AutoExecuteStatusResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
  );
}

// --- Plan File Content ---

export function fetchPlanFile(
  projectId: string,
  params: { type: string; milestone?: string; slice?: string; task?: string },
): Promise<{ content: string; path: string }> {
  const qs = new URLSearchParams();
  qs.set("type", params.type);
  if (params.milestone) qs.set("milestone", params.milestone);
  if (params.slice) qs.set("slice", params.slice);
  if (params.task) qs.set("task", params.task);
  return apiFetch<{ content: string; path: string }>(
    `/projects/${projectId}/plan-file?${qs.toString()}`,
  );
}

export function updatePlanFile(
  projectId: string,
  data: { type: string; milestone?: string; slice?: string; task?: string; content: string },
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/projects/${projectId}/plan-file`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// --- Auto-Execute All ---

export function startAutoExecuteAll(
  projectId: string,
): Promise<{ status: string; milestones: string[] }> {
  return apiFetch<{ status: string; milestones: string[] }>(
    `/projects/${projectId}/auto-execute-all`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

// --- Execution Graph ---

export function fetchExecutionGraph(
  projectId: string,
  milestoneId: string,
): Promise<ExecutionGraphResponse> {
  return apiFetch<ExecutionGraphResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/execution-graph`,
  );
}

export function fetchProjectExecutionOverview(
  projectId: string,
): Promise<ProjectExecutionOverviewResponse> {
  return apiFetch<ProjectExecutionOverviewResponse>(
    `/projects/${projectId}/execution-overview`,
  );
}

// --- Chats ---

export function createChat(data: ChatCreate): Promise<ChatResponse> {
  return apiFetch<ChatResponse>("/chats", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function fetchChats(params?: { projectId?: string; entityType?: string; entityId?: string }): Promise<ChatResponse[]> {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set("project_id", params.projectId);
  if (params?.entityType) qs.set("entity_type", params.entityType);
  if (params?.entityId) qs.set("entity_id", params.entityId);
  const query = qs.toString();
  return apiFetch<PaginatedResponse<ChatResponse>>(`/chats${query ? `?${query}` : ""}`).then((r) => r.items);
}

export function fetchEntityChat(projectId: string, entityType: string, entityId: string): Promise<ChatDetailResponse | null> {
  const qs = new URLSearchParams({ project_id: projectId, entity_type: entityType, entity_id: entityId });
  return apiFetch<PaginatedResponse<ChatResponse>>(`/chats?${qs.toString()}`).then((r) => {
    if (r.items.length === 0) return null;
    return apiFetch<ChatDetailResponse>(`/chats/${r.items[0].id}`);
  });
}

export function fetchChat(chatId: string): Promise<ChatDetailResponse> {
  return apiFetch<ChatDetailResponse>(`/chats/${chatId}`);
}

export function sendMessage(
  chatId: string,
  data: ChatMessageCreate,
): Promise<ChatMessageResponse> {
  return apiFetch<ChatMessageResponse>(`/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function streamMessage(
  chatId: string,
  data: ChatMessageCreate,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${getApiBaseUrl()}/chats/${chatId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
    signal,
  });
}

export function deleteChat(chatId: string): Promise<void> {
  return apiFetch<void>(`/chats/${chatId}`, { method: "DELETE" });
}

export function updateChat(chatId: string, data: ChatUpdate): Promise<ChatResponse> {
  return apiFetch<ChatResponse>(`/chats/${chatId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function fetchChatMetrics(chatId: string): Promise<ChatFullMetrics> {
  return apiFetch<ChatFullMetrics>(`/chats/${chatId}/metrics`);
}

export function respondToChatPermission(
  chatId: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/permission/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ behavior, message }),
  });
}

export function cancelChatRun(chatId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/cancel`, { method: "POST" });
}

export interface ChatsLiveState {
  pending: Record<string, number>;
  running: string[];
}

/** Snapshot of in-memory chat sessions: pending permission counts + running chat ids. */
export function fetchPendingChatPermissions(): Promise<ChatsLiveState> {
  return apiFetch<ChatsLiveState>(`/chats/pending-permissions`);
}

// --- Usage ---

export function fetchUsageSummary(params: {
  project_id?: string;
  user_id?: string;
  task_id?: string;
  chat_id?: string;
  period?: string;
  ai_provider_key_id?: string;
}): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch<UsageSummary>(`/usage/summary?${qs.toString()}`);
}

export function fetchUsageBreakdown(params: {
  group_by: string;
  project_id?: string;
  user_id?: string;
  task_id?: string;
  chat_id?: string;
  period?: string;
  ai_provider_key_id?: string;
}): Promise<UsageBreakdownResponse> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch<UsageBreakdownResponse>(`/usage/breakdown?${qs.toString()}`);
}

// --- Task Stats ---

export function fetchTaskStats(projectId?: string): Promise<import("./types").TaskStats> {
  const qs = new URLSearchParams();
  if (projectId) qs.set("project_id", projectId);
  const query = qs.toString();
  return apiFetch(`/tasks/stats${query ? `?${query}` : ""}`);
}

// --- Project Stats ---

export function fetchProjectStats(projectId: string): Promise<import("./types").ProjectStats> {
  return apiFetch(`/projects/${projectId}/stats`);
}

// --- AI Provider Keys ---

export function fetchAIKeys(): Promise<{ items: import("./types").AIProviderKeyResponse[]; total: number }> {
  return apiFetch(`/keys`);
}

export function createAIKey(data: {
  name?: string;
  provider: string;
  provider_type: string;
  cli_command?: string;
  key_value?: string;
  config_dir?: string;
}): Promise<import("./types").AIProviderKeyResponse> {
  return apiFetch(`/keys`, {
    method: "POST",
    body: JSON.stringify({
      provider: data.provider,
      providerType: data.provider_type,
      label: data.name,
      keyValue: data.key_value,
      cliCommand: data.cli_command,
      configDir: data.config_dir,
    }),
  });
}

export function updateAIKey(
  keyId: string,
  data: { is_active?: boolean; label?: string; config_dir?: string },
): Promise<import("./types").AIProviderKeyResponse> {
  return apiFetch(`/keys/${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(data.is_active !== undefined && { isActive: data.is_active }),
      ...(data.label !== undefined && { label: data.label }),
      ...(data.config_dir !== undefined && { configDir: data.config_dir }),
    }),
  });
}

export function deleteAIKey(keyId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/keys/${keyId}`, { method: "DELETE" });
}

// --- Meta ---

export function fetchMeta(): Promise<import("./types").MetaResponse> {
  return apiFetch("/meta");
}

/**
 * Update one or both global defaults. Pass `null` to clear a field; omit to leave
 * it unchanged. Backend responds with the resolved defaults block.
 */
export function updateMetaDefaults(input: {
  default_model?: string | null;
  default_key_id?: number | null;
}): Promise<import("./types").MetaDefaults> {
  return apiFetch("/meta/defaults", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// --- Budget Limits ---

export interface BudgetSummaryItem {
  id: number;
  scope: string;
  scope_id: number | null;
  period: string;
  limit_usd: number;
  spent_usd: number;
  percent_used: number;
  action: string;
}

export function fetchBudgets(): Promise<BudgetSummaryItem[]> {
  return apiFetch("/usage/budgets");
}

export function createBudget(data: {
  scope: string;
  scope_id?: number | null;
  period: string;
  limit_usd: number;
  action?: string;
}): Promise<any> {
  return apiFetch("/usage/budgets", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateBudget(id: number, data: {
  limit_usd?: number;
  action?: string;
  is_active?: boolean;
}): Promise<{ ok: boolean }> {
  return apiFetch(`/usage/budgets/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteBudget(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/usage/budgets/${id}`, { method: "DELETE" });
}

// --- Project Config ---
// Yaml config keys are camelCase on disk; bypass snake_case conversion.

export function fetchProjectConfig(projectId: string): Promise<Record<string, any>> {
  return apiFetch(`/projects/${projectId}/config`, { rawKeys: true });
}

export function updateProjectConfig(projectId: string, config: Record<string, any>): Promise<Record<string, any>> {
  return apiFetch(`/projects/${projectId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
    rawKeys: true,
  });
}

// --- Workspace Config ---

export function fetchWorkspaceConfig(workspaceId: string): Promise<Record<string, any>> {
  return apiFetch(`/workspaces/${workspaceId}/config`, { rawKeys: true });
}

export function updateWorkspaceConfig(workspaceId: string, config: Record<string, any>): Promise<Record<string, any>> {
  return apiFetch(`/workspaces/${workspaceId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
    rawKeys: true,
  });
}

// --- AGENTS.md (per-project and per-workspace agent documentation) ---
// Source = .flockctl/AGENTS.md (editable). Effective = root AGENTS.md (merged).

export interface AgentsMdResponse {
  source: string;
  effective: string;
}

export function fetchProjectAgentsMd(projectId: string): Promise<AgentsMdResponse> {
  return apiFetch(`/projects/${projectId}/agents-md`, { rawKeys: true });
}

export function updateProjectAgentsMd(
  projectId: string,
  content: string,
): Promise<AgentsMdResponse> {
  return apiFetch(`/projects/${projectId}/agents-md`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}

export function fetchWorkspaceAgentsMd(workspaceId: string): Promise<AgentsMdResponse> {
  return apiFetch(`/workspaces/${workspaceId}/agents-md`, { rawKeys: true });
}

export function updateWorkspaceAgentsMd(
  workspaceId: string,
  content: string,
): Promise<AgentsMdResponse> {
  return apiFetch(`/workspaces/${workspaceId}/agents-md`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}

// --- Skills ---

export function fetchGlobalSkills(): Promise<import("./types").Skill[]> {
  return apiFetch("/skills/global");
}

export function fetchWorkspaceSkills(workspaceId: string): Promise<import("./types").Skill[]> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills`);
}

export function fetchProjectSkills(workspaceId: string, projectId: string): Promise<import("./types").Skill[]> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills`);
}

export function createGlobalSkill(data: { name: string; content: string }): Promise<any> {
  return apiFetch("/skills/global", { method: "POST", body: JSON.stringify(data) });
}

export function createWorkspaceSkill(workspaceId: string, data: { name: string; content: string }): Promise<any> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills`, { method: "POST", body: JSON.stringify(data) });
}

export function createProjectSkill(workspaceId: string, projectId: string, data: { name: string; content: string }): Promise<any> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteWorkspaceSkill(workspaceId: string, name: string): Promise<any> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills/${name}`, { method: "DELETE" });
}

export function deleteProjectSkill(workspaceId: string, projectId: string, name: string): Promise<any> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills/${name}`, { method: "DELETE" });
}

// --- Skill disable lists ---

import type { DisableEntry } from "./types";

export function fetchWorkspaceDisabledSkills(workspaceId: string): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`);
}

export function disableWorkspaceSkill(workspaceId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableWorkspaceSkill(workspaceId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`, { method: "DELETE", body: JSON.stringify(entry) });
}

export function fetchProjectDisabledSkills(projectId: string): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`);
}

export function disableProjectSkill(projectId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableProjectSkill(projectId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`, { method: "DELETE", body: JSON.stringify(entry) });
}

// --- MCP Servers ---

export function fetchGlobalMcpServers(): Promise<import("./types").McpServer[]> {
  return apiFetch("/mcp/global");
}

export function fetchWorkspaceMcpServers(workspaceId: string): Promise<import("./types").McpServer[]> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers`);
}

export function fetchProjectMcpServers(workspaceId: string, projectId: string): Promise<import("./types").McpServer[]> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers`);
}

export function createGlobalMcpServer(data: { name: string; config: import("./types").McpServerConfig }): Promise<any> {
  return apiFetch("/mcp/global", { method: "POST", body: JSON.stringify(data) });
}

export function createWorkspaceMcpServer(workspaceId: string, data: { name: string; config: import("./types").McpServerConfig }): Promise<any> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers`, { method: "POST", body: JSON.stringify(data) });
}

export function createProjectMcpServer(workspaceId: string, projectId: string, data: { name: string; config: import("./types").McpServerConfig }): Promise<any> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteGlobalMcpServer(name: string): Promise<any> {
  return apiFetch(`/mcp/global/${name}`, { method: "DELETE" });
}

export function deleteWorkspaceMcpServer(workspaceId: string, name: string): Promise<any> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers/${name}`, { method: "DELETE" });
}

export function deleteProjectMcpServer(workspaceId: string, projectId: string, name: string): Promise<any> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers/${name}`, { method: "DELETE" });
}

// --- MCP disable lists ---

export function fetchWorkspaceDisabledMcpServers(workspaceId: string): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`);
}

export function disableWorkspaceMcpServer(workspaceId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableWorkspaceMcpServer(workspaceId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`, { method: "DELETE", body: JSON.stringify(entry) });
}

export function fetchProjectDisabledMcpServers(projectId: string): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`);
}

export function disableProjectMcpServer(projectId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableProjectMcpServer(projectId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`, { method: "DELETE", body: JSON.stringify(entry) });
}

// --- Secrets ---

type SecretListResponse = { secrets: import("./types").SecretRecord[] };
type SecretUpsertInput = { name: string; value: string; description?: string | null };

export function fetchGlobalSecrets(): Promise<SecretListResponse> {
  return apiFetch("/secrets/global");
}

export function upsertGlobalSecret(data: SecretUpsertInput): Promise<import("./types").SecretRecord> {
  return apiFetch("/secrets/global", { method: "POST", body: JSON.stringify(data) });
}

export function deleteGlobalSecret(name: string): Promise<any> {
  return apiFetch(`/secrets/global/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function fetchWorkspaceSecrets(workspaceId: string): Promise<SecretListResponse> {
  return apiFetch(`/secrets/workspaces/${workspaceId}`);
}

export function upsertWorkspaceSecret(workspaceId: string, data: SecretUpsertInput): Promise<import("./types").SecretRecord> {
  return apiFetch(`/secrets/workspaces/${workspaceId}`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteWorkspaceSecret(workspaceId: string, name: string): Promise<any> {
  return apiFetch(`/secrets/workspaces/${workspaceId}/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function fetchProjectSecrets(projectId: string): Promise<SecretListResponse> {
  return apiFetch(`/secrets/projects/${projectId}`);
}

export function upsertProjectSecret(projectId: string, data: SecretUpsertInput): Promise<import("./types").SecretRecord> {
  return apiFetch(`/secrets/projects/${projectId}`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteProjectSecret(projectId: string, name: string): Promise<any> {
  return apiFetch(`/secrets/projects/${projectId}/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// --- Metrics ---

export function fetchMetricsOverview(params: {
  period?: string;
  date_from?: string;
  date_to?: string;
  ai_provider_key_id?: string;
}): Promise<import("./types").MetricsOverview> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch(`/metrics/overview?${qs.toString()}`);
}
