import { sqliteTable, text, integer, real, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql, desc } from "drizzle-orm";

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
  // ─── Gitignore toggles (migration 0038) ───
  // Opt-in flags consumed by `ensureGitignore()` (src/services/claude/skills-sync.ts):
  //   gitignoreFlockctl  → adds `.flockctl/` (and drops its granular sub-paths)
  //   gitignoreTodo      → adds root-level `TODO.md`
  //   gitignoreAgentsMd  → adds root-level `AGENTS.md` and `CLAUDE.md`
  // All default false so existing repos keep their current .gitignore shape.
  gitignoreFlockctl: integer("gitignore_flockctl", { mode: "boolean" }).default(false).notNull(),
  gitignoreTodo: integer("gitignore_todo", { mode: "boolean" }).default(false).notNull(),
  gitignoreAgentsMd: integer("gitignore_agents_md", { mode: "boolean" }).default(false).notNull(),
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
  // ─── Gitignore toggles (migration 0038) ───
  // See workspaces.gitignore* for semantics; same defaults (all false).
  gitignoreFlockctl: integer("gitignore_flockctl", { mode: "boolean" }).default(false).notNull(),
  gitignoreTodo: integer("gitignore_todo", { mode: "boolean" }).default(false).notNull(),
  gitignoreAgentsMd: integer("gitignore_agents_md", { mode: "boolean" }).default(false).notNull(),
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
  /**
   * Per-task file-edit journal — JSON `{ entries: [{ filePath, original,
   * current }] }`. Populated directly from Edit/Write/MultiEdit tool-call
   * inputs by `task-executor.ts`, rendered via `file-edit-journal.ts`.
   * See migration 0036 and `docs/API.md` (`GET /tasks/:id/diff`) for
   * why this replaces the former `git diff <before>..<after>` flow.
   */
  fileEdits: text("file_edits"),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).default(false),
  approvalStatus: text("approval_status"),
  approvedAt: text("approved_at"),
  approvalNote: text("approval_note"),
  permissionMode: text("permission_mode"),
  claudeSessionId: text("claude_session_id"),
  // ─── Spec fields ───
  // Structured specification attached to a task. `acceptance_criteria` is a
  // JSON-encoded string array and `decision_table` is a JSON-encoded object.
  // Both are optional and default to NULL. Per-plan `spec_required` lives in
  // plan YAML frontmatter (plan-store), not here, so the flag is not duplicated
  // on every task row.
  acceptanceCriteria: text("acceptance_criteria"),
  decisionTable: text("decision_table"),
  /**
   * Wake-up timestamp for tasks parked in `status='rate_limited'`. Unix-epoch
   * milliseconds (NOT seconds — Anthropic's `retry-after-ms` header is
   * sub-second-precise and the rate-limit scheduler's setTimeout is too).
   * NULL on every other status; cleared back to NULL on resume/cancel so a
   * stale value cannot leak into the next run. See migration 0044 for the
   * full rationale and `services/agents/rate-limit-scheduler.ts` for the
   * boot-time recovery query that reads this column.
   */
  resumeAt: integer("resume_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_tasks_project_status").on(table.projectId, table.status),
  index("idx_tasks_status_created").on(table.status, table.createdAt),
  // Partial index covering only currently-paused rows — keeps the
  // bootstrap-recovery query bounded by the live rate-limited population
  // rather than the full tasks table.
  index("idx_tasks_resume_at").on(table.resumeAt).where(sql`resume_at IS NOT NULL`),
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
// Templates are file-backed (JSON on disk). See `src/services/templates.ts`.
// Layout:
//   ~/flockctl/templates/<name>.json                       — global
//   <workspace>/.flockctl/templates/<name>.json            — workspace
//   <project>/.flockctl/templates/<name>.json              — project
// No DB table. Names are unique within a scope (enforced by filesystem).

// ─── Schedules ───
// Schedules live in the DB and reference a template by (scope, name, optional
// workspaceId / projectId). The referenced template is resolved at fire time
// via `templatesService.loadTemplate(...)`; if the file is missing the run
// is skipped (logged). `assignedKeyId` was moved off the template onto the
// schedule so a single template can be reused with different AI keys.
export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  templateScope: text("template_scope").notNull(),
  templateName: text("template_name").notNull(),
  templateWorkspaceId: integer("template_workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  templateProjectId: integer("template_project_id").references(() => projects.id, { onDelete: "cascade" }),
  assignedKeyId: integer("assigned_key_id").references(() => aiProviderKeys.id, { onDelete: "set null" }),
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
}, (table) => [
  check(
    "schedules_template_scope_check",
    sql`template_scope IN ('global','workspace','project')`,
  ),
  check(
    "schedules_template_ids_check",
    sql`(template_scope = 'global'    AND template_workspace_id IS NULL     AND template_project_id IS NULL)
     OR (template_scope = 'workspace' AND template_workspace_id IS NOT NULL AND template_project_id IS NULL)
     OR (template_scope = 'project'   AND template_project_id   IS NOT NULL)`,
  ),
  index("idx_schedules_template").on(table.templateScope, table.templateName),
]);

// ─── Chats ───
// `idx_chats_entity` backs the entity-aware lookup used by fetch-or-create:
// GET /chats?project_id=…&entity_type=…&entity_id=… runs in O(log n) and the
// POST /chats idempotent check reuses the same shape. Order of columns matches
// the filter predicate (project → type → id) so the query planner can use it
// even when only project_id is supplied.
export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  title: text("title"),
  claudeSessionId: text("claude_session_id"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  permissionMode: text("permission_mode"),
  // `ai_provider_key_id` persists the user's key selection per chat. Provider
  // is not stored separately — each key row already carries `.provider`, so
  // the chat's provider is derived by join (no drift risk). SET NULL on key
  // delete so chats fall back to the global default key on the next turn.
  aiProviderKeyId: integer("ai_provider_key_id").references(() => aiProviderKeys.id, { onDelete: "set null" }),
  // Selected model id (e.g. "claude-sonnet-4-20250514"). NULL means "fall back
  // to project / workspace / global default" on the next turn.
  model: text("model"),
  // Approval flow — symmetric with tasks (see migration 0011). A chat with
  // `requiresApproval=true` flips `approvalStatus` to 'pending' after each
  // successful assistant turn, surfaces as a `chat_approval` blocker in the
  // `/attention` inbox, and waits for the user to call
  // `POST /chats/:id/{approve,reject}`. Approve clears the pending state so
  // the next turn can run; reject also clears it but records the rejection
  // for audit. No gating of incoming user messages — this is advisory
  // tracking, not a hard lock.
  requiresApproval: integer("requires_approval", { mode: "boolean" }).default(false),
  approvalStatus: text("approval_status"),
  approvedAt: text("approved_at"),
  approvalNote: text("approval_note"),
  /**
   * Per-chat file-edit journal — JSON `{ entries: [{ filePath, original,
   * current }] }`. Populated from Edit/Write/MultiEdit tool-call inputs
   * by `chat-executor.ts`. Shares the `file-edit-journal.ts` module with
   * tasks so rendering / summary logic is identical on both sides.
   */
  fileEdits: text("file_edits"),
  /**
   * Adaptive thinking toggle. `true` (default) lets the Claude Agent SDK
   * decide when to emit thinking blocks — matches the prior behavior. `false`
   * forces `thinking: { type: "disabled" }` for the next turn, skipping the
   * extended-thinking step entirely. Persisted per chat so the UI restores
   * the user's pick on reload.
   */
  thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).default(true).notNull(),
  /**
   * Reasoning effort level (`low` | `medium` | `high` | `max`). NULL means
   * "use the hardcoded default" (`high`) — byte-identical to the pre-toggle
   * behavior. The per-chat value overrides the default only when the user
   * explicitly picks a level in the UI.
   */
  effort: text("effort"),
  /**
   * Per-chat pin toggle. When `true`, the chat floats to the top of
   * `GET /chats` above every unpinned row — filters (project / workspace /
   * entity) still apply first, so a pinned chat that doesn't match the
   * active filter is hidden, and unpinned rows keep their newest-first
   * order beneath the pinned ones. Default `false` so existing chats
   * upgrade as unpinned without a backfill.
   */
  pinned: integer("pinned", { mode: "boolean" }).default(false).notNull(),
  /**
   * Per-chat lifecycle state. Added in migration 0044 — the first explicit
   * status column for chats (the prior model derived "waiting" from
   * `EXISTS(agent_questions WHERE chat_id=? AND status='pending')` and
   * "running" from in-memory `chatExecutor.isRunning`). Allowed values:
   *   'idle'         — no live session
   *   'running'      — informational; the in-memory `chatExecutor.isRunning`
   *                    remains the source of truth for "is a session wired up
   *                    right now" because that survives restarts cleanly
   *   'rate_limited' — paused awaiting `resumeAt`; the rate-limit scheduler
   *                    will create a fresh AgentSession and continue via
   *                    `claudeSessionId`
   * Default 'idle' so existing rows are byte-equivalent post-migration.
   */
  status: text("status").default("idle").notNull(),
  /**
   * Wake-up timestamp for chats parked in `status='rate_limited'`. Mirrors
   * `tasks.resumeAt` — unix-epoch milliseconds, NULL otherwise. See migration
   * 0044 for full rationale.
   */
  resumeAt: integer("resume_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_chats_entity").on(table.projectId, table.entityType, table.entityId),
  index("idx_chats_resume_at").on(table.resumeAt).where(sql`resume_at IS NOT NULL`),
]);

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

// ─── Chat Attachments ───
// File blobs uploaded into a chat. `chat_id` is mandatory and cascades on
// delete of the chat; `message_id` is optional and is set to NULL if the
// originating message is deleted, so the blob row survives as an orphan for
// audit rather than vanishing. `path` is the on-disk location inside
// FLOCKCTL_HOME/attachments/ and is UNIQUE: retried uploads must regenerate
// the UUID rather than reuse it, which prevents accidental duplicate rows.
export const chatAttachments = sqliteTable("chat_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  messageId: integer("message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  path: text("path").notNull().unique(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_chat_attachments_chat_created").on(table.chatId, table.createdAt),
  index("idx_chat_attachments_message").on(table.messageId),
]);

// ─── Chat Todos ───
// Snapshots of a chat's TodoWrite state. Each row is an immutable snapshot;
// dedup of identical snapshots is handled at the application layer (no
// UNIQUE constraint). The partial index on task_id powers the task-scoped
// history view, and the (chat_id, created_at DESC) index powers the
// latest-snapshot / progress-bar query (LIMIT 1).
//
// `parentToolUseId` (added in migration 0041) attributes each snapshot to a
// specific agent within the chat. NULL = the main agent the user is talking
// to. A non-NULL `toolu_…` id identifies a sub-agent spawned via the Claude
// Agent SDK's `Task` tool — the value points back to the `Task` tool_use
// that created the sub-agent, so the route layer can join to the spawning
// `chat_messages` row to recover the human-readable description for the
// "Todo history" tab label. Dedup is keyed per (chatId, parentToolUseId)
// so two agents emitting identical todos arrays both land in the table —
// otherwise sub-agent A's `[step]` would silently mask sub-agent B's
// independent `[step]`.
export const chatTodos = sqliteTable("chat_todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  parentToolUseId: text("parent_tool_use_id"),
  todosJson: text("todos_json").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
}, (table) => [
  index("idx_chat_todos_chat_created").on(table.chatId, desc(table.createdAt)),
  index("idx_chat_todos_task_created")
    .on(table.taskId, desc(table.createdAt))
    .where(sql`task_id IS NOT NULL`),
  index("idx_chat_todos_chat_parent_created")
    .on(table.chatId, table.parentToolUseId, desc(table.createdAt)),
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
  /** Optional marker for standalone LLM activities not attached to a task or
   *  chat message (e.g. 'incident_extract'). NULL for legacy task/chat usage. */
  activityType: text("activity_type"),
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

// ─── Incidents ───
// Lightweight post-mortem / knowledge-base entries. `symptom`, `root_cause`,
// and `resolution` are mirrored into an FTS5 virtual table (`incidents_fts`)
// by raw-SQL triggers in migration 0025. The virtual table is not declared
// here because drizzle-kit does not emit FTS5 DDL; it is created manually
// in the migration and queried via raw SQL (`MATCH`) from services.
// `tags` stores a JSON-encoded string array (e.g. '["auth","db"]').
export const incidents = sqliteTable("incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  symptom: text("symptom"),
  rootCause: text("root_cause"),
  resolution: text("resolution"),
  tags: text("tags"),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdByChatId: integer("created_by_chat_id").references(() => chats.id, { onDelete: "set null" }),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_incidents_project").on(table.projectId),
  index("idx_incidents_created").on(table.createdAt),
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

// ─── Agent Questions ───
// In-flight prompts the agent has raised back to the user (e.g. ambiguous
// instructions, missing context). Each row is bound to exactly one of a
// `task_id` or `chat_id` — the CHECK constraint enforces that XOR so a
// question can never orphan or double-fire across both contexts. `request_id`
// is the externally visible idempotency token (UNIQUE) so retries from the
// agent don't insert duplicate rows for the same prompt; `tool_use_id` is the
// Anthropic SDK tool_use identifier the answer must be routed back to.
// `status` is enum-checked at the DB layer to keep stale code from inserting
// junk values. Indexes are tuned for the two hot lookups: "open questions for
// task/chat X" and "all pending questions oldest-first" (for the work queue).
export const agentQuestions = sqliteTable("agent_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull().unique(),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  chatId: integer("chat_id").references(() => chats.id, { onDelete: "cascade" }),
  toolUseId: text("tool_use_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  // JSON-serialized array of `{ label, description?, preview? }` objects when
  // the harness emits a multiple-choice prompt via AskUserQuestion. NULL means
  // free-form (the original 0029 shape) — stored that way so existing rows and
  // free-form callers stay valid without backfill.
  options: text("options"),
  // Whether the user may pick more than one option. Always false for free-form
  // prompts (NULL `options`), but tracked as its own column so future tooling
  // can render single- vs multi-select pickers without re-parsing `options`.
  multiSelect: integer("multi_select", { mode: "boolean" }).notNull().default(false),
  // Short chip label rendered above the choices (≤ 12 chars per Claude harness
  // convention). NULL when the prompt has no header — typical for free-form.
  header: text("header"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  answeredAt: text("answered_at"),
}, (table) => [
  check(
    "agent_questions_status_check",
    sql`status IN ('pending','answered','cancelled')`,
  ),
  check(
    "agent_questions_target_check",
    sql`(task_id IS NOT NULL AND chat_id IS NULL) OR (task_id IS NULL AND chat_id IS NOT NULL)`,
  ),
  index("idx_agent_questions_task_status").on(table.taskId, table.status),
  index("idx_agent_questions_chat_status").on(table.chatId, table.status),
  index("idx_agent_questions_status_created").on(table.status, table.createdAt),
]);

// ─── Missions ───
// Top-level supervisor objective. A mission is the long-running "why" that
// owns a tree of milestones / slices / tasks underneath; the supervisor loop
// reads `objective`, observes downstream task outcomes via `mission_events`,
// and proposes remediations gated by `autonomy`.
//
// `id` is a TEXT uuid-like slug (`^[a-z0-9-]{8,}$`) so it can also appear in
// milestone YAML frontmatter (`mission_id?`) without numeric coupling to the
// missions table — see slice 11/00 for the YAML half. `project_id` cascades
// on project delete so abandoned missions never outlive their project.
//
// `status` values trace the mission lifecycle: drafting → active → (paused →)
// active → completed | failed | aborted. `autonomy` controls the supervisor's
// permission to act: `manual` (propose only, never act), `suggest` (one-step
// proposals require approval), `auto` (act inside budget without per-step
// approval). Both columns are CHECK-constrained so stale code can't insert
// junk values; the supervisor relies on the enum being closed.
//
// Budgets are split: `budget_tokens` and `budget_usd_cents` are both > 0
// (CHECK) so an "unbounded" mission cannot exist — the supervisor must have
// a stop condition. `spent_*` counters are advanced by the executor on each
// downstream LLM call and emit a `budget_warning` / `budget_exceeded` event
// at the configured thresholds.
//
// `supervisor_prompt_version` pins the prompt template used when the mission
// was created so a later prompt rev can't silently change in-flight mission
// behavior; the supervisor reads this column to load the matching template.
//
// Timestamps use INTEGER `unixepoch()` (not the project-wide `datetime('now')`
// TEXT default) because the supervisor's hot-path event scan needs cheap
// integer comparisons and the slice 03 edge test asserts a 10k-event time
// query under 50ms.
export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  objective: text("objective").notNull(),
  status: text("status").notNull().default("active"),
  autonomy: text("autonomy").notNull().default("suggest"),
  budgetTokens: integer("budget_tokens").notNull(),
  budgetUsdCents: integer("budget_usd_cents").notNull(),
  spentTokens: integer("spent_tokens").notNull().default(0),
  spentUsdCents: integer("spent_usd_cents").notNull().default(0),
  supervisorPromptVersion: text("supervisor_prompt_version").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  check(
    "missions_status_check",
    sql`status IN ('drafting','active','paused','completed','failed','aborted')`,
  ),
  check(
    "missions_autonomy_check",
    sql`autonomy IN ('manual','suggest','auto')`,
  ),
  check("missions_budget_tokens_check", sql`budget_tokens > 0`),
  check("missions_budget_usd_cents_check", sql`budget_usd_cents > 0`),
  index("idx_missions_project").on(table.projectId),
]);

// ─── Mission Events ───
// Append-only timeline of supervisor decisions and observations for a mission.
// Cascades on mission delete (history travels with the mission — the table is
// not a system audit log). Each row pins the `kind` enum at the DB layer so
// drift in the supervisor code can't insert unknown event types and silently
// corrupt the event-replay path.
//
// `payload` is a JSON-encoded blob whose shape is keyed by `kind` (e.g.
// `plan_proposed` carries a milestone tree, `budget_warning` carries the
// threshold and current spend). Schema-per-kind validation lives in the
// service layer, not at the DB, so the supervisor can evolve payload shapes
// without a migration each time.
//
// `cost_tokens` / `cost_usd_cents` are the *delta* attributed to producing
// this event (typically the planning LLM call), not the running mission
// total — totals live on `missions.spent_*`. `depth` records the nested
// remediation depth that produced the event so the supervisor can enforce
// the depth-exceeded stop condition without re-walking the event history.
//
// `idx_mission_events_mission_created` covers the dominant query: "give me
// the latest N events for mission X in reverse chronological order". The
// (mission_id, created_at DESC) compound is required for the 10k-event
// 50ms scan target in slice 03.
export const missionEvents = sqliteTable("mission_events", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  costTokens: integer("cost_tokens").notNull().default(0),
  costUsdCents: integer("cost_usd_cents").notNull().default(0),
  depth: integer("depth").notNull().default(0),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  check(
    "mission_events_kind_check",
    sql`kind IN (
      'plan_proposed','task_observed','remediation_proposed',
      'remediation_approved','remediation_dismissed',
      'budget_warning','budget_exceeded','depth_exceeded',
      'no_action','objective_met','stalled','heartbeat','paused'
    )`,
  ),
  index("idx_mission_events_mission_created").on(table.missionId, desc(table.createdAt)),
]);
