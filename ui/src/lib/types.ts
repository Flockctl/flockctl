// TypeScript types mirroring shared/flockctl_shared/schemas.py and enums.py

// --- Remote server connections ---

/**
 * Public server view — tokens never cross this boundary. The backend holds the
 * actual Bearer token in ~/.flockctlrc and exposes only has_token here.
 */
export interface ServerConnection {
  id: string;
  name: string;
  url: string;
  is_local: boolean;
  has_token: boolean;
}

export type ConnectionStatus = "connected" | "checking" | "error";

// --- Enums (const objects — TS 6 erasableSyntaxOnly forbids enum keyword) ---

export const TaskStatus = {
  queued: "queued",
  assigned: "assigned",
  running: "running",
  pending_approval: "pending_approval",
  done: "done",
  failed: "failed",
  timed_out: "timed_out",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const ScheduleType = {
  cron: "cron",
  one_shot: "one_shot",
} as const;
export type ScheduleType = (typeof ScheduleType)[keyof typeof ScheduleType];

export const ScheduleStatus = {
  active: "active",
  paused: "paused",
  expired: "expired",
} as const;
export type ScheduleStatus =
  (typeof ScheduleStatus)[keyof typeof ScheduleStatus];

// --- Permission modes (mirror backend enum) ---

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  path: string;
  allowed_key_ids: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceConfig {
  permissionMode?: PermissionMode | null;
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}

export interface WorkspaceCreate {
  name: string;
  path?: string;
  description?: string | null;
  repoUrl?: string | null;
  permission_mode?: PermissionMode | null;
}

export interface WorkspaceUpdate {
  name?: string | null;
  description?: string | null;
  allowed_key_ids?: number[] | null;
  permission_mode?: PermissionMode | null;
}

export interface WorkspaceProject {
  id: string;
  workspace_id: string;
  project_id: string;
  added_at: string;
}

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

// --- Response types ---

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface ErrorResponse {
  detail: string;
  status_code: number;
}

// --- Task ---

export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string | null;
  agent: string | null;
  model: string | null;
  timeout_seconds: number;
  project_id: string | null;
  assigned_key_id: number | null;
  assigned_key_label: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  working_dir: string | null;
  created_at: string;
  updated_at: string;
  liveMetrics?: TaskMetrics;
  git_commit_before: string | null;
  git_commit_after: string | null;
  git_diff_summary: string | null;
  requires_approval: boolean;
  approval_status: string | null;
  approved_at: string | null;
  approval_note: string | null;
  permission_mode: PermissionMode | null;
}

export interface TaskFilters {
  status?: TaskStatus;
  agent?: string;
  created_after?: string;
  created_before?: string;
  project_id?: string;
}

export interface ScheduleFilters {
  status?: ScheduleStatus;
  schedule_type?: ScheduleType;
}

export interface TaskCreate {
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  working_dir?: string | null;
  env_vars?: Record<string, string> | null;
  project_id?: string | null;
  timeout_seconds?: number;
  assigned_key_id?: number | null;
  permission_mode?: PermissionMode | null;
}

export interface TaskUpdate {
  permission_mode?: PermissionMode | null;
}

export interface TaskLog {
  id: string;
  task_id: string;
  content: string;
  stream_type: string;
  timestamp: string;
}

export interface TaskMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: number;
  turns: number;
  duration_ms: number;
}

// --- TaskTemplate ---

export interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  agent: string | null;
  model: string | null;
  prompt: string | null;
  working_dir: string | null;
  env_vars: Record<string, string> | null;
  timeout_seconds: number;
  allowed_key_ids: string[] | null;
  assigned_key_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskTemplateCreate {
  name: string;
  description?: string | null;
  agent?: string | null;
  model?: string | null;
  prompt?: string | null;
  working_dir?: string | null;
  env_vars?: Record<string, string> | null;
  timeout_seconds?: number;
  allowed_key_ids?: string[] | null;
  assigned_key_id?: string | null;
  project_id?: string | null;
}

// --- Schedule ---

export interface Schedule {
  id: string;
  template_id: string;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  run_at: string | null;
  timezone: string;
  status: ScheduleStatus;
  last_fire_time: string | null;
  next_fire_time: string | null;
  misfire_grace_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleCreate {
  template_id: string;
  schedule_type: ScheduleType;
  cron_expression?: string | null;
  run_at?: string | null;
  timezone?: string;
  misfire_grace_seconds?: number;
}

// --- Planning hierarchy enums ---

export const MilestoneStatus = {
  pending: "pending",
  planning: "planning",
  active: "active",
  completed: "completed",
} as const;
export type MilestoneStatus =
  (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export const SliceStatus = {
  pending: "pending",
  planning: "planning",
  active: "active",
  verifying: "verifying",
  merging: "merging",
  completed: "completed",
  skipped: "skipped",
  failed: "failed",
} as const;
export type SliceStatus = (typeof SliceStatus)[keyof typeof SliceStatus];

export const PlanTaskStatus = {
  pending: "pending",
  active: "active",
  completed: "completed",
  failed: "failed",
} as const;
export type PlanTaskStatus =
  (typeof PlanTaskStatus)[keyof typeof PlanTaskStatus];

// --- Project ---

export interface Project {
  id: string;
  name: string;
  description: string | null;
  path: string | null;
  workspace_id: number | null;
  repo_url: string | null;
  provider_fallback_chain: string[] | null;
  allowed_key_ids: number[] | null;
  created_at: string;
  updated_at: string;
}

/**
 * Config stored in <project>/.flockctl/config.yaml — portable across
 * machines via git. Fetched/updated via /projects/:id/config.
 */
export interface ProjectConfig {
  model?: string | null;
  planningModel?: string | null;
  allowedProviders?: string[] | null;
  baseBranch?: string | null;
  testCommand?: string | null;
  defaultTimeout?: number | null;
  maxConcurrentTasks?: number | null;
  requiresApproval?: boolean | null;
  budgetDailyUsd?: number | null;
  env?: Record<string, string> | null;
  permissionMode?: PermissionMode | null;
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}

export interface ProjectCreate {
  name: string;
  description?: string | null;
  path?: string | null;
  workspace_id?: number | null;
  repo_url?: string | null;
  baseBranch?: string;
  allowedProviders?: string[] | null;
  provider_fallback_chain?: string[] | null;
  model?: string | null;
  permission_mode?: PermissionMode | null;
  importActions?: ImportAction[];
}

// --- Project import (scan + adopt existing .claude/AGENTS.md/.mcp.json) ---

export type ImportAction =
  | { kind: "adoptAgentsMd" }
  | { kind: "mergeClaudeMd" }
  | { kind: "importMcpJson" }
  | { kind: "importClaudeSkill"; name: string };

export type ClaudeMdKind =
  | "none"
  | "file"
  | "symlink-to-agents"
  | "symlink-other";

export interface ProjectScan {
  path: string;
  exists: boolean;
  writable: boolean;
  git: { present: boolean; originUrl: string | null };
  alreadyManaged: boolean;
  conflicts: {
    agentsMd: { present: boolean; bytes: number; isManaged: boolean };
    claudeMd: { present: boolean; kind: ClaudeMdKind; bytes: number; sameAsAgents: boolean };
    mcpJson: { present: boolean; servers: string[]; parseError: string | null };
    claudeSkills: Array<{ name: string; isSymlink: boolean }>;
    claudeAgents: string[];
    claudeCommands: string[];
    flockctlAgentsPresent: boolean;
  };
  proposedActions: ImportAction[];
}

export interface ProjectUpdate {
  name?: string | null;
  description?: string | null;
  repoUrl?: string | null;
  provider_fallback_chain?: string[] | null;
  allowed_key_ids?: number[] | null;
  // Config fields (relayed into .flockctl/config.yaml server-side)
  baseBranch?: string | null;
  allowedProviders?: string[] | null;
  model?: string | null;
  planningModel?: string | null;
  testCommand?: string | null;
  maxConcurrentTasks?: number | null;
  budgetDailyUsd?: number | null;
  requiresApproval?: boolean;
  envVars?: Record<string, string> | null;
  permission_mode?: PermissionMode | null;
}

// --- Milestone ---

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  vision: string | null;
  success_criteria: string[] | null;
  depends_on: string[] | null;
  order_index: number;
  key_risks?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MilestoneCreate {
  title: string;
  description?: string | null;
  vision?: string | null;
  success_criteria?: string[] | null;
  depends_on?: string[] | null;
  order_index?: number;
}

export interface MilestoneUpdate {
  title?: string | null;
  description?: string | null;
  status?: MilestoneStatus | null;
  vision?: string | null;
  success_criteria?: string[] | null;
  depends_on?: string[] | null;
  order_index?: number | null;
}

// --- PlanSlice ---

export interface PlanSlice {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  status: SliceStatus;
  risk: string;
  depends: string[] | null;
  demo: string | null;
  goal: string | null;
  success_criteria: string | null;
  proof_level?: string | null;
  threat_surface?: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface PlanSliceCreate {
  title: string;
  description?: string | null;
  risk?: string;
  depends?: string[] | null;
  demo?: string | null;
  goal?: string | null;
  success_criteria?: string | null;
  order_index?: number;
}

export interface PlanSliceUpdate {
  title?: string | null;
  description?: string | null;
  status?: SliceStatus | null;
  risk?: string | null;
  depends?: string[] | null;
  demo?: string | null;
  goal?: string | null;
  success_criteria?: string | null;
  order_index?: number | null;
}

// --- PlanTask ---

export interface PlanTask {
  id: string;
  slice_id: string;
  title: string;
  description: string | null;
  model: string | null;
  status: PlanTaskStatus;
  estimate: string | null;
  files: string[] | null;
  verify: string | null;
  inputs: string[] | null;
  expected_output: string[] | null;
  task_id: string | null;
  order_index: number;
  output: string | null;
  summary: Record<string, unknown> | null;
  verification_passed: boolean | null;
  verification_output: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanTaskCreate {
  title: string;
  description?: string | null;
  model?: string | null;
  estimate?: string | null;
  files?: string[] | null;
  verify?: string | null;
  inputs?: string[] | null;
  expected_output?: string[] | null;
  task_id?: string | null;
  order_index?: number;
}

export interface PlanTaskUpdate {
  title?: string | null;
  description?: string | null;
  model?: string | null;
  status?: PlanTaskStatus | null;
  estimate?: string | null;
  files?: string[] | null;
  verify?: string | null;
  inputs?: string[] | null;
  expected_output?: string[] | null;
  task_id?: string | null;
  order_index?: number | null;
  output?: string | null;
  summary?: Record<string, unknown> | null;
  verification_passed?: boolean | null;
  verification_output?: string | null;
}

// --- Planning tree responses ---

export interface PlanSliceTree extends PlanSlice {
  tasks: PlanTask[];
}

export interface MilestoneTree extends Milestone {
  slices: PlanSliceTree[];
}

export interface ProjectTree {
  milestones: MilestoneTree[];
}

// --- Workspace Dependency Graph ---

export interface WorkspaceMilestoneNode {
  milestone_id: string;
  title: string;
  project_id: string;
  project_name: string;
  status: MilestoneStatus;
  depends_on: string[];
}

export interface WorkspaceDependencyGraph {
  workspace_id: string;
  nodes: WorkspaceMilestoneNode[];
  waves: string[][];
  errors: string[];
}

// --- Workspace Dashboard ---

export interface WorkspaceProjectSummary {
  project_id: string;
  project_name: string;
  milestone_count: number;
  active_milestone_count: number;
  completed_milestone_count: number;
  total_slices: number;
  active_slices: number;
  completed_slices: number;
  failed_slices: number;
  running_tasks: number;
  queued_tasks: number;
  tree: ProjectTree;
}

export interface WorkspaceDashboard {
  workspace_id: string;
  workspace_name: string;
  project_summaries: WorkspaceProjectSummary[];
  total_projects: number;
  total_milestones: number;
  active_milestones: number;
  total_slices: number;
  active_slices: number;
  completed_slices: number;
  running_tasks: number;
  queued_tasks: number;
  // Cost data (from Phase 0D)
  project_count: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  pending_milestones: number;
  active_milestones_count: number;
  completed_milestones: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_by_project: Array<{ project_id: string; project_name: string; cost_usd: number }>;
  recent_activity: Array<{ type: string; entity_id: number; title: string; timestamp: string }>;
}

// --- Activation / Auto-execution ---

export interface ActivateRequest {
  agent?: string | null;
}

export interface ActivateResponse {
  slice_id: string;
  status: string;
  dispatched: number;
  queued: number;
}

export interface AutoExecuteRequest {
  agent?: string | null;
}

export interface AutoExecuteResponse {
  status: string;
  milestone_id: string;
  current_slice_ids: string[];
}

export interface AutoExecuteStatusResponse {
  status: string;
  milestone_id: string;
  current_slice_ids: string[];
  started_at: string | null;
  completed_slices: number;
  total_slices: number;
}

// --- Execution Graph ---

export interface ExecutionWave {
  wave_index: number;
  slice_ids: string[];
  slices: PlanSlice[];
}

export interface ExecutionGraphResponse {
  milestone_id: string;
  waves: ExecutionWave[];
  critical_path: string[];
  errors: string[];
  parallelism_factor: number;
  slice_workers: Record<string, string[]>;
}

// --- Project Execution Overview ---

export interface OverviewTaskWave {
  waveIndex: number;
  task_ids: string[];
}

export interface OverviewTask {
  id: string;
  slice_id: string;
  title: string;
  status: string;
  depends: string[] | null;
  order_index: number;
  verification_passed: boolean | null;
}

export interface OverviewSlice {
  id: string;
  milestone_id: string;
  title: string;
  status: string;
  risk: string;
  depends: string[] | null;
  goal: string | null;
  order_index: number;
  tasks: OverviewTask[];
  task_waves: OverviewTaskWave[];
}

export interface OverviewWave {
  waveIndex: number;
  slugs: string[];
  slices: OverviewSlice[];
}

export interface OverviewMilestone {
  milestone_id: string;
  title: string;
  status: string;
  waves: OverviewWave[];
  parallelism_factor: number;
  total_slices: number;
  completed_slices: number;
  active_slice_ids: string[];
}

export interface ProjectExecutionOverviewResponse {
  milestones: OverviewMilestone[];
}

// --- Chat ---

export const ChatMessageRole = {
  user: "user",
  assistant: "assistant",
  system: "system",
} as const;
export type ChatMessageRole =
  (typeof ChatMessageRole)[keyof typeof ChatMessageRole];

export interface ChatCreate {
  title?: string | null;
  project_id?: string | null;
  projectId?: number | null;
  workspaceId?: number | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface ChatMetrics {
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  last_message_at: string | null;
}

export interface ChatResponse {
  id: string;
  user_id: string;
  project_id: string | null;
  workspace_id: string | null;
  project_name: string | null;
  workspace_name: string | null;
  title: string | null;
  entity_type: string | null;
  entity_id: string | null;
  permission_mode: PermissionMode | null;
  created_at: string;
  updated_at: string;
  metrics?: ChatMetrics;
}

export interface ChatUpdate {
  title?: string | null;
  permission_mode?: PermissionMode | null;
}

export interface ChatMessageCreate {
  content: string;
  agent?: string;
  model?: string;
  keyId?: number;
  system?: string;
  entity_context?: {
    entity_type: "milestone" | "slice" | "task";
    entity_id: string;
    milestone_id?: string;
    slice_id?: string;
  };
}

export interface ChatMessageResponse {
  id: string;
  chat_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
}

export interface ChatDetailResponse extends ChatResponse {
  messages: ChatMessageResponse[];
  metrics?: ChatMetrics;
  isRunning?: boolean;
}

export interface ChatFullMetrics extends ChatMetrics {
  chat_id: string;
  created_at: string;
  updated_at: string;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  models_used: string[];
}

// --- Plan generation ---

export interface GeneratePlanRequest {
  prompt: string;
  mode: "quick" | "deep";
}

export interface GeneratePlanResponse {
  task_id: string;
}

export interface GeneratePlanStatus {
  generating: boolean;
  task_id?: number;
  status?: string;
  mode?: "quick" | "deep" | null;
  started_at?: string | null;
  created_at?: string | null;
}

// --- Usage ---

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_cost_usd: number;
  record_count: number;
  by_provider: Record<string, { tokens: number; cost_usd: number }>;
  by_model: Record<string, { tokens: number; cost_usd: number }>;
}

export interface UsageBreakdownItem {
  scope_id: string | null;
  scope_label: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  record_count: number;
}

export interface UsageBreakdownResponse {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_record_count: number;
  items: UsageBreakdownItem[];
}

// --- Task Stats ---

export interface TaskStats {
  total: number;
  queued: number;
  assigned: number;
  running: number;
  completed: number;
  done: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  avg_duration_seconds: number | null;
}

// --- Project Stats ---

export interface ProjectStats {
  tasks: {
    total: number;
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    done: number;
    failed: number;
    timed_out: number;
    cancelled: number;
  };
  avg_task_duration_seconds: number | null;
  milestones: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  slices: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  usage: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
}

// Tool execution tracking for UI
export interface ToolExecution {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
}

// --- AI Provider Keys ---

export interface AIProviderKeyResponse {
  id: string;
  provider: string;
  provider_type: string;
  label: string | null;
  key_value: string | null;
  cli_command: string | null;
  env_var_name: string | null;
  config_dir: string | null;
  priority: number;
  is_active: boolean;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_errors: number;
  disabled_until: string | null;
  created_at: string;
  // computed convenience fields
  name: string | null;        // alias for label
  key_suffix: string | null;  // last 4 chars if keyValue present
}

export interface AIProviderKeyCreate {
  provider: string;
  provider_type: string;
  label?: string;
  key_value?: string;
  cli_command?: string;
  config_dir?: string;
  priority?: number;
  is_active?: boolean;
}

export interface AIProviderKeyUpdate {
  label?: string;
  key_value?: string;
  config_dir?: string;
  priority?: number;
  is_active?: boolean;
}

// --- Meta (agents & models) ---

export interface MetaAgent {
  id: string;
  name: string;
  available: boolean;
}

export interface MetaModel {
  id: string;
  name: string;
  agent: string;
}

export interface MetaKey {
  id: string;
  name: string;
  provider: string;
  is_active: boolean;
}

export interface MetaDefaults {
  model: string;
  planning_model: string;
  agent: string;
  /** Global default AI Provider Key id (stringified by the API layer), or null when unset. */
  key_id: string | null;
}

export interface MetaResponse {
  agents: MetaAgent[];
  models: MetaModel[];
  keys: MetaKey[];
  defaults: MetaDefaults;
}

// --- Skills ---

export type DisableLevel = "global" | "workspace" | "project";

export interface DisableEntry {
  name: string;
  level: DisableLevel;
}

export interface Skill {
  name: string;
  level: DisableLevel;
  content: string;
}

// --- MCP Servers ---

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

export interface McpServer {
  name: string;
  level: "global" | "workspace" | "project";
  config: McpServerConfig;
}

// --- Secrets ---

export type SecretScope = "global" | "workspace" | "project";

export interface SecretRecord {
  id: number;
  scope: SecretScope;
  scopeId: number | null;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// --- Analytics Metrics ---

export interface MetricsOverview {
  time: {
    total_work_seconds: number;
    avg_duration_seconds: number | null;
    median_duration_seconds: number | null;
    avg_queue_wait_seconds: number | null;
    peak_hours: Array<{ hour: number; count: number }>;
  };
  productivity: {
    tasks_by_status: Record<string, number>;
    success_rate: number | null;
    retry_rate: number | null;
    tasks_with_code_changes: number;
    code_change_rate: number | null;
    avg_tasks_per_day: number | null;
    tasks_per_day: Array<{ day: string; count: number }>;
  };
  cost: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_creation: number;
    total_cache_read: number;
    cache_hit_rate: number | null;
    avg_cost_per_task: number | null;
    cost_by_outcome: Array<{
      outcome: string;
      avg_cost: number;
      total_cost: number;
      task_count: number;
    }>;
    burn_rate_per_day: number | null;
    daily_costs: Array<{ day: string; cost: number }>;
  };
  chats: {
    total_chats: number;
    avg_messages_per_chat: number | null;
    avg_chat_duration_seconds: number | null;
    total_chat_time_seconds: number;
  };
  schedules: {
    total: number;
    active: number;
    paused: number;
  };
}
