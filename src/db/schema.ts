import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── AI Provider Keys ───
export const aiProviderKeys = sqliteTable("ai_provider_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  providerType: text("provider_type").notNull(),
  label: text("label"),
  keyValue: text("key_value"),
  cliCommand: text("cli_command"),
  envVarName: text("env_var_name"),
  configDir: text("config_dir"),
  priority: integer("priority").default(0),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  lastError: text("last_error"),
  lastErrorAt: text("last_error_at"),
  consecutiveErrors: integer("consecutive_errors").default(0),
  disabledUntil: text("disabled_until"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// ─── Workspaces ───
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  path: text("path").notNull().unique(),
  repoUrl: text("repo_url"),
  allowedKeyIds: text("allowed_key_ids"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Projects ───
// Portable config (model, baseBranch, testCommand, permissionMode, etc.)
// lives in <project>/.flockctl/config.yaml and is git-tracked. DB holds
// only machine-local state: identity, path, and key scoping.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  path: text("path"),
  repoUrl: text("repo_url"),
  requiredProviders: text("required_providers"),
  providerFallbackChain: text("provider_fallback_chain"),
  backoffConfig: text("backoff_config"),
  allowedKeyIds: text("allowed_key_ids"),
  deniedKeyIds: text("denied_key_ids"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Tasks ───
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  prompt: text("prompt"),
  promptFile: text("prompt_file"),
  agent: text("agent"),
  model: text("model"),
  image: text("image"),
  command: text("command"),
  workingDir: text("working_dir"),
  envVars: text("env_vars"),
  status: text("status").default("queued").notNull(),
  taskType: text("task_type").default("execution").notNull(),
  targetSliceSlug: text("target_slice_slug"),
  label: text("label"),
  assignedKeyId: integer("assigned_key_id"),
  allowedKeyIds: text("allowed_key_ids"),
  failedKeyIds: text("failed_key_ids"),
  timeoutSeconds: integer("timeout_seconds"),
  maxRetries: integer("max_retries").default(0),
  retryCount: integer("retry_count").default(0),
  parentTaskId: integer("parent_task_id"),
  exitCode: integer("exit_code"),
  errorMessage: text("error_message"),
  gitCommitBefore: text("git_commit_before"),
  gitCommitAfter: text("git_commit_after"),
  gitDiffSummary: text("git_diff_summary"),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).default(false),
  approvalStatus: text("approval_status"),
  approvedAt: text("approved_at"),
  approvalNote: text("approval_note"),
  permissionMode: text("permission_mode"),
  claudeSessionId: text("claude_session_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_tasks_project_status").on(table.projectId, table.status),
  index("idx_tasks_status_created").on(table.status, table.createdAt),
]);

// ─── Task Logs ───
export const taskLogs = sqliteTable("task_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  streamType: text("stream_type").default("stdout"),
  timestamp: text("timestamp").default(sql`(datetime('now'))`),
});

// ─── Task Templates ───
export const taskTemplates = sqliteTable("task_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  prompt: text("prompt"),
  agent: text("agent"),
  model: text("model"),
  image: text("image"),
  workingDir: text("working_dir"),
  envVars: text("env_vars"),
  timeoutSeconds: integer("timeout_seconds"),
  labelSelector: text("label_selector"),
  assignedKeyId: integer("assigned_key_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Schedules ───
export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  templateId: integer("template_id").references(() => taskTemplates.id, { onDelete: "cascade" }),
  scheduleType: text("schedule_type").notNull(),
  cronExpression: text("cron_expression"),
  runAt: text("run_at"),
  timezone: text("timezone").default("UTC"),
  status: text("status").default("active"),
  lastFireTime: text("last_fire_time"),
  nextFireTime: text("next_fire_time"),
  misfireGraceSeconds: integer("misfire_grace_seconds"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Chats ───
export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  title: text("title"),
  claudeSessionId: text("claude_session_id"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  permissionMode: text("permission_mode"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Chat Messages ───
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").references(() => chats.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_chat_messages_chat_created").on(table.chatId, table.createdAt),
]);

// ─── Usage Records ───
export const usageRecords = sqliteTable("usage_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  chatMessageId: integer("chat_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  aiProviderKeyId: integer("ai_provider_key_id").references(() => aiProviderKeys.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").default(0),
  totalCostUsd: real("total_cost_usd").default(0),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_usage_records_created").on(table.createdAt),
  index("idx_usage_records_provider").on(table.provider),
  index("idx_usage_records_key").on(table.aiProviderKeyId),
]);

// ─── Budget Limits ───
export const budgetLimits = sqliteTable("budget_limits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull(),
  scopeId: integer("scope_id"),
  period: text("period").notNull(),
  limitUsd: real("limit_usd").notNull(),
  action: text("action").default("pause"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_budget_limits_scope").on(table.scope, table.scopeId),
]);

// ─── Secrets ───
// Opaque KV store for sensitive values referenced from MCP/agent env via
// ${secret:NAME} placeholders. Values are encrypted at rest with a master
// key kept in FLOCKCTL_HOME/secret.key (0600). App-level cascade on delete
// of the owning workspace/project is handled by the service layer since
// a composite scope/scope_id column cannot carry a native FK.
export const secrets = sqliteTable("secrets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull(),
  scopeId: integer("scope_id"),
  name: text("name").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  description: text("description"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex("idx_secrets_scope_name").on(table.scope, table.scopeId, table.name),
]);
