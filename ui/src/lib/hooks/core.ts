import type { AgentQuestionKind } from "../api";

// --- Query keys ---

export const queryKeys = {
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  taskLogs: (id: string) => ["tasks", id, "logs"] as const,
  templates: ["templates"] as const,
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
  projectAllowedKeys: (id: string) => ["projects", id, "allowed-keys"] as const,
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
  chatTodos: (id: string) => ["chats", id, "todos"] as const,
  chatTodoHistory: (id: string) => ["chats", id, "todos", "history"] as const,
  /** Per-agent grouping for the Todo history drawer's tab strip. Scoped to
   *  the chat id only (no per-agent fan-out) — the route returns the full
   *  set in one shot, and the drawer slices client-side. */
  chatTodoAgents: (id: string) => ["chats", id, "todos", "agents"] as const,
  chatDiff: (id: string) => ["chats", id, "diff"] as const,
  usageSummary: (params: Record<string, string | undefined>) =>
    ["usage-summary", params] as const,
  usageBreakdown: (params: Record<string, string | undefined>) =>
    ["usage-breakdown", params] as const,
  aiKeys: ["ai-keys"] as const,
  aiKeyIdentity: (id: string) => ["ai-keys", id, "identity"] as const,
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
  projectTodo: (id: string) => ["projects", id, "todo"] as const,
  workspaceTodo: (id: string) => ["workspaces", id, "todo"] as const,
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
  attention: (serverId: string) => ["attention", serverId] as const,
  agentQuestion: (kind: AgentQuestionKind, id: string) =>
    ["agent-question", kind, id] as const,
  fsBrowse: (path: string | undefined, showHidden: boolean) =>
    ["fs-browse", path ?? "__default__", showHidden] as const,
  incidents: ["incidents"] as const,
  incident: (id: string) => ["incidents", id] as const,
};

// --- Shared permission request UI type ---

export interface PermissionRequestUI {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  title: string | null;
  display_name: string | null;
  description: string | null;
  decision_reason: string | null;
  tool_use_id: string;
}
