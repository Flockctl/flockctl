---
name: api-design
description: Flockctl API endpoint design and implementation — Hono routers, Zod validation, error response format, pagination, bearer-token auth, SSE, and WebSocket patterns. Use when adding a new API endpoint, designing URL structure, writing request schemas, implementing validation, defining error responses, or adding pagination. Keywords: api, endpoint, эндпоинт, url, route, роут, router, роутер, hono, zod, response format, error response, pagination, пагинация, request, response, status code, HTTP method, GET, POST, PUT, DELETE, PATCH, websocket, sse, stream.
---

# Flockctl API Design Conventions

## Architecture: Hono Routers

Flockctl uses **Hono** running on `@hono/node-server`. Each resource lives in its own `src/routes/*.ts` file and exports a named `Hono()` sub-app that `src/server.ts` mounts.

```ts
// src/routes/tasks.ts
import { Hono } from "hono";
import { getDb } from "../db/index";
import { tasks } from "../db/schema";
import { paginationParams } from "../lib/pagination";
import { NotFoundError, ValidationError } from "../lib/errors";

export const taskRoutes = new Hono();

taskRoutes.get("/:id", (c) => {
  const id = parseInt(c.req.param("id"));
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new NotFoundError("Task", id);
  return c.json(row);
});
```

Registered in [src/server.ts](src/server.ts):

```ts
app.route("/tasks", taskRoutes);
app.route("/projects", projectRoutes);
// ...
```

## URL Structure

**Pattern:** `/{resource}[/{id}][/{sub-resource}]`

| Pattern | Example | Use For |
|---|---|---|
| Collection | `GET /tasks` | List all |
| Create | `POST /tasks` | Create new |
| Detail | `GET /tasks/:id` | Read one |
| Update | `PATCH /tasks/:id` | Partial update |
| Delete | `DELETE /tasks/:id` | Remove |
| Sub-resource | `GET /projects/:pid/milestones` | Related data |
| Action | `POST /tasks/:id/cancel` | State transition |

**Naming rules:**
- Plural nouns: `/tasks`, `/projects`, `/workspaces`
- Kebab-case for multi-word: `/ai-keys`, `/remote-servers`
- Actions as verbs: `/cancel`, `/rerun`, `/approve`, `/pause`, `/resume`

## Existing Routers

Located in [src/routes/](src/routes/):

| File | Prefix | Purpose |
|---|---|---|
| `tasks.ts` | `/tasks` | Task CRUD, cancel, rerun, approve, logs |
| `projects.ts` | `/projects` | Project CRUD, per-project config |
| `workspaces.ts` | `/workspaces` | Workspace CRUD |
| `chats.ts` | `/chats` | Chat CRUD + SSE event stream |
| `planning.ts` | `/projects/:pid/…` | Milestones, slices, plan tasks |
| `templates.ts` | `/templates` | Task template CRUD |
| `schedules.ts` | `/schedules` | Cron / one-shot schedules |
| `ai-keys.ts` | `/ai-keys` | AI provider key management |
| `usage.ts` | `/usage` | Token / cost records |
| `metrics.ts` | `/metrics` | Aggregated metrics |
| `meta.ts` | `/meta` | Health, version, remote-server registry |
| `mcp.ts` | `/mcp` | MCP server config |
| `skills.ts` | `/skills` | Skill file registry |
| `ws.ts` | `/ws` | WebSocket upgrade + fallback status |

## Authentication

Auth is applied globally in [src/server.ts](src/server.ts) via the `remoteAuth` middleware from [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts). **Routes do not opt in individually.** Rules:

- If no token is configured (single-user / loopback) → every route is open.
- If a token is configured → every non-localhost request needs `Authorization: Bearer <token>`.
- `GET /health` and `OPTIONS` preflights are always public.
- WebSocket connections use `?token=<token>` query param (browsers can't set WS headers).

When adding a new route, you get auth for free. Do not re-check tokens in the handler.

## Request Validation

**Use Zod** (`zod` is the project's schema library). Validate inside the handler, not via a separate schema directory:

```ts
import { z } from "zod";

const CreateTaskBody = z.object({
  projectId: z.number().int().positive().optional(),
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
}).refine((b) => b.prompt || b.promptFile, {
  message: "Either prompt or promptFile is required",
});

taskRoutes.post("/", async (c) => {
  const raw = await c.req.json();
  const parsed = CreateTaskBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Invalid task body", parsed.error.flatten().fieldErrors);
  }
  // ...
});
```

For parameter parsing that is uniform across routes, use the shared helper:

- [src/lib/pagination.ts](src/lib/pagination.ts) — `paginationParams(c)` returns `{ page, perPage, offset }` clamped to `1..100`.

## Response Format

### Success

**Single object** — return the DB row directly (no wrapper):

```json
{ "id": 1, "status": "queued", "prompt": "...", "projectId": 3 }
```

**List with pagination** — match the shape produced by `paginationParams` + route handlers:

```json
{ "items": [...], "total": 42, "page": 1, "perPage": 20 }
```

**Create** → `201` + the created object (`return c.json(row, 201)`).
**Update** → `200` + the updated object.
**Delete** → `{ "ok": true }` or the deleted row, depending on the resource.

### Errors

Use the custom error classes in [src/lib/errors.ts](src/lib/errors.ts) — they carry a `statusCode` that the global error handler in `src/server.ts` maps to the response:

```ts
import { NotFoundError, ValidationError, AppError } from "../lib/errors";

throw new NotFoundError("Task", id);
throw new ValidationError("Cannot cancel completed task");
throw new AppError(409, "Workspace name already exists");
```

Status code conventions:

| Code | Use For |
|---|---|
| 400 | Bad input that isn't Zod-shaped (e.g. invalid state transition) |
| 401 | Missing / wrong bearer token (handled by middleware) |
| 404 | Resource not found (`NotFoundError`) |
| 409 | Conflict / duplicate (`AppError(409, …)`) |
| 422 | Validation error (`ValidationError`) |
| 429 | Rate-limited auth attempts (handled by middleware) |
| 500 | Unexpected server error (never thrown deliberately) |

Do not hand-craft `c.json({ error }, 422)` blocks — go through the error classes so the shape stays uniform.

## Task State Machine

Before transitioning a task status, use the guard in [src/lib/types.ts](src/lib/types.ts):

```ts
import { validateTaskTransition, TaskStatus } from "../lib/types";

if (!validateTaskTransition(task.status, TaskStatus.CANCELLED)) {
  throw new ValidationError(`Cannot cancel task in status ${task.status}`);
}
```

Transitions are enumerated in `TASK_STATUS_TRANSITIONS`. Add new transitions there, not inline in a handler.

## SSE — Chat Event Stream

Long-running chat turns stream over SSE using Hono's `streamSSE`:

```ts
import { streamSSE } from "hono/streaming";

chatRoutes.post("/:id/messages", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "start", data: JSON.stringify({}) });
    // feed chunks from chatExecutor…
    await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
  }),
);
```

See [src/routes/chats.ts](src/routes/chats.ts) and [src/services/chat-executor.ts](src/services/chat-executor.ts) for the full pattern, including graceful shutdown (`chatExecutor.waitForIdle`).

## WebSocket

WebSocket is exposed via `@hono/node-ws`. Wiring lives in [src/server.ts](src/server.ts) (`createNodeWebSocket`, `upgradeWebSocket`). Client fan-out is centralised in [src/services/ws-manager.ts](src/services/ws-manager.ts):

```ts
import { wsManager } from "../services/ws-manager";

// Per-task channel:
wsManager.broadcast(taskId, { type: "task_log", content });

// Per-chat channel (also reaches global subscribers):
wsManager.broadcastChat(chatId, { type: "message_saved", messageId });

// Global — every connected client:
wsManager.broadcastAll({ type: "task_status", taskId, status });
```

Emit routing rules:

- `GET /ws/tasks/:id` → subscribes to that task's log+status feed
- `GET /ws/chats/:id/events` → subscribes to that chat
- `GET /ws/chats/events` → subscribes to every chat (for dashboards)
- Use `verifyWsToken(c)` from [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts) before calling `upgradeWebSocket` when adding a new WS route; non-local unauthenticated connections must close with code `1008`.

When you emit a status change from a service, **always** call `wsManager.broadcast*` on the same code path that writes the DB update — UI consistency depends on it.
