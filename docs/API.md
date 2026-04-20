# Flockctl — API Reference

> Full REST, SSE, and WebSocket API reference.

## Base URL

```
http://localhost:52077
```

## Authentication

Flockctl ships with two modes, switched purely by the presence of `remoteAccessToken` in `~/.flockctlrc`:

- **Local mode** (no token configured) — every endpoint is open. This is the default.
- **Remote mode** (token configured, ≥32 chars) — every endpoint except the public ones below requires `Authorization: Bearer <token>` for any request whose client socket is not on localhost.

**Public endpoints** (always accessible — needed for connection probes and CORS):

- `GET /health`
- `OPTIONS *` (CORS preflight)

**Localhost bypass** — requests from `127.0.0.1`, `::1`, or `::ffff:127.0.0.1` never require the header. The check uses the Node socket's `remoteAddress`, not request headers, so it can't be spoofed with `X-Forwarded-For`.

**Rate limit** — 5 failed auth attempts per IP per 60 s → `429 { "error": "Too many failed attempts. Try again later." }`.

**WebSocket auth** — browser WebSocket APIs can't set headers, so non-local WS clients must append `?token=<token>` to the URL. Failure closes the socket with close code `1008` and reason `"Missing token"` / `"Invalid token"`.

## Pagination

List endpoints support:
- `page` (default: 1)
- `perPage` (default: 20)

Response: `{ items, total, page, perPage }`

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "ok", version, hostname }` — public, no auth required |

---

## Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | List tasks (filters: `status`, `project_id`, `task_type`, `label`, `created_after`, `created_before`) |
| GET | `/tasks/stats` | Task count stats by status (filter: `project_id`) |
| GET | `/tasks/:id` | Get task details (includes `liveMetrics` if running) |
| GET | `/tasks/:id/logs` | Get task execution logs |
| POST | `/tasks` | Create and queue task |
| POST | `/tasks/:id/cancel` | Cancel running or queued task |
| POST | `/tasks/:id/rerun` | Re-run task with same parameters |
| GET | `/tasks/:id/diff` | Get git diff for completed task |
| POST | `/tasks/:id/approve` | Approve a pending_approval task |
| POST | `/tasks/:id/reject` | Reject a pending_approval task (rolls back changes) |

### Create Task Body

```json
{
  "prompt": "Implement feature X",
  "promptFile": "path/to/prompt.md",
  "agent": "claude",
  "model": "claude-sonnet-4-20250514",
  "taskType": "execution",
  "label": "feature-x",
  "workingDir": "/path/to/repo",
  "timeoutSeconds": 3600,
  "maxRetries": 2,
  "envVars": { "KEY": "value" },
  "assignedKeyId": 1,
  "permissionMode": "acceptEdits"
}
```

`permissionMode` (optional) controls agent tool approval behavior. Values: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto`. If omitted, it falls back to the chat default, then project default (`PermissionResolver`).

---

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List projects |
| GET | `/projects/:id` | Get project with milestones |
| POST | `/projects` | Create project (clones repo if `repoUrl` provided) |
| PATCH | `/projects/:id` | Update project |
| DELETE | `/projects/:id` | Delete project |
| GET | `/projects/:id/tree` | Full plan task tree from filesystem |
| GET | `/projects/:id/stats` | Project statistics (tasks, milestones, usage) |
| GET | `/projects/:id/schedules` | Schedules for this project |
| GET | `/projects/:id/config` | Read .flockctl/config.json |
| PUT | `/projects/:id/config` | Write .flockctl/config.json (validates config) |

---

## Workspaces

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workspaces` | List workspaces |
| GET | `/workspaces/:id` | Get workspace with projects |
| POST | `/workspaces` | Create workspace (scaffolds `.flockctl/` directory) |
| PATCH | `/workspaces/:id` | Update workspace |
| DELETE | `/workspaces/:id` | Delete workspace |
| POST | `/workspaces/:id/projects` | Link existing project (`?project_id=N`) or create new |
| DELETE | `/workspaces/:id/projects/:projectId` | Remove project from workspace |
| GET | `/workspaces/:id/dashboard` | Aggregated metrics (tasks, milestones, costs, activity) |

---

## Chats

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chats` | Create chat session |
| GET | `/chats` | List chats with inline metrics (filters: `project_id`, `workspace_id`, `entity_type`, `entity_id`) |
| GET | `/chats/:id` | Get chat with all messages and metrics |
| GET | `/chats/:id/metrics` | Get full usage metrics for a chat |
| POST | `/chats/:id/messages` | Send message, get single AI response |
| POST | `/chats/:id/messages/stream` | Send message, stream AI response (SSE) |
| DELETE | `/chats/:id` | Delete chat |

### Chat Metrics

List (`GET /chats`) and detail (`GET /chats/:id`) responses include an inline `metrics` object:

```json
{
  "metrics": {
    "messageCount": 12,
    "userMessageCount": 6,
    "assistantMessageCount": 6,
    "totalInputTokens": 15000,
    "totalOutputTokens": 5000,
    "totalCostUsd": 0.0425,
    "lastMessageAt": "2026-04-16T12:30:00"
  }
}
```

Full metrics endpoint (`GET /chats/:id/metrics`) additionally includes:

```json
{
  "chatId": 1,
  "createdAt": "2026-04-16T10:00:00",
  "updatedAt": "2026-04-16T12:30:00",
  "totalCacheCreationTokens": 3000,
  "totalCacheReadTokens": 1500,
  "modelsUsed": ["claude-sonnet-4-20250514"]
}
```

### Create Chat Body

```json
{
  "projectId": 1,
  "workspaceId": 1,
  "title": "Chat title",
  "entityType": "milestone",
  "entityId": "my-milestone-slug"
}
```

### Stream Message Body

```json
{
  "content": "User message",
  "model": "claude-sonnet-4-20250514",
  "system": "Custom system prompt",
  "keyId": 1,
  "entity_context": {
    "entity_type": "slice",
    "entity_id": "slice-slug",
    "milestone_id": "milestone-slug"
  }
}
```

SSE response: `data: { "content": "...", "done": false, "usage": {...} }`

---

## Planning

### Milestones

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects/:pid/milestones` | Create milestone |
| GET | `/projects/:pid/milestones` | List milestones |
| GET | `/projects/:pid/milestones/:slug` | Get milestone |
| PATCH | `/projects/:pid/milestones/:slug` | Update milestone |
| DELETE | `/projects/:pid/milestones/:slug` | Delete milestone |

### Slices

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects/:pid/milestones/:mslug/slices` | Create slice |
| GET | `/projects/:pid/milestones/:mslug/slices` | List slices |
| GET | `/projects/:pid/milestones/:mslug/slices/:sslug` | Get slice |
| PATCH | `/projects/:pid/milestones/:mslug/slices/:sslug` | Update slice |
| DELETE | `/projects/:pid/milestones/:mslug/slices/:sslug` | Delete slice |

### Plan Tasks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects/:pid/milestones/:mslug/slices/:sslug/tasks` | Create plan task |
| GET | `/projects/:pid/milestones/:mslug/slices/:sslug/tasks` | List plan tasks |
| GET | `/projects/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug` | Get plan task |
| PATCH | `/projects/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug` | Update plan task |
| DELETE | `/projects/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug` | Delete plan task |

### Plan Generation & Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects/:pid/generate-plan` | Generate plan via AI (`{ prompt, mode }`, mode: "quick" or "deep") |
| POST | `/projects/:pid/milestones/:mslug/auto-execute` | Start auto-execution for milestone |
| DELETE | `/projects/:pid/milestones/:mslug/auto-execute` | Stop auto-execution |
| GET | `/projects/:pid/milestones/:mslug/auto-execute` | Auto-execution status |
| GET | `/projects/:pid/milestones/:mslug/execution-graph` | Execution dependency graph (waves, critical path) |
| POST | `/projects/:pid/auto-execute-all` | Start auto-execution for all milestones |

### Plan Files

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects/:pid/plan-file?type=...&milestone=...&slice=...&task=...` | Get plan file raw content |
| PUT | `/projects/:pid/plan-file` | Update plan file content |

---

## Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/templates` | List templates (filter: `project_id`) |
| GET | `/templates/:id` | Get template |
| POST | `/templates` | Create template |
| PATCH | `/templates/:id` | Update template |
| DELETE | `/templates/:id` | Delete template |

---

## Schedules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/schedules` | List schedules (filters: `status`, `schedule_type`) |
| GET | `/schedules/:id` | Get schedule with template info |
| POST | `/schedules` | Create schedule (`scheduleType`: "cron" or "once") |
| PATCH | `/schedules/:id` | Update schedule |
| DELETE | `/schedules/:id` | Delete schedule |
| POST | `/schedules/:id/pause` | Pause schedule |
| POST | `/schedules/:id/resume` | Resume schedule |

---

## AI Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/keys` | List keys (values redacted) |
| GET | `/keys/providers` | List available providers |
| GET | `/keys/claude-cli/status` | Claude CLI readiness (installed, authenticated, models) |
| GET | `/keys/:id` | Get single key (redacted) |
| POST | `/keys` | Create key |
| PATCH | `/keys/:id` | Update key |
| DELETE | `/keys/:id` | Delete key |
| POST | `/keys/:id/test` | Test key connectivity |

---

## Usage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/usage/summary` | Aggregated usage (filters: `project_id`, `task_id`, `chat_id`, `provider`, `model`, `date_from`, `date_to`, `period`, `workspace_id`) |
| GET | `/usage/breakdown` | Paginated breakdown (`group_by`: "provider", "model", "project", "day") |
| GET | `/usage/budgets` | List budget limits with current spend |
| POST | `/usage/budgets` | Create budget limit |
| PATCH | `/usage/budgets/:id` | Update budget limit (limit_usd, action, is_active) |
| DELETE | `/usage/budgets/:id` | Delete budget limit |

---

## Metrics (Analytics)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/metrics/overview` | Comprehensive analytics overview (filters: `period`, `date_from`, `date_to`) |

### Response structure

```json
{
  "time": {
    "totalWorkSeconds": 0,
    "avgDurationSeconds": null,
    "medianDurationSeconds": null,
    "avgQueueWaitSeconds": null,
    "peakHours": [{ "hour": 14, "count": 5 }]
  },
  "productivity": {
    "tasksByStatus": { "total": 0, "completed": 0, "failed": 0, ... },
    "successRate": null,
    "retryRate": null,
    "tasksWithCodeChanges": 0,
    "codeChangeRate": null,
    "avgTasksPerDay": null,
    "tasksPerDay": [{ "day": "2026-04-15", "count": 3 }]
  },
  "cost": {
    "totalCostUsd": 0,
    "totalInputTokens": 0,
    "totalOutputTokens": 0,
    "totalCacheCreation": 0,
    "totalCacheRead": 0,
    "cacheHitRate": null,
    "avgCostPerTask": null,
    "costByOutcome": [{ "outcome": "success", "avgCost": 0, "totalCost": 0, "taskCount": 0 }],
    "burnRatePerDay": null,
    "dailyCosts": [{ "day": "2026-04-15", "cost": 0.5 }]
  },
  "chats": {
    "totalChats": 0,
    "avgMessagesPerChat": null,
    "avgChatDurationSeconds": null,
    "totalChatTimeSeconds": 0
  },
  "schedules": {
    "total": 0,
    "active": 0,
    "paused": 0
  }
}
```

---

## Skills

### CRUD (Global / Workspace / Project)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills/global` | List global skills |
| POST | `/skills/global` | Create/update global skill |
| GET | `/skills/workspaces/:id/skills` | List workspace skills |
| POST | `/skills/workspaces/:id/skills` | Create/update workspace skill |
| DELETE | `/skills/workspaces/:id/skills/:name` | Delete workspace skill |
| GET | `/skills/workspaces/:wid/projects/:pid/skills` | List project skills |
| POST | `/skills/workspaces/:wid/projects/:pid/skills` | Create/update project skill |
| DELETE | `/skills/workspaces/:wid/projects/:pid/skills/:name` | Delete project skill |
| GET | `/skills/resolved?projectId=&taskId=` | Get merged skills (hierarchy-resolved) |

### Disable/Enable

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills/workspaces/:id/disabled` | List disabled skills for workspace. Returns `{ disabledSkills: Array<{ name, level }> }` |
| POST | `/skills/workspaces/:id/disabled` | Disable skill at workspace level. Body: `{ name, level }` where level ∈ `"global" \| "workspace"` |
| DELETE | `/skills/workspaces/:id/disabled` | Re-enable skill at workspace level. Body: `{ name, level }` (not a path param — the `(name, level)` pair is the identity) |
| GET | `/skills/projects/:pid/disabled` | List disabled skills for project |
| POST | `/skills/projects/:pid/disabled` | Disable skill at project level. Body: `{ name, level }` where level ∈ `"global" \| "workspace" \| "project"` |
| DELETE | `/skills/projects/:pid/disabled` | Re-enable skill at project level. Body: `{ name, level }` |

> Task-level disable was removed in migration 0023. Disables live only at workspace and project scope. The `level` field identifies *which inherited tier* the disable targets, so a project can independently mask a global skill without affecting the workspace.

---

## MCP Servers

### CRUD (Global / Workspace / Project)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/mcp/global` | List global MCP servers |
| POST | `/mcp/global` | Create/update global MCP server |
| DELETE | `/mcp/global/:name` | Delete global MCP server |
| GET | `/mcp/workspaces/:id/servers` | List workspace MCP servers |
| POST | `/mcp/workspaces/:id/servers` | Create/update workspace MCP server |
| DELETE | `/mcp/workspaces/:id/servers/:name` | Delete workspace MCP server |
| GET | `/mcp/workspaces/:wid/projects/:pid/servers` | List project MCP servers |
| POST | `/mcp/workspaces/:wid/projects/:pid/servers` | Create/update project MCP server |
| DELETE | `/mcp/workspaces/:wid/projects/:pid/servers/:name` | Delete project MCP server |
| GET | `/mcp/resolved?projectId=&taskId=` | Get merged MCP servers (hierarchy-resolved) |

### Disable/Enable

| Method | Path | Description |
|--------|------|-------------|
| GET | `/mcp/workspaces/:id/disabled-mcp` | List disabled MCP servers for workspace. Returns `{ disabledMcpServers: Array<{ name, level }> }` |
| POST | `/mcp/workspaces/:id/disabled-mcp` | Disable MCP server at workspace level. Body: `{ name, level }` |
| DELETE | `/mcp/workspaces/:id/disabled-mcp` | Re-enable MCP server at workspace level. Body: `{ name, level }` |
| GET | `/mcp/projects/:pid/disabled-mcp` | List disabled MCP servers for project |
| POST | `/mcp/projects/:pid/disabled-mcp` | Disable MCP server at project level. Body: `{ name, level }` |
| DELETE | `/mcp/projects/:pid/disabled-mcp` | Re-enable MCP server at project level. Body: `{ name, level }` |

> The MCP disable path is `/disabled-mcp` (not `/disabled`) to keep it distinct from the skills endpoint. Same `{ name, level }` contract as skills. Task-level disable was removed in migration 0023.

---

## Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/meta` | Available agents, models, API keys, and defaults (`defaults` includes `model`, `planningModel`, `agent`, `keyId`) |
| PATCH | `/meta/defaults` | Update global defaults persisted to `~/.flockctlrc`. Body: `{ defaultModel?: string \| null, defaultKeyId?: number \| null }` — pass `null` to clear. Returns the resolved `{ model, planningModel, agent, keyId }`. Returns `404` if `defaultKeyId` does not match an existing AI Provider Key. |
| GET | `/meta/remote-servers` | List configured remote daemons (for the UI server-switcher). Tokens are never returned; each entry has `{ id, name, url, hasToken }` |
| POST | `/meta/remote-servers` | Add a remote server. Body: `{ name, url, token? }`. URL must be `http(s)://...`. Returns the saved entry (no token). |
| PATCH | `/meta/remote-servers/:id` | Update a remote server. Pass `token: null` to clear the stored token. |
| DELETE | `/meta/remote-servers/:id` | Remove a remote server. |
| POST | `/meta/remote-servers/:id/proxy-token` | Return `{ token }` — used by the local UI to attach credentials when proxying to the remote daemon. |

Remote server persistence: all entries live in `~/.flockctlrc` under `remoteServers`. The `GET` endpoint never leaks tokens; `/proxy-token` does, so it must itself be reachable only under the local-mode defaults or with a valid local token.

---

## WebSocket

| Type | Path | Description |
|------|------|-------------|
| HTTP | `GET /ws/status` | Client count |
| WS | `/ws/ui/tasks/:taskId/logs` | Live task execution log stream |
| WS | `/ws/ui/chats/:chatId/events` | Live per-chat events (permission requests, session start/end) |
| WS | `/ws/ui/chats/events` | Global chat events stream (for the chat list indicators) |

All WebSocket endpoints respect the same auth rules as REST: in remote mode, non-local connections must include `?token=<token>` or they are closed with code `1008`.

---

## Error Responses

All endpoints return errors as:

```json
{
  "error": "Error message",
  "details": "Optional details"
}
```

Common status codes: `401` (missing/invalid bearer token in remote mode), `404` (not found), `422` (validation error), `429` (rate-limited after repeated auth failures), `500` (internal error).
