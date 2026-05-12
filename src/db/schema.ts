import { sqliteTable, text, integer, real, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";

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
  // Opt-in flags consumed by `ensureGitExclude()` (src/services/claude/skills-sync.ts).
  // Despite the historical `gitignore*` column names, these now drive entries
  // in `.git/info/exclude` (local-only, never tracked) — column names are
  // preserved to avoid a breaking schema migration:
  //   gitignoreFlockctl  → adds `.flockctl/` (and drops its granular sub-paths)
  //   gitignoreTodo      → adds root-level `TODO.md`
  //   gitignoreAgentsMd  → adds root-level `AGENTS.md` and `CLAUDE.md`
  // All default false so existing repos keep their current exclude shape.
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
  // See workspaces.gitignore* for semantics. The schema-level DEFAULTs are
  // still 0/false (changing a SQLite column DEFAULT requires a table rebuild),
  // but the user-facing defaults applied by the create endpoints (POST
  // /projects, POST /workspaces/:id/projects) and the create-dialog UI are:
  //   gitignoreFlockctl  → true  (hide `.flockctl/` from git)
  //   gitignoreTodo      → true  (hide `TODO.md`)
  //   gitignoreAgentsMd  → false (AGENTS.md is the only Flockctl trace
  //                              that should remain visible in the repo)
  // So a project created via the API ends up with the first two on by default.
  gitignoreFlockctl: integer("gitignore_flockctl", { mode: "boolean" }).default(false).notNull(),
  gitignoreTodo: integer("gitignore_todo", { mode: "boolean" }).default(false).notNull(),
  gitignoreAgentsMd: integer("gitignore_agents_md", { mode: "boolean" }).default(false).notNull(),
  // ─── Project-owned skills opt-in (migration 0045) ───
  // When true, `resolveSkillsForProject()` also walks
  // `<project>/.claude/skills/<name>/SKILL.md` and treats each entry as a
  // `level='project'` skill that overrides any same-name entry from
  // global / workspace / `.flockctl/skills/`. Such skills are marked
  // `locked: true` and bypass the per-project `disabledSkills` filter —
  // the user opted into them at project-creation time, so they cannot be
  // disabled through the regular skills toggle UI.
  useProjectClaudeSkills: integer("use_project_claude_skills", { mode: "boolean" }).default(false).notNull(),
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
  /**
   * Isolation mode for the agent session. NULL means "run in
   * `task.workingDir` (or project path) directly" — the legacy behaviour.
   * `'worktree'` means the executor materialises a per-task git worktree
   * under `<project>/.flockctl/worktrees/task-<id>/` before launch, runs
   * the agent there, and (if the worktree is clean on finalize) removes
   * it again. Stringly-typed so future modes ('container', 'sandbox', …)
   * can be added without a CHECK-drop migration. See migration 0060.
   */
  isolation: text("isolation"),
  /**
   * Absolute path to the per-task git worktree once it has been created
   * (NULL until creation; NULL forever for `isolation IS NULL` tasks).
   * Stored absolute so the value survives a project rename / move. When a
   * task finalises with a clean worktree, the row is rewritten back to
   * NULL by the cleanup hook; when the worktree is left behind because of
   * uncommitted changes, this column is the operator's pointer to it.
   */
  worktreePath: text("worktree_path"),
  /**
   * Branch name created alongside the worktree (`flockctl/task-<id>`).
   * Captured at creation time so cleanup can `git branch -D` even after
   * the worktree directory itself is gone (e.g. removed manually). NULL
   * iff `worktree_path` is NULL.
   */
  worktreeBranch: text("worktree_branch"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_tasks_project_status").on(table.projectId, table.status),
  index("idx_tasks_status_created").on(table.status, table.createdAt),
  // Added in migration 0059 — covers the dominant tasks-list query path
  // (`WHERE project_id = ? ORDER BY created_at DESC LIMIT N`). The existing
  // `idx_tasks_project_status` doesn't help past the WHERE because its
  // second column is `status`, not `created_at`; the planner falls back to
  // a sort. The DESC marker keeps the index walked in already-ordered form.
  index("idx_tasks_project_created_desc").on(table.projectId, table.createdAt),
  // Partial index covering only currently-paused rows — keeps the
  // bootstrap-recovery query bounded by the live rate-limited population
  // rather than the full tasks table.
  index("idx_tasks_resume_at").on(table.resumeAt).where(sql`resume_at IS NOT NULL`),
  // Added in migration 0061 — partial indexes on FK columns flagged by the
  // audit. All three are heavily skewed to NULL (most tasks have no parent,
  // most aren't tied to a specific AI key, most have no label), so partial
  // indexes keep the structure small while the planner still picks them up
  // when the filter excludes NULL.
  //
  //   * parentTaskId — used by tasks-list stats (failedRerunAgg,
  //     supersededFailuresAgg, buildAfterRerunAgg in routes/tasks/crud.ts)
  //     plus the rerun-chain lookup; scan size goes from total tasks → rows
  //     with parent.
  //   * assignedKeyId — used by /metrics/overview with ?ai_provider_key_id=…
  //     and the FK SET NULL cascade when an AI key is deleted.
  //   * label — used by GET /tasks?label=foo (currently full scan because
  //     no index) and the schedules-by-template prefix-LIKE in
  //     routes/schedules.ts.
  index("idx_tasks_parent").on(table.parentTaskId).where(sql`parent_task_id IS NOT NULL`),
  index("idx_tasks_assigned_key").on(table.assignedKeyId).where(sql`assigned_key_id IS NOT NULL`),
  index("idx_tasks_label").on(table.label).where(sql`label IS NOT NULL`),
]);

// ─── Task Logs ───
export const taskLogs = sqliteTable("task_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  streamType: text("stream_type").default("stdout"),
  timestamp: text("timestamp").default(sql`(datetime('now'))`),
}, (table) => [
  // Added in migration 0058 — covers `GET /tasks/:id/logs` (the only
  // hot-path lookup) plus the FK constraint check fired by
  // `DELETE FROM tasks WHERE id = ?`. Composite (task_id, timestamp)
  // serves both the WHERE filter and the ORDER BY in one index.
  index("idx_task_logs_task_timestamp").on(table.taskId, table.timestamp),
]);

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
  // Added in migration 0061 — speeds up the SET NULL cascade fired when an
  // AI key is deleted (each delete previously scanned the whole schedules
  // table). Partial because most schedules don't pin a specific key.
  index("idx_schedules_assigned_key").on(table.assignedKeyId).where(sql`assigned_key_id IS NOT NULL`),
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
  /**
   * Isolation mode for the chat session. NULL means "run in
   * `resolveChatCwd(chat)` (workspace > project > home) directly" — the
   * legacy behaviour. `'worktree'` means the first message lazily
   * materialises a per-chat git worktree under
   * `<project>/.flockctl/worktrees/chat-<id>/`, rewrites the working
   * directory to that path for every subsequent turn, and persists the
   * result in `worktree_path` / `worktree_branch`. Cleanup is operator-
   * driven (POST `/chats/:id/end-session` / DELETE `/chats/:id/worktree`)
   * because chats have no terminal lifecycle state. See migration 0060.
   */
  isolation: text("isolation"),
  /**
   * Absolute path to the per-chat git worktree once it has been created
   * (NULL until the first message materialises it; NULL forever for
   * `isolation IS NULL` chats). Persisting an absolute path keeps the
   * pointer valid across project renames and across daemon restarts —
   * boot recovery just trusts what's already on the row.
   */
  worktreePath: text("worktree_path"),
  /**
   * Branch name created alongside the worktree (`flockctl/chat-<id>`).
   * Captured at creation time so cleanup can `git branch -D` even after
   * the worktree directory itself is gone. NULL iff `worktree_path` is
   * NULL.
   */
  worktreeBranch: text("worktree_branch"),
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
  // Added in migration 0057: cover the three FK columns whose hot
  // lookups (cost-rollup-per-task, cost-rollup-per-chat-message,
  // GET /usage/summary?project_id=X) used to scan the whole table.
  index("idx_usage_records_task").on(table.taskId),
  index("idx_usage_records_chat_message").on(table.chatMessageId),
  index("idx_usage_records_project").on(table.projectId),
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
  // Added in migration 0057: covers `GET /chats/:id/incidents` and the
  // FK constraint check fired by `DELETE FROM chats WHERE id = ?`
  // (which sets created_by_chat_id to NULL on every related incident).
  index("idx_incidents_chat").on(table.createdByChatId),
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

// ─── Git Audit Log ───
// Append-only forensic record of every git mutation Flockctl performs on
// behalf of a user — `pull`, `commit`, `push`. Scoped intentionally narrow:
// this is NOT a generic audit-log framework, and adding new `action` enum
// values requires both a CHECK-constraint amendment here and a deliberate
// review of what data may safely be persisted.
//
// Why a dedicated table (not `usage_records` / `mission_events`):
//  - usage_records is keyed by LLM cost; git operations have no token cost.
//  - mission_events cascades on mission delete (history travels with the
//    mission), but git audit must SURVIVE project / workspace deletion
//    so a forensic record of "what we did to that repo" is never lost
//    just because the row that owned the path went away.
//
// FK cascade rules — both `project_id` and `workspace_id` are SET NULL on
// delete of the parent row. That intentionally orphans the audit row
// rather than dropping it; pair this with the CHECK below so a row can
// still be located via the surviving scope id when only one parent is
// removed. After both parents are gone the row simply records "an
// operation Flockctl ran against a path that no longer maps to a known
// scope" — still auditable via the recorded `args_json` / timestamps.
//
// CHECK constraint (`git_audit_log_scope_check`): at least one of
// project_id / workspace_id must be non-null *at INSERT time*. The FK
// SET NULL behavior above can later violate this implication on parent
// delete, but SQLite enforces CHECK only on INSERT/UPDATE of the row
// itself, not on FK cascade — which is the desired behavior. Code MUST
// NOT create a git audit row scoped to neither project nor workspace.
//
// Sensitive-data invariant (slice's security test asserts this):
//  - `args_json` records *summaries* of opts (e.g. `{"paths_count":3,
//    "force":false,"remote":"origin","commit_message_bytes":142}`) —
//    NEVER the commit message body, file contents, or remote URLs that
//    could carry credentials.
//  - `stderr_truncated` is bounded to ≤ 4096 bytes; truncation happens
//    in the writer (services layer), not at the DB.
//  - `exit_code` is NULL when the operation never reached `git` (path
//    missing, not_a_repo) — distinguishable from `0` (success).
//
// Indexes mirror the two dominant queries: "what did we do to project X
// recently" and "what did we do across workspace Y recently". Both are
// reverse-chronological (DESC on created_at) and partial — a row with
// no project_id is NOT indexed by `idx_git_audit_log_project_created`,
// keeping each index bounded by the live scoped population. Same for
// workspace.
//
// `created_at` uses `timestamp_ms` (Date <-> INTEGER ms) instead of the
// project-wide TEXT `datetime('now')` default. Two reasons:
//   1. Forensic queries frequently filter by sub-second windows (a
//      pull-then-push happens in ~50ms); ms precision is required.
//   2. The default is a JS `$defaultFn(() => new Date())`, which means
//      raw-SQL inserts MUST set the column explicitly — drizzle does
//      NOT emit a SQL DEFAULT clause for `$defaultFn`. The column is
//      `NOT NULL` so a missed insert path fails fast in tests rather
//      than silently writing 0/epoch.
export const gitAuditLog = sqliteTable("git_audit_log", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  action: text("action", {
    enum: [
      "pull",
      "commit",
      "push",
      "log",
      "branch_list",
      "checkout",
      "branch_delete",
      "diff",
      "discard",
      "fetch",
      "show",
      "stash_push",
      "stash_list",
      "stash_pop",
      "stash_drop",
    ],
  }).notNull(),
  argsJson: text("args_json").notNull(),
  exitCode: integer("exit_code"),
  reason: text("reason"),
  stderrTruncated: text("stderr_truncated"),
  durationMs: integer("duration_ms").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  check(
    "git_audit_log_scope_check",
    sql`project_id IS NOT NULL OR workspace_id IS NOT NULL`,
  ),
  index("idx_git_audit_log_project_created")
    .on(table.projectId, desc(table.createdAt))
    .where(sql`project_id IS NOT NULL`),
  index("idx_git_audit_log_workspace_created")
    .on(table.workspaceId, desc(table.createdAt))
    .where(sql`workspace_id IS NOT NULL`),
]);

// ─── FS Audit Log ───
// Append-only forensic record of every project- / workspace-scoped FS
// operation Flockctl exposes through the API. v1 is read-only
// (`action='read'`); future slices add `write` (slice 01), then `delete` /
// `rename` / `mkdir` (M01 slice 4). The action enum is intentionally narrow
// — broadening it requires both a CHECK-constraint amendment in
// `migrations/0049_fs_audit_log.sql` and a deliberate review of what data
// may safely flow into the row.
//
// Dedicated table (not reusing `git_audit_log`):
//  - git_audit_log's action enum + args_json shape are git-specific.
//  - File reads / writes carry no git equivalent; mixing them in would
//    force the CHECK to widen and the per-action queries to filter.
//
// Symmetric design with git_audit_log so operators can reason about both
// in the same mental model:
//  - INTEGER `ts` (epoch ms) matches `git_audit_log.created_at`.
//  - Both `project_id` and `workspace_id` columns; CHECK requires at least
//    one non-null at INSERT time. ON DELETE SET NULL on both FKs so the
//    forensic row outlives parent deletion.
//  - `entity_type` / `entity_id` carry the route-level scope (always
//    populated by the route handler) so a row keyed only by project_id /
//    workspace_id can still be located after the parent is deleted.
//  - `path` records the request-supplied relative path string (UTF-8). We
//    never persist the resolved absolute path — leaking absolute paths
//    would expose operator filesystem layout to anyone with audit access.
//
// Indexes are partial reverse-chronological compounds, one per scope, so
// "what files did Flockctl touch in project X recently" / "in workspace Y
// recently" runs index-only without a sort step.
export const fsAuditLog = sqliteTable("fs_audit_log", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  /** 'project' | 'workspace' — the route surface that originated the call. */
  entityType: text("entity_type").notNull(),
  /** Numeric id of the entity at request time (mirrors entity_type). */
  entityId: integer("entity_id").notNull(),
  /** FK to projects(id); set to NULL on parent delete (forensic survival). */
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  /** FK to workspaces(id); set to NULL on parent delete (forensic survival). */
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  /** Action enum — currently just 'read'; extended in subsequent slices. */
  action: text("action").notNull(),
  /** Request-supplied relative path string. Never the resolved abs path. */
  path: text("path").notNull(),
  /** 1 on success, 0 on failure. */
  ok: integer("ok").notNull(),
  /** FsErrorCode discriminator on failure rows; NULL on `ok=1`. */
  errorCode: text("error_code"),
  /** Wall-clock timestamp in unix-epoch milliseconds. */
  ts: integer("ts").notNull(),
  /**
   * SHA-256 of the on-disk content the writer overwrote. NULL when the file
   * did not exist (allowCreate path) or for non-write actions ('read',
   * 'mkdir', etc.). Added in migration 0056 for the write-file route's
   * forensic trail.
   */
  shaBefore: text("sha_before"),
  /**
   * SHA-256 of the bytes that ended up on disk after the atomic temp+rename.
   * NULL on failure rows (no rename happened) and on non-write actions.
   */
  shaAfter: text("sha_after"),
  /**
   * Number of bytes the caller posted (Buffer.byteLength, utf-8). Recorded
   * even on failure rows so the audit table exposes "the user TRIED to write
   * 12 MiB" cases instead of just "ok=0 fs_too_large" with no payload size.
   * NULL for non-write actions.
   */
  bytes: integer("bytes"),
}, (table) => [
  check(
    "fs_audit_log_entity_type_check",
    sql`entity_type IN ('project','workspace')`,
  ),
  check(
    "fs_audit_log_action_check",
    sql`action IN ('read','write','mkdir','create','rename','delete')`,
  ),
  check(
    "fs_audit_log_ok_check",
    sql`ok IN (0,1)`,
  ),
  check(
    "fs_audit_log_scope_check",
    sql`project_id IS NOT NULL OR workspace_id IS NOT NULL`,
  ),
  index("idx_fs_audit_log_project_ts")
    .on(table.projectId, desc(table.ts))
    .where(sql`project_id IS NOT NULL`),
  index("idx_fs_audit_log_workspace_ts")
    .on(table.workspaceId, desc(table.ts))
    .where(sql`workspace_id IS NOT NULL`),
]);

// ─── Scheduled Wakeups ───
// Persists "agent asked to be resumed at T" intent — typically captured
// from a `PostToolUse` hook on Claude Code's `ScheduleWakeup` tool — so a
// daemon-side worker can fire the wakeup even when the originating chat
// has no `/loop` dispatcher attached (in a vanilla chat the tool is a
// no-op and the conversation visibly stalls).
//
// Lifecycle: pending → fired | cancelled | missed.
//   - `fired`     — worker invoked the resume callback at or after
//                   `fire_at`; `fired_at` records the actual wall clock.
//   - `cancelled` — operator dismissed the wakeup or the owning session
//                   ended cleanly before the timer was due.
//   - `missed`    — daemon was down past `fire_at + grace`; row is
//                   preserved (NOT auto-fired) so the operator sees the
//                   missed wake in the inbox and decides what to do. This
//                   is the explicit "we don't lose chats" guarantee.
//
// Scope: each row belongs to exactly one running session — a chat OR a
// task, never both. The CHECK constraint asserts at-least-one; the
// service layer asserts exactly-one before INSERT. Cascade is ON DELETE
// CASCADE on both FKs because a wakeup against a deleted session has
// nothing to resume into.
//
// Hot-path query is the worker tick:
//   SELECT * FROM scheduled_wakeups
//    WHERE status='pending' AND fire_at <= ?  ORDER BY fire_at ASC
// covered by `idx_scheduled_wakeups_pending`, a partial index on
// `fire_at WHERE status='pending'` so the scan size is bounded by
// outstanding-pending rows, never the full table.
//
// `fire_at` / `fired_at` / `missed_at` / `cancelled_at` are unix-epoch
// SECONDS (matching missions' `unixepoch()` convention) — wakeups don't
// need sub-second precision; the worker tick is 10s on its own.
export const scheduledWakeups = sqliteTable("scheduled_wakeups", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  chatId: integer("chat_id").references(() => chats.id, { onDelete: "cascade" }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  claudeSessionId: text("claude_session_id").notNull(),
  fireAt: integer("fire_at").notNull(),
  prompt: text("prompt").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  firedAt: integer("fired_at"),
  missedAt: integer("missed_at"),
  cancelledAt: integer("cancelled_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  check(
    "scheduled_wakeups_status_check",
    sql`status IN ('pending','fired','cancelled','missed')`,
  ),
  check(
    "scheduled_wakeups_scope_check",
    sql`chat_id IS NOT NULL OR task_id IS NOT NULL`,
  ),
  index("idx_scheduled_wakeups_pending")
    .on(table.fireAt)
    .where(sql`status = 'pending'`),
  index("idx_scheduled_wakeups_chat")
    .on(table.chatId, desc(table.createdAt))
    .where(sql`chat_id IS NOT NULL`),
  index("idx_scheduled_wakeups_task")
    .on(table.taskId, desc(table.createdAt))
    .where(sql`task_id IS NOT NULL`),
]);

// ─── Plan-task → execution-task inverse index ───
//
// The plan store is FS-backed (markdown files). Resolving "which plan task
// points at execution task #N" used to do a full O(P × M × S × T) walk;
// this SQLite-side inverse index turns it into a PK lookup. See migration
// 0062 for the full rationale.
//
// Maintained by `plan-store/tasks.ts` (write path) and the auto-executor's
// fallback FS walk (drift-healing). Not FK-bound to anything — the
// execution_task_id is a soft pointer, and project_id is denormalised
// (no cascade) because the plan store can outlive the projects row in
// some pathological flows.
export const planTaskExecutionIndex = sqliteTable(
  "plan_task_execution_index",
  {
    executionTaskId: integer("execution_task_id").primaryKey(),
    projectId: integer("project_id").notNull(),
    milestoneSlug: text("milestone_slug").notNull(),
    sliceSlug: text("slice_slug").notNull(),
    taskSlug: text("task_slug").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_plan_task_exec_index_project").on(table.projectId),
  ],
);
