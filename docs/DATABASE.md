# Flockctl — Database Schema

> 10 Drizzle ORM tables, SQLite (WAL mode), drizzle-kit migrations. Task templates
> are no longer a database table — they are JSON files on disk. See
> [`src/services/templates.ts`](../src/services/templates.ts) for the template
> storage module.

## Database

- **Engine:** SQLite via better-sqlite3
- **Mode:** WAL (Write-Ahead Logging) for concurrent reads
- **Location:** `~/flockctl/flockctl.db` (configurable via `FLOCKCTL_HOME`)
- **ORM:** Drizzle ORM
- **Migrations:** `migrations/` directory, applied automatically on startup

## Entity Relationship

```
Workspace ──┬── Project ──┬── Task ── TaskLog
            │             ├── Schedule ── (template file on disk)
            │             └── (Plan files on disk)
            └── Chat ── ChatMessage

AIProviderKey (standalone)
UsageRecord → Task | ChatMessage | Project
BudgetLimit (standalone, scoped to global/workspace/project)
```

## Tables

### ai_provider_keys

AI provider API keys and CLI configurations.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| provider | TEXT | Not null (e.g. "anthropic", "openai", "claude_cli") |
| provider_type | TEXT | Not null ("api", "cli") |
| label | TEXT | Human-readable name |
| key_value | TEXT | API key (encrypted at rest) |
| cli_command | TEXT | CLI command override |
| env_var_name | TEXT | Environment variable name |
| config_dir | TEXT | Claude CLI config directory path |
| priority | INTEGER | Key selection priority (default: 0) |
| is_active | BOOLEAN | Whether key is enabled (default: true) |
| last_error | TEXT | Last error message |
| last_error_at | TEXT | Timestamp of last error |
| consecutive_errors | INTEGER | Error count for backoff (default: 0) |
| disabled_until | TEXT | Temporary disable timestamp |
| created_at | TEXT | ISO 8601 timestamp |

### workspaces

Logical groupings of projects.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| name | TEXT | Unique, not null |
| description | TEXT | |
| path | TEXT | Unique filesystem path, not null |
| allowed_key_ids | TEXT | JSON array of allowed key IDs |
| gitignore_flockctl | INTEGER | 0/1. Adds the whole `.flockctl/` directory to the auto-managed `.gitignore` block when 1. |
| gitignore_todo | INTEGER | 0/1. Adds `TODO.md` to the auto-managed `.gitignore` block when 1. |
| gitignore_agents_md | INTEGER | 0/1. Adds `AGENTS.md` + `CLAUDE.md` to the auto-managed `.gitignore` block when 1. |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

### projects

Code repositories managed by Flockctl. Portable config (`model`, `baseBranch`, `testCommand`, `permissionMode`, `disabledSkills`, `disabledMcpServers`, …) lives in `<project>/.flockctl/config.json` and is git-tracked. The DB keeps only machine-local state.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| workspace_id | INTEGER | FK → workspaces (on delete: set null) |
| name | TEXT | Not null |
| description | TEXT | |
| path | TEXT | Filesystem path |
| repo_url | TEXT | Git remote URL |
| required_providers | TEXT | JSON array |
| provider_fallback_chain | TEXT | JSON array |
| backoff_config | TEXT | JSON config |
| allowed_key_ids | TEXT | JSON array of allowed key IDs |
| denied_key_ids | TEXT | JSON array of denied key IDs |
| gitignore_flockctl | INTEGER | 0/1. Same semantics as the workspace column, applied to this project's `.gitignore`. |
| gitignore_todo | INTEGER | 0/1. Same semantics as the workspace column. |
| gitignore_agents_md | INTEGER | 0/1. Same semantics as the workspace column. |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

### tasks

AI agent task execution records.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| project_id | INTEGER | FK → projects (on delete: cascade) |
| prompt | TEXT | Task instruction text |
| prompt_file | TEXT | Path to prompt file |
| agent | TEXT | Agent CLI name |
| model | TEXT | Model override |
| image | TEXT | Image reference |
| command | TEXT | Shell command |
| working_dir | TEXT | Working directory |
| env_vars | TEXT | JSON env vars |
| status | TEXT | queued / assigned / running / done / failed / timed_out / cancelled / pending_approval |
| task_type | TEXT | execution / planning / verification / merge (default: execution) |
| target_slice_slug | TEXT | Slice this task belongs to |
| label | TEXT | Human-readable label |
| assigned_key_id | INTEGER | Key used for execution |
| allowed_key_ids | TEXT | JSON array |
| failed_key_ids | TEXT | JSON array of keys that errored |
| timeout_seconds | INTEGER | Execution timeout |
| max_retries | INTEGER | Max retry count (default: 0) |
| retry_count | INTEGER | Current retry count (default: 0) |
| parent_task_id | INTEGER | Parent task for retries |
| exit_code | INTEGER | Process exit code |
| error_message | TEXT | Error description |
| created_at | TEXT | ISO 8601 timestamp |
| started_at | TEXT | |
| completed_at | TEXT | |
| git_commit_before | TEXT | Git HEAD SHA before execution |
| git_commit_after | TEXT | Git HEAD SHA after execution |
| git_diff_summary | TEXT | One-line human summary (e.g. `"3 files changed, +42 / -17"`). Derived from the `file_edits` journal, not `git diff`. |
| file_edits | TEXT | JSON-serialized file-edit journal (`{ entries: [{ filePath, original, current }, …] }`). Populated per-tool-call from Edit / Write / MultiEdit / str_replace inputs. Consumed by `GET /tasks/:id/diff` to synthesize a session-isolated unified diff. |
| requires_approval | BOOLEAN | Whether task needs human approval (default: false) |
| approval_status | TEXT | approved / rejected |
| approved_at | TEXT | ISO 8601 timestamp |
| approval_note | TEXT | Reviewer note |
| permission_mode | TEXT | Agent permission policy: `default` / `acceptEdits` / `plan` / `bypassPermissions` / `auto`. Optional — `PermissionResolver` falls back to chat/project defaults. |
| claude_session_id | TEXT | Claude Code SDK session id for context continuity across retries |
| updated_at | TEXT | ISO 8601 timestamp |

**Indexes:** `idx_tasks_project_status` (project_id, status), `idx_tasks_status_created` (status, created_at)

### task_logs

Streaming output from task execution.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| task_id | INTEGER | FK → tasks (on delete: cascade) |
| content | TEXT | Log line content, not null |
| stream_type | TEXT | "stdout" or "stderr" (default: stdout) |
| timestamp | TEXT | ISO 8601 timestamp |

### schedules

Cron and one-shot task schedules. Schedules reference a template stored on disk
rather than a row in a `task_templates` table. See
[`src/services/templates.ts`](../src/services/templates.ts) for the template
storage module — templates live in `~/flockctl/templates/<name>.json` (global),
`<workspace>/.flockctl/templates/<name>.json` (workspace), or
`<project>/.flockctl/templates/<name>.json` (project).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| template_scope | TEXT | "global", "workspace", or "project", not null |
| template_name | TEXT | Template file basename, not null |
| template_workspace_id | INTEGER | FK → workspaces (on delete: cascade). Required when `template_scope = "workspace"` |
| template_project_id | INTEGER | FK → projects (on delete: cascade). Required when `template_scope = "project"` |
| assigned_key_id | INTEGER | FK → ai_provider_keys (on delete: set null). Preferred key for tasks spawned by this schedule — one template can be reused with different keys across schedules |
| schedule_type | TEXT | "cron" or "once", not null |
| cron_expression | TEXT | Cron syntax (for type "cron") |
| run_at | TEXT | ISO 8601 timestamp (for type "once") |
| timezone | TEXT | Default: "UTC" |
| status | TEXT | "active" or "paused" (default: active) |
| last_fire_time | TEXT | |
| next_fire_time | TEXT | |
| misfire_grace_seconds | INTEGER | |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

CHECK constraint: if `template_scope = "workspace"` then `template_workspace_id`
must be non-null; if `template_scope = "project"` then `template_project_id`
must be non-null; if `template_scope = "global"` both template-owner columns
must be null.

### chats

AI chat sessions.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| workspace_id | INTEGER | FK → workspaces (on delete: set null) |
| project_id | INTEGER | FK → projects (on delete: cascade) |
| title | TEXT | |
| claude_session_id | TEXT | Claude conversation ID for context continuity |
| entity_type | TEXT | Optional: "milestone", "slice", "task" |
| entity_id | TEXT | Entity identifier for plan-entity chats |
| permission_mode | TEXT | Per-chat permission policy override (see tasks.permission_mode) |
| ai_provider_key_id | INTEGER | FK → ai_provider_keys (on delete: set null). Persisted key selection; provider is derived from `ai_provider_keys.provider` via join. NULL falls back to the rc default |
| model | TEXT | Persisted model id (e.g. `claude-sonnet-4-20250514`). NULL falls back to project config → global default |
| file_edits | TEXT | JSON-serialized file-edit journal (`{ entries: [{ filePath, original, current }, …] }`). Accumulated across the chat's lifetime from Edit / Write / MultiEdit / str_replace tool inputs. Consumed by `GET /chats/:id/diff` to synthesize a session-isolated unified diff. |
| thinking_enabled | INTEGER | Adaptive extended-thinking toggle (bool, default 1). When 0, the SDK call adds `thinking: { type: "disabled" }` for the next turn. |
| effort | TEXT | Reasoning effort level (`low` / `medium` / `high` / `max`). NULL means "fall back to the default" (`high`). |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

### chat_messages

Messages within chat sessions.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| chat_id | INTEGER | FK → chats (on delete: cascade) |
| role | TEXT | "user" or "assistant", not null |
| content | TEXT | Message text, not null |
| created_at | TEXT | ISO 8601 timestamp |

**Indexes:** `idx_chat_messages_chat_created` (chat_id, created_at)

### usage_records

Token usage and cost tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| task_id | INTEGER | FK → tasks (on delete: set null) |
| chat_message_id | INTEGER | FK → chat_messages (on delete: set null) |
| project_id | INTEGER | FK → projects (on delete: set null) |
| ai_provider_key_id | INTEGER | FK → ai_provider_keys (on delete: set null) — which key produced the spend |
| provider | TEXT | Not null |
| model | TEXT | Not null |
| input_tokens | INTEGER | Default: 0 |
| output_tokens | INTEGER | Default: 0 |
| cache_creation_input_tokens | INTEGER | Default: 0 |
| cache_read_input_tokens | INTEGER | Default: 0 |
| total_cost_usd | REAL | Default: 0 |
| created_at | TEXT | ISO 8601 timestamp |

**Indexes:** `idx_usage_records_created` (created_at), `idx_usage_records_provider` (provider), `idx_usage_records_key` (ai_provider_key_id)

### budget_limits

Spending limits for cost control.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK, autoincrement |
| scope | TEXT | "global", "workspace", or "project" (not null) |
| scope_id | INTEGER | FK to workspace or project (null for global) |
| period | TEXT | "daily" or "monthly" (not null) |
| limit_usd | REAL | Spending limit in USD (not null) |
| action | TEXT | "pause" or "warn" (default: "pause") |
| is_active | BOOLEAN | Whether limit is enabled (default: true) |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

**Indexes:** `idx_budget_limits_scope` (scope, scope_id)

## Migrations

Migrations are stored in `migrations/` as SQL files generated by `drizzle-kit`. Applied automatically on daemon startup via `src/db/migrate.ts`.

```bash
npm run db:generate    # Generate new migration
npm run db:migrate     # Apply pending migrations
```
