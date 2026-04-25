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

## Conventions

- **Request / response casing.** Response bodies use `camelCase` (Drizzle rows go out as-is). Request bodies accept both `camelCase` and `snake_case` for boolean / scalar fields where documented (the chat-message API accepts `thinking_enabled` and `thinkingEnabled` interchangeably, for example). When a shape is specified below, always prefer the documented casing.
- **Error shape.** All non-2xx responses share one envelope: `{ "error": "<human-readable message>" }`. Validation failures → `422`, missing rows → `404`, auth failures → `401`, rate limit → `429`.
- **DELETE responses.** Delete endpoints return `{ "deleted": true }` on success (skills / secrets / MCP servers) or `{ "ok": true }` on generic deletes (budgets, tasks) — both are consistently `200 OK`, never `204 No Content`.
- **Create responses.** Most `POST` handlers return the created row with `201 Created`. Skills / MCP writes return `{ name, level, saved: true }` instead because the underlying storage is filesystem-backed (no DB row to return).

### Mandatory request fields (summary)

| Endpoint | Required body fields | Notes |
|---|---|---|
| `POST /projects` | `name`, `allowedKeyIds: number[]` (non-empty, active IDs) | `path`, `repoUrl`, `workspaceId` are all optional. |
| `PATCH /projects/:id` | — (all fields optional) | When `allowedKeyIds` is present it must be a non-empty array of active IDs; omit it to leave the allow-list untouched. |
| `POST /workspaces` | `name`, `path`, `allowedKeyIds: number[]` | Same `allowedKeyIds` rules as above. |
| `PATCH /workspaces/:id` | — (all fields optional) | See `PATCH /projects/:id`. |
| `POST /workspaces/:id/projects` (create mode) | `name`, `allowedKeyIds: number[]` | Link mode (query-only `?project_id=N`) has no body. |
| `POST /chats` | `title` | Optional: `projectId`, `workspaceId`, `entityType` + `entityId`, `aiProviderKeyId`, `model`. |
| `POST /chats/:id/messages` | `content` | Attachments via `attachment_ids: number[]` (max 10). |
| `POST /chats/:id/messages/stream` | `content` | Same body as the non-stream variant. |
| `POST /ai-keys` | `label`, `provider`, `keyValue` | `isActive` defaults to `true`. |
| `POST /usage/budgets` | `scope`, `period`, `limitUsd` | `scopeId` required for `workspace` / `project` scopes. |
| `POST /skills/{global,workspace,project}` | `name`, `content` | Filesystem-backed, no DB row returned. |
| `POST /mcp/{global,workspace,project}` | `name`, `config` | Same shape across levels. |
| `POST /secrets/{global,workspace,project}` | `name`, `value` | `description` optional. |
| `POST /schedules` | `name`, `cron`, `taskId` \| `projectId` | At least one target required. |

Fields not listed above are optional. 422 responses always name the offending field so a client doesn't have to guess.

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "ok", version, hostname }` — public, no auth required |

---

## Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | List tasks (filters: `status`, `project_id`, `task_type`, `label`, `created_after`, `created_before`, `include_superseded`). By default `failed` / `timed_out` rows whose rerun chain already reached a `done` / `completed` state are hidden (the build effectively succeeded); pass `include_superseded=true` to get the full audit history back. Each item includes `assigned_key_label` (the AI key the task was assigned to) and `actual_model_used` (the most recent `model` from `usage_records` for this task — `null` until the task produces a usage record). |
| GET | `/tasks/stats` | Task count stats by status (filter: `project_id`). Response also includes `failedRerun` / `failedNotRerun` — how many `failed` tasks were subsequently rerun (manual `/rerun` and auto-retry are counted together) vs. never rerun — plus `supersededFailures` (failed/timed_out rows whose rerun chain landed on a successful terminal state, i.e. the build effectively succeeded) and `buildAfterRerun` (successful `done` / `completed` tasks that are themselves a rerun — the "re-run rescued the build" count). |
| GET | `/tasks/:id` | Get task details. Includes `liveMetrics` when the task is running, `parentTaskId` when this task is itself a rerun, and `children: Array<{id, status, label, createdAt}>` listing any reruns (manual + auto-retry) spawned from this task — used by the UI to render the rerun chain without extra round-trips. Also includes `assigned_key_label` and `actual_model_used` (same semantics as the list endpoint). |
| GET | `/tasks/:id/logs` | Get task execution logs |
| POST | `/tasks` | Create and queue task |
| POST | `/tasks/:id/cancel` | Cancel running or queued task |
| POST | `/tasks/:id/rerun` | Re-run task with same parameters |
| GET | `/tasks/:id/diff` | Synthesized unified diff for the task, built from the in-DB file-edit journal (Edit / Write / MultiEdit / str_replace tool inputs). Response: `{ summary, diff, truncated, total_lines, total_files, total_entries }`. Session-isolated — does not shell out to `git diff`, so parallel tasks in the same working tree don't cross-contaminate. Accepts `?maxLines=<n>` (default 2000) to cap the returned diff. |
| POST | `/tasks/:id/approve` | Approve a pending_approval task |
| POST | `/tasks/:id/reject` | Reject a pending_approval task (rolls back changes) |
| GET | `/tasks/:id/pending-permissions` | List permission requests a running task is blocked on (used to re-hydrate the UI card after a reload) |
| POST | `/tasks/:id/permission/:requestId` | Respond to a tool permission request (`behavior: "allow" \| "deny"`) |
| GET | `/tasks/:id/pending-questions` | List open `AskUserQuestion` requests awaiting an answer. DB-backed so it survives daemon restarts (the `waiting_for_input` status is persisted on the task row) |
| GET | `/tasks/:id/questions` | Same as `pending-questions` — preferred spelling, mirrors the REST-ier `/answer` subresource below |
| POST | `/tasks/:id/question/:requestId` | Answer an open agent question (`{ answer: "…" }`). Hot path: flips `waiting_for_input` → `running`. Cold path (post-restart): persists the answer, flips to `queued`, and resumes the prior Claude Code session via `claudeSessionId` |
| POST | `/tasks/:id/question/:requestId/answer` | Answer an open agent question (`{ answer: "…" }`, 1–8000 chars). Zod-validates path params + body (400 on malformed). 404 for unknown / wrong-task requestId, 409 if the question was already resolved. Response: `{ ok: true, taskStatus }` |

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
| POST | `/projects` | Create project (clones repo if `repoUrl` provided). Body requires `allowedKeyIds: number[]` — a non-empty array of active AI-provider key IDs the project is permitted to use. Empty / missing / containing an inactive or unknown ID → `422`. Optional booleans `gitignoreFlockctl`, `gitignoreTodo`, `gitignoreAgentsMd` (all default `false`) control what the auto-managed `.gitignore` block adds: the whole `.flockctl/` directory, `TODO.md`, and `AGENTS.md` + `CLAUDE.md` respectively. |
| PATCH | `/projects/:id` | Update project. When `allowedKeyIds` is present in the body it must be a non-empty array of active AI-provider key IDs — `null` / `[]` / unknown or inactive IDs → `422`. Omit the field to leave the existing allow-list untouched. The three `gitignore*` booleans above are independently patchable; changing any of them (or `permissionMode`) triggers a gitignore + skills/MCP/agents reconcile. |
| DELETE | `/projects/:id` | Delete project |
| GET | `/projects/:id/tree` | Full plan task tree from filesystem |
| GET | `/projects/:id/stats` | Project statistics (tasks, milestones, usage) |
| GET | `/projects/:id/schedules` | Schedules for this project |
| GET | `/projects/:id/config` | Read .flockctl/config.json |
| PUT | `/projects/:id/config` | Write .flockctl/config.json (validates config) |
| GET | `/projects/:id/todo` | Read `<project>/TODO.md`. Returns `{ content, path }`; empty `path` means the project row has no filesystem root. |
| PUT | `/projects/:id/todo` | Write `<project>/TODO.md`. Body: `{ content: string }` (max 256 KB). |
| GET | `/projects/:id/allowed-keys` | Resolve the effective AI-key allow-list for this project (project → workspace inheritance). Returns `{ allowedKeyIds: number[] \| null, source: "project" \| "workspace" \| "none" }`. `null` means no restriction. |
| GET | `/projects/:id/agents-md` | Read the project's AGENTS.md layer. Response: `{ layers: { "project-public": LayerContent } }` where `LayerContent = { present: boolean, bytes: number, content: string }`. Returns `present: false` / `bytes: 0` / `content: ""` when the project has no filesystem path or the file is absent. |
| PUT | `/projects/:id/agents-md` | Write the project's AGENTS.md layer. Body: `{ content: string }`. Empty `content` deletes the underlying file. >256 KiB → `413`; project without filesystem path → `422`. Never cascades to sibling or workspace files. Response: `{ layer: "project-public", present, bytes }`. |
| GET | `/projects/:id/agents-md/effective` | Merged three-layer agent guidance a session rooted at this project would see. Walks `user` (`<flockctlHome>/AGENTS.md`) → `workspace-public` (resolved via the project's `workspaceId`) → `project-public`, concatenated with banner headers. Response: the raw `LoaderOutput` — `{ layers: LayerResult[], totalBytes, truncatedLayers, mergedWithHeaders }` (shape detailed below). See [AGENTS-LAYERING.md](AGENTS-LAYERING.md) for the layer contract. |

---

## Workspaces

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workspaces` | List workspaces |
| GET | `/workspaces/:id` | Get workspace with projects |
| POST | `/workspaces` | Create workspace (scaffolds `.flockctl/` directory). Body requires `allowedKeyIds: number[]` — a non-empty array of active AI-provider key IDs the workspace is permitted to use. Empty / missing / containing an inactive or unknown ID → `422`. Optional booleans `gitignoreFlockctl`, `gitignoreTodo`, `gitignoreAgentsMd` (all default `false`) have the same meaning as on `POST /projects`. |
| PATCH | `/workspaces/:id` | Update workspace. When `allowedKeyIds` is present in the body it must be a non-empty array of active AI-provider key IDs — `null` / `[]` / unknown or inactive IDs → `422`. Omit the field to leave the existing allow-list untouched. The three `gitignore*` booleans above are independently patchable; changing any of them (or `permissionMode`) triggers a gitignore reconcile on the workspace and every child project with a filesystem path. |
| DELETE | `/workspaces/:id` | Delete workspace |
| POST | `/workspaces/:id/projects` | Link existing project (`?project_id=N`) or create new. When creating (request has JSON body), the same `allowedKeyIds` requirement as `POST /projects` applies; link mode (query-only) has no body and is unaffected. |
| DELETE | `/workspaces/:id/projects/:projectId` | Remove project from workspace |
| GET | `/workspaces/:id/dashboard` | Aggregated metrics (tasks, milestones, costs, activity) |
| GET | `/workspaces/:id/todo` | Read `<workspace>/TODO.md`. Returns `{ content, path }`. |
| PUT | `/workspaces/:id/todo` | Write `<workspace>/TODO.md`. Body: `{ content: string }` (max 256 KB). No cascade to child projects. |
| GET | `/workspaces/:id/agents-md` | Read the workspace's AGENTS.md layer. Response: `{ layers: { "workspace-public": LayerContent } }` where `LayerContent = { present, bytes, content }`. Returns `present: false` when the workspace has no filesystem path or the file is absent. |
| PUT | `/workspaces/:id/agents-md` | Write the workspace's AGENTS.md layer. Body: `{ content: string }`. Empty `content` deletes the underlying file. >256 KiB → `413`; workspace without filesystem path → `422`. **Never cascades to child projects** — every project scope owns its own editable file. Response: `{ layer: "workspace-public", present, bytes }`. |
| GET | `/workspaces/:id/agents-md/effective` | Merged agent guidance a session rooted at this workspace would see. Resolves layers 1–2 only (`user` → `workspace-public`); project layers are intentionally skipped — there is no project scope at the workspace level. Response: the raw `LoaderOutput` shape (detailed below). |

### AGENTS.md layer shape

`GET /projects/:id/agents-md/effective` and `GET /workspaces/:id/agents-md/effective` return the raw `LoaderOutput`:

```json
{
  "layers": [
    {
      "layer": "user",
      "path": "/Users/me/flockctl/AGENTS.md",
      "bytes": 412,
      "content": "# User rules\n- Prefer small commits.\n",
      "truncated": false
    },
    {
      "layer": "workspace-public",
      "path": "/Users/me/flockctl/workspaces/main/AGENTS.md",
      "bytes": 1804,
      "content": "...",
      "truncated": false
    }
  ],
  "totalBytes": 2216,
  "truncatedLayers": [],
  "mergedWithHeaders": "<!-- flockctl:agent-guidance layer=user path=... bytes=412 -->\n...\n<!-- flockctl:agent-guidance end total_bytes=2216 -->"
}
```

`layer` is one of `"user"`, `"workspace-public"`, `"project-public"`. Missing / empty / traversal-rejected / legacy-reconciler-marked files are omitted from `layers`, not emitted with empty content. Per-layer cap is 256 KiB; total merged cap is 1 MiB — see [AGENTS-LAYERING.md](AGENTS-LAYERING.md) for truncation semantics and the `mergedWithHeaders` banner format.

---

## Chats

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chats` | Create chat session — **idempotent** when `projectId` + `entityType` + `entityId` are all supplied: returns the existing row (HTTP 200) instead of duplicating. Without the triple, always creates a fresh row (HTTP 201). |
| GET | `/chats` | List chats with inline metrics (filters: `project_id`, `workspace_id`, `entity_type`, `entity_id`). Backed by `idx_chats_entity (project_id, entity_type, entity_id)` for O(log n) entity lookups. |
| GET | `/chats/:id` | Get chat with all messages and metrics. Each user message row carries a `attachments[]` array with the linked `chat_attachments` rows; assistant / system rows come back with `[]`. |
| POST | `/chats/:id/attachments` | Upload an attachment blob (multipart/form-data, single `file` part). Accepts images (`image/png`, `image/jpeg`, `image/webp`, `image/gif`), PDFs (`application/pdf`), and any UTF-8 text-like file (source code, CSV, XML, JSON, YAML, Markdown, HTML, logs, diffs, …). Content type is determined by **magic-byte sniff + filename extension**, never by the browser-supplied MIME alone — a client that claims `image/png` but uploads a PDF or random binary is rejected with `422`. Per-file cap: **30 MB**. Response: the inserted `chat_attachments` row (`{ id, chat_id, path, filename, size_bytes, mime_type, … }`), which the client then passes in `attachment_ids` on the next `/messages[/stream]` call. |
| GET | `/chats/:id/attachments/:attId/blob` | Stream the stored attachment file inline. Served via `fs.createReadStream` (never buffered into memory) with `Content-Type: <stored mime_type>`, `Content-Length`, `Content-Disposition: inline; filename*=UTF-8''<encoded>`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600`. Returns `404` when the attachment id is unknown, when its `chat_id` does not match the URL's chat id (cross-chat isolation), or when the on-disk blob is missing. |
| GET | `/chats/:id/metrics` | Get full usage metrics for a chat |
| GET | `/chats/:id/diff` | Synthesized unified diff covering every Edit / Write / MultiEdit tool call the agent made over the lifetime of this chat. Same response shape as `/tasks/:id/diff`: `{ summary, diff, truncated, total_lines, total_files, total_entries }`. Built from the chat's `file_edits` journal column, so parallel chats in the same project don't cross-contaminate. Accepts `?maxLines=<n>` (default 2000). The UI invalidates this query on the `chat_diff_updated` WebSocket frame so the "Changes" card stays live during an assistant turn. |
| POST | `/chats/:id/messages` | Send message, get single AI response |
| POST | `/chats/:id/messages/stream` | Send message, stream AI response (SSE) |
| POST | `/chats/:id/cancel` | Abort the currently running chat turn |
| POST | `/chats/:id/approve` | Approve a chat sitting in `approval_status='pending'`. Body: `{ note?: string }`. Symmetric with `POST /tasks/:id/approve`: clears the `chat_approval` blocker from `/attention` and fires `attention_changed`. 404 if chat unknown, 422 if `approval_status` is not `pending`. Response: `{ ok: true }` |
| POST | `/chats/:id/reject` | Reject a chat in `approval_status='pending'`. Body: `{ note?: string }`. Flips `approval_status` to `rejected`, records the note, and clears the attention blocker. No rollback path (chats produce no git commits). Future turns re-enter pending while `requires_approval=true`; flip that off via PATCH to stop the cycle. Response: `{ ok: true }` |
| GET | `/chats/pending-permissions` | Global snapshot of `{ chat_id: pending_count }` + running chat IDs (seeds chat list badges) |
| GET | `/chats/:id/pending-permissions` | List permission requests a running chat session is blocked on (used to re-hydrate the UI card after a reload) |
| POST | `/chats/:id/permission/:requestId` | Respond to a tool permission request (`behavior: "allow" \| "deny"`) |
| GET | `/chats/:id/pending-questions` | List open `AskUserQuestion` requests for this chat. Chats have no explicit `waiting_for_input` column — the derived flag is `EXISTS(pending agent_question WHERE chat_id=?)`. The UI uses this to re-hydrate the question card on page reload |
| GET | `/chats/:id/questions` | Same as `pending-questions` — preferred spelling, mirrors the REST-ier `/answer` subresource below |
| POST | `/chats/:id/question/:requestId` | Answer an open agent clarification question (`{ answer: "…" }`). Requires the chat session to be in-memory (the answer is relayed to the in-flight `AgentSession`) |
| POST | `/chats/:id/question/:requestId/answer` | Answer an open agent question (`{ answer: "…" }`, 1–8000 chars). Zod-validates path params + body (400 on malformed). 404 for unknown / wrong-chat requestId, 409 if the question was already resolved. Response: `{ ok: true }` |
| POST | `/chats/:id/extract-incident` | Run the Haiku-backed incident extractor over this chat's transcript and return a structured draft `{ title, symptom, rootCause, resolution, tags[] }` for the "Save as incident" UI. Body: `{ messageIds?: number[], skipExtract?: boolean }` — `messageIds` filters the transcript to a subset; `skipExtract` returns an empty draft without calling the LLM. The extractor already degrades to an empty draft on any error or when no active AI keys are configured, so this endpoint never surfaces extraction failures as 5xx. |
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
  "entityId": "my-milestone-slug",
  "aiProviderKeyId": 3,
  "model": "claude-sonnet-4-20250514",
  "requiresApproval": false
}
```

`aiProviderKeyId` and `model` are optional at create-time and persist across reloads. Provider is derived from the referenced key's `.provider` column, so the chat's provider never drifts from its key. NULL for either field means "fall back to project config → rc defaults on the next turn".

`requiresApproval` is an opt-in flag (default `false`). When `true`, the chat flips `approval_status` to `pending` after every successful assistant turn and surfaces as a `chat_approval` blocker in `/attention` until the user calls `POST /chats/:id/{approve,reject}`. Symmetric with the task-side flag on `POST /tasks`.

### Update Chat Body (`PATCH /chats/:id`)

```json
{
  "title": "New title",
  "permission_mode": "plan",
  "aiProviderKeyId": 3,
  "model": "claude-sonnet-4-20250514",
  "requiresApproval": true,
  "thinkingEnabled": true,
  "effort": "high"
}
```

All fields optional. Pass `null` for `aiProviderKeyId` or `model` to clear the stored selection (the next turn re-resolves from defaults). Sending a whitespace-only model string is treated the same as `null`. A malformed `aiProviderKeyId` (non-positive / non-integer) or non-string `model` returns `422`. `requiresApproval` must be a strict boolean (422 otherwise); flipping from `true` to `false` also clears `approval_status` on the next turn by simply not re-entering the pending state.

**Adaptive thinking + effort (`thinkingEnabled`, `effort`):** persisted per chat and forwarded to the Claude Agent SDK on every turn. `thinkingEnabled` must be a strict boolean — `true` (default) lets the SDK decide when to emit thinking blocks (adaptive on supported models); `false` forwards `thinking: { type: "disabled" }` so the model skips the think step entirely. `effort` must be one of `"low" | "medium" | "high" | "max"` — or `null` to clear the stored pick and fall back to the default (`"high"`, unchanged from the prior hard-coded value). Anything else returns `422`. The same field names are also accepted on `POST /chats/:id/messages` and `POST /chats/:id/messages/stream` (snake_case `thinking_enabled` or camelCase both work) as per-turn overrides that also write back to the chat row — same save-on-change contract as `model` / `keyId`.

**`permission_mode` propagates live.** If a PATCH changes `permission_mode` while a chat session is in flight, the handler pushes the new effective mode (chat → project → workspace → `"auto"`) into the running `AgentSession` instead of waiting for the next turn. Relaxing the mode auto-resolves pending permission requests the new mode would have allowed:

- `bypassPermissions` → every pending request is resolved as `allow`.
- `acceptEdits` → pending file-write requests (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`) auto-allow; others stay pending.
- `auto` → re-runs the path-scoped decision per pending request (read-only tools and writes inside the allowed roots allow; the rest stay pending).
- `default` / `plan` → no pending entries are auto-resolved; only future tool requests inside this turn observe the new mode.

The session broadcasts a `chat_permission_mode_changed` WebSocket frame (`{ chat_id, previous, current }`) so every connected UI re-syncs its permission switcher without a round-trip GET. Caveat: switching OUT of `bypassPermissions` mid-turn only affects the next turn — the SDK-level permission mode is captured at `provider.chat` call time and `canUseTool` isn't wired in bypass mode. The common restrictive→permissive case always works because `canUseTool` is already live.

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
  },
  "attachment_ids": [12, 13]
}
```

Both `POST /chats/:id/messages` and `POST /chats/:id/messages/stream` accept the optional `attachment_ids` array. Every id must already exist on this chat (uploaded via `POST /chats/:id/attachments`) and must still be unlinked (`message_id IS NULL`); otherwise the request is rejected with `422`. Further caps: at most 10 ids per message, and the sum of `size_bytes` across the batch must not exceed 30 MB. On success, the affected `chat_attachments` rows are UPDATEd to point at the newly inserted `chat_messages.id` atomically.

Both message endpoints also read `model` and `keyId` from the chat row when the request body omits them, and write any body-provided override back to the chat — so switching model / key on one turn is remembered for the next. Resolution order: explicit body → chat row → (stream handler only) project config → rc default. `ON DELETE SET NULL` on `chats.ai_provider_key_id` means deleting a key leaves chats intact; the next turn falls back to the default.

**Workspace-aware system prompt.** Both `POST /chats/:id/messages` and `POST /chats/:id/messages/stream` resolve the system prompt through the same pipeline: explicit `body.system` → entity-aware prompt (when the chat row carries `entity_type` + `entity_id` and a `project_id`, or `entity_context` is provided in the body) → workspace-aware prompt (when the chat is tied to a workspace, listing every project in that workspace with its name, path, and description) → default base. Workspace chats and workspace-linked-project chats additionally thread a `workspaceContext` payload into the `AgentSession`, which injects a `<workspace_projects>` block with scoping rules ("operate inside a listed project path, do not grep the workspace root") into the system prompt. This keeps task sessions (which don't use `systemPromptOverride`) and explicit-`body.system` chats from losing the project list.

- Non-stream response: `userMessage.attachments` echoes the linked rows.
- Stream response: the first SSE frame is `data: { "user_message": { ..., "attachments": [...] } }`, followed by the usual `content` / `done` frames.

Linked attachments are forwarded to the model as Anthropic content blocks (one per attachment, appended after the user's text block). Each attachment is encoded according to its sniffed content type:

- **Images** (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) → `{type:"image", source:{type:"base64", media_type:<mime>, data:<b64>}}`. GIFs are sent whole; Anthropic decodes them server-side.
- **PDFs** (`application/pdf`) → `{type:"document", source:{type:"base64", media_type:"application/pdf", data:<b64>}}`.
- **Text-like files** (`text/*`, `application/xml`, `application/json`, `application/sql` — includes `.txt`, `.md`, `.csv`, `.xml`, `.json`, `.yaml`, `.html`, source-code extensions, `.diff`, `.patch`, `.log`, …) → `{type:"document", source:{type:"text", media_type:"text/plain", data:<utf8>}}`. Text payloads are truncated at 1 MB (~250k tokens); when truncated, a `[truncated <N> bytes]` marker is appended so the model knows the file was cut.

So the user turn reaches the SDK as `[{type:"text", text:<body>}, <image|document block>, <image|document block>, …]`. Prior user messages with attachments are re-hydrated the same way when history is replayed on a resumed session.

SSE response frames (one JSON object per `data:` line, emitted in the exact order the agent produced them):

- `{ "content": "..." }` — assistant text delta.
- `{ "thinking": "..." }` — extended-thinking delta (collapsed into a "Thought for …" block in the UI).
- `{ "tool_call": { "name": "Grep", "input": { ... }, "summary": "pattern=foo" } }` — emitted when the agent invokes a tool. `input` is the full tool args; `summary` is a short one-liner for inline display.
- `{ "tool_result": { "name": "Grep", "output": "...", "summary": "3 matches" } }` — emitted when the tool returns.
- `{ "done": true, "usage": { ... } }` — final frame. `usage` is the aggregated token / cost accounting for the turn.

Both Claude Code CLI and GitHub Copilot providers emit the same tool events, so clients render both provider families identically.

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
| GET | `/projects/:pid/milestones/:slug/readme` | Get milestone README.md content (`{ content, path }`), 404 if absent |

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
| POST | `/projects/:pid/generate-plan` | Generate plan via AI (`{ prompt, mode, aiProviderKeyId?, model? }`, mode: "quick" or "deep"). `aiProviderKeyId` must be in the project's allow-list when one is set. |
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

Templates are stored as JSON files on disk (not in the database), organised into three
scope directories:

- `~/flockctl/templates/<name>.json` — `scope: "global"`
- `<workspace>/.flockctl/templates/<name>.json` — `scope: "workspace"`
- `<project>/.flockctl/templates/<name>.json` — `scope: "project"`

A template is identified by `(scope, name)` plus the owning `workspaceId` or
`projectId` when the scope is not global. There is no numeric template id.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/templates` | List templates (filters: `scope`, `workspace_id`, `project_id`; pagination supported) |
| GET | `/templates/:scope/:name` | Get template (query: `workspace_id`, `project_id`) |
| POST | `/templates` | Create template |
| PATCH | `/templates/:scope/:name` | Update template (query: `workspace_id`, `project_id`) |
| DELETE | `/templates/:scope/:name` | Delete template (query: `workspace_id`, `project_id`) |

### Create template — `POST /templates`

```json
{
  "name": "nightly-build",
  "scope": "global",
  "workspaceId": null,
  "projectId": null,
  "description": "Run nightly build",
  "prompt": "...",
  "agent": "claude-code",
  "model": "claude-sonnet-4",
  "image": null,
  "workingDir": "/tmp/build",
  "envVars": { "FOO": "bar" },
  "timeoutSeconds": 3600,
  "labelSelector": null
}
```

`workspaceId` is required when `scope = "workspace"`, `projectId` is required when
`scope = "project"`.

---

## Schedules

Schedules reference a template by `(templateScope, templateName, templateWorkspaceId?,
templateProjectId?)` rather than a numeric template id. The AI key to use is
recorded per-schedule via `assignedKeyId`, so the same template can be reused with
different keys across schedules.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/schedules` | List schedules (filters: `status`, `schedule_type`) |
| GET | `/schedules/:id` | Get schedule with embedded `template` object resolved from disk (may be `null` if file was deleted) |
| GET | `/schedules/:id/tasks` | List tasks spawned by this schedule (label-prefix match on `templateName`) |
| POST | `/schedules` | Create schedule (`scheduleType`: "cron" or "once"); 422 if the referenced template file does not exist |
| PATCH | `/schedules/:id` | Update schedule (any subset of schedule fields, `assignedKeyId`, or the four template-reference columns) |
| DELETE | `/schedules/:id` | Delete schedule |
| POST | `/schedules/:id/pause` | Pause schedule |
| POST | `/schedules/:id/resume` | Resume schedule |

### Create schedule — `POST /schedules`

```json
{
  "templateScope": "global",
  "templateName": "nightly-build",
  "templateWorkspaceId": null,
  "templateProjectId": null,
  "assignedKeyId": 12,
  "scheduleType": "cron",
  "cronExpression": "0 */6 * * *",
  "runAt": null,
  "timezone": "UTC",
  "misfireGraceSeconds": 300
}
```

---

## AI Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/keys` | List keys (values redacted) |
| GET | `/keys/providers` | List available providers |
| GET | `/keys/claude-cli/status` | Claude CLI readiness (installed, authenticated, models) |
| GET | `/keys/copilot/status` | GitHub Copilot SDK readiness (installed, authenticated, models) |
| GET | `/keys/:id` | Get single key (redacted) |
| POST | `/keys` | Create key (body must include `provider` and `providerType`; `provider: "github_copilot"` additionally requires `keyValue`) |
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
    "effectiveSuccessRate": null,
    "buildAfterRerun": 0,
    "supersededFailures": 0,
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

## Incidents

Lightweight post-mortem / knowledge-base entries. `symptom`, `root_cause`, and `resolution` are mirrored into the FTS5 virtual table `incidents_fts` (unicode61 tokenizer) by raw-SQL triggers, so `/incidents/search` can rank by BM25. `tags` is a `string[]` stored as JSON.

### CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/incidents` | Paginated list, newest first (`page`, `per_page` or `offset`, `limit`) |
| GET | `/incidents/:id` | Fetch a single incident |
| POST | `/incidents` | Create. Body: `{ title, symptom?, rootCause?, resolution?, tags?: string[], projectId?, createdByChatId? }`. `title` required. |
| PUT | `/incidents/:id` | Update any subset of fields. Pass `tags: []` to clear tags. |
| DELETE | `/incidents/:id` | Delete |

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/incidents/search?q=&tags=&projectId=&limit=` | Full-text + tag + project search. `q` runs against symptom/root_cause/resolution via FTS5 MATCH (empty `q` falls back to recency). `tags` is a comma-separated list — rows must share at least one; the size of the tag intersection boosts the score. `projectId` restricts results to one project. `limit` defaults to 10, clamped to `[1, 100]`. Returns `{ items, total }` where each item carries the full incident record plus a `score` field (higher = more relevant). |
| GET | `/incidents/tags?projectId=` | Distinct list of tag strings used across incidents. Optional `projectId` restricts the aggregate to one project. Returns `{ tags: string[] }` (sorted). Used by the "Save as incident" dialog as its typeahead source. |

The service (`src/services/incidents/service.ts#searchIncidents`) is also invoked directly by the auto-retrieval flow that injects relevant past incidents into a chat/task prompt, so the route is intentionally a thin adapter.

---

## Attention

Aggregated list of blockers currently awaiting user action: tasks halted in `pending_approval`, chats halted in `approval_status='pending'` (opt-in via `chats.requiresApproval`), plus per-tool permission prompts on every active task and chat `AgentSession`. Read-only — there is no filter, no pagination, and no write counterpart; the UI filters client-side and refetches whenever the `attention_changed` WS event fires. Tool-call arguments are deliberately stripped (they can contain secrets) — only the tool name is surfaced.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/attention` | Flat, recency-sorted (`since` descending) list of every blocker. In remote mode, non-local callers must send `Authorization: Bearer <token>`; localhost is always allowed. |

Response (`200 OK`):

```json
{
  "items": [
    {
      "kind": "task_approval",
      "taskId": 42,
      "projectId": 7,
      "title": "Implement feature X",
      "since": "2026-04-20T12:34:56.000Z"
    },
    {
      "kind": "task_permission",
      "taskId": 43,
      "projectId": 7,
      "requestId": "perm_01HXYZABC",
      "tool": "Bash",
      "since": "2026-04-20T12:33:10.000Z"
    }
  ],
  "total": 2
}
```

Item shape varies by `kind`:

- `task_approval` — `{ kind, taskId, projectId, title, since }` (`title` falls back to the first line of the prompt if the task has no `label`).
- `chat_approval` — `{ kind, chatId, projectId, title, since }` (`projectId` is `null` for chats not attached to a project; `title` is the chat's `title` column or `""` when unset). Clear via `POST /chats/:id/{approve,reject}`.
- `task_permission` — `{ kind, taskId, projectId, requestId, tool, since }`.
- `chat_permission` — `{ kind, chatId, projectId, requestId, tool, since }` (`projectId` is `null` for chats not attached to a project).

Errors:
- `401` — in remote mode, missing / invalid bearer token for a non-local request.
- `500` — unexpected error aggregating the list. Individual session failures (e.g. a session whose permission queue throws) are logged and skipped rather than failing the whole response.

---

## Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/meta` | Available agents, models, API keys, and defaults (`defaults` includes `model`, `planningModel`, `agent`, `keyId`) |
| PATCH | `/meta/defaults` | Update global defaults persisted to `~/.flockctlrc`. Body: `{ defaultModel?: string \| null, defaultKeyId?: number \| null }` — pass `null` to clear. Returns the resolved `{ model, planningModel, agent, keyId }`. Returns `404` if `defaultKeyId` does not match an existing AI Provider Key. |
| GET | `/meta/version` | Current daemon version + latest published version on npm. Returns `{ current, latest, updateAvailable, error, installMode }`. `installMode` is `"global"`, `"local"`, or `"unknown"` and reflects whether the running daemon was installed globally, as a dep of some project, or from source / npx cache. Picks the `next` dist-tag when the current version is a prerelease, otherwise `latest`. |
| POST | `/meta/update` | Fire-and-forget: kicks off `npm install -g flockctl@<tag>` for `"global"` or `npm install flockctl@<tag>` (with `cwd` = the project root) for `"local"`, then returns `202 { triggered, targetVersion, installMode }` immediately. Refuses with `400` when `installMode` is `"unknown"`. Returns `409 { error, status: "running" }` if another install is already in flight (prevents double-clicks from queueing duplicates). Poll `GET /meta/update` for completion. The user must restart the daemon to pick up the new binary. |
| GET | `/meta/update` | Current state of the async update worker. Returns `{ status, error?, targetVersion?, exitCode?, stdout?, stderr? }` where `status` is `"idle"` \| `"running"` \| `"success"` \| `"error"`. Never blocks. |
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

### Events

Frames are JSON objects `{ type, payload }` broadcast to all connected clients. The UI reacts to the event, not to the payload.

- `attention_changed` — payload `{ type: 'attention_changed' }`. Fired whenever the set of blockers returned by `GET /attention` changes (a task enters `pending_approval`, is approved/rejected, or a task/chat session raises/resolves a tool-permission request). Clients should refetch `GET /attention` on receipt.
- `chat_diff_updated` — payload `{ chat_id, summary, total_entries }`. Broadcast on the per-chat channel (`/ws/ui/chats/:chatId/events`) whenever an `Edit` / `Write` / `MultiEdit` tool call appends new entries to the chat's file-edit journal. Clients invalidate `GET /chats/:id/diff` on receipt so the "Changes" card at the bottom of the chat stays live.
- `chat_permission_mode_changed` — payload `{ chat_id, previous, current }`. Broadcast on the per-chat channel whenever `PATCH /chats/:id` changes `permission_mode` while a chat session is in flight. Clients sync the permission-mode selector and clear any pending-permission card that the new mode has auto-resolved. Not fired when the effective mode is unchanged (no-op transition).

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
