# Flockctl — Architecture

## Overview

Flockctl is a CLI daemon for dispatching AI coding agent tasks. TypeScript backend (Hono + SQLite) with a React web UI — runs as a single `npm install`, no containers, no external databases.

Operating modes:

- **Local mode (default)** — binds to `localhost:52077`, CORS is wildcard, no authentication. The right model when the daemon is only reached over loopback.
- **Remote mode (opt-in)** — a Bearer token in `~/.flockctlrc` enables authentication for non-localhost callers, narrows CORS to a whitelist, and requires WebSocket clients to carry the token as a query string.

Both modes share the same server binary; the switch is purely configuration.

## System Architecture

```
┌─────────────────────────────────────────┐
│         Web UI (React + Vite)           │
│     localhost:52077  /  remote host     │
└─────────────────┬───────────────────────┘
                  │ REST + SSE + WebSocket
┌─────────────────▼───────────────────────┐
│         Hono HTTP Server (TS)           │
│                                         │
│  CORS (dynamic)                         │
│  remoteAuth middleware                  │
│  ├── localhost bypass                   │
│  ├── Bearer token verify (timingSafe)   │
│  └── 5-fail-per-60s rate limit          │
│                                         │
│  Routes ─ Scheduler ─ Auto-Executor     │
│  AI Client ─ Cost ─ Permission Resolver │
│  Agent Session ─ Skills ─ Planner       │
│                                         │
│  SQLite (WAL mode via better-sqlite3)   │
│  ~/flockctl/flockctl.db                 │
└─────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend Framework** | Hono (TypeScript, Node.js ESM) |
| **Database** | SQLite (WAL mode via better-sqlite3) |
| **ORM** | Drizzle ORM + drizzle-kit migrations |
| **Frontend** | React 18 + Vite + shadcn/ui + TanStack React Query |
| **CLI** | Commander.js (`flockctl start\|stop\|status\|token`) |
| **Task Execution** | Claude Code SDK + direct API calls (Anthropic, OpenAI, Google) |
| **Scheduling** | node-cron |
| **Auth** | Optional Bearer token + timing-safe compare + per-IP rate limiter |
| **Port** | 52077 (configurable) |

## Project Structure

```
Flockctl/
├── src/
│   ├── cli.ts              # Commander CLI: start/stop/status/token
│   ├── daemon.ts           # PID file management, fork-based background process
│   ├── server.ts           # Hono app, dynamic CORS, routes, WS auth
│   ├── server-entry.ts     # Process entry: migrations → seed → services → server
│   ├── config.ts           # FLOCKCTL_HOME, ~/.flockctlrc, remote server list
│   ├── middleware/
│   │   └── remote-auth.ts  # Bearer-token guard + rate limiter + WS verify
│   ├── db/
│   │   ├── schema.ts       # 11 Drizzle ORM tables
│   │   ├── index.ts        # DB connection (SQLite + WAL)
│   │   └── migrate.ts      # Migration runner
│   ├── routes/             # 14 Hono route files
│   ├── services/           # 20 business logic modules
│   ├── lib/                # Shared types, errors, pagination, slugify
│   └── __tests__/          # Vitest test files
├── ui/                     # React + Vite + shadcn/ui (multi-server aware)
├── migrations/             # Drizzle SQL migrations
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Startup Sequence

Defined in `src/server-entry.ts`:

1. Run Drizzle migrations
2. Seed default AI key (if none exist)
3. Re-queue stale tasks left by previous daemon instance
4. Start scheduler service (load cron jobs from DB)
5. Start HTTP server on port 52077
6. Re-execute interrupted tasks
7. On boot, if `remoteAccessToken` is set, warn if `~/.flockctlrc` permissions are looser than `600`
8. Signal parent process (for daemon mode)

## Middleware Chain

Registered in `src/server.ts` in this order:

1. **Dynamic CORS** — wildcard when no token is set; otherwise an explicit whitelist from `corsOrigins` (falls back to wildcard if the list is empty/absent).
2. **UTF-8 charset normalizer** — ensures JSON responses declare `charset=UTF-8`.
3. **`remoteAuth`** — no-op when no token is set. When set:
   - Localhost socket (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`) → pass.
   - `GET /health` and `OPTIONS` preflight → pass.
   - Rate-limited IPs → `429`.
   - `Authorization: Bearer <token>` compared with `timingSafeEqual` → pass/fail.
4. **Route handlers**.
5. **WebSocket upgrades** call `verifyWsToken(c)` before `ws-manager` registration, rejecting with close code `1008` and the reason if the `?token=` query param is missing or wrong.

## Component Responsibilities

### Route Handlers (14 files)

| File | Prefix | Description |
|------|--------|-------------|
| `tasks.ts` | `/tasks` | Task CRUD, cancel, rerun, stats, logs, approval |
| `projects.ts` | `/projects` | Project CRUD, tree, stats, `.flockctl/config.json` I/O |
| `workspaces.ts` | `/workspaces` | Workspace CRUD, dashboard, project linking |
| `chats.ts` | `/chats` | AI chat sessions, message streaming (SSE) |
| `planning.ts` | `/projects/:pid/milestones` | Milestones → slices → plan tasks, auto-execute, plan generation |
| `templates.ts` | `/templates` | Task template CRUD |
| `schedules.ts` | `/schedules` | Cron/one-shot schedule CRUD, pause/resume |
| `ai-keys.ts` | `/keys` | AI provider key CRUD, test, Claude CLI status |
| `usage.ts` | `/usage` | Token/cost summary, breakdown, budget limits |
| `skills.ts` | `/skills` | Multi-level skill files (global/workspace/project), disable/enable |
| `mcp.ts` | `/mcp` | MCP server config (global/workspace/project), disable/enable |
| `meta.ts` | `/meta` | Agents, models, keys, defaults, remote server list |
| `metrics.ts` | `/metrics` | Aggregated analytics (time, productivity, cost, chats, schedules) |
| `ws.ts` | `/ws` | WebSocket status, live task log streaming |

### Services (selected)

| Service | File | Description |
|---------|------|-------------|
| **TaskExecutor** | `task-executor.ts` | Orchestrates task execution: key selection → agent session → log streaming |
| **AgentSession** | `agent-session.ts` | Agent loop with tool calls, permission requests |
| **AIClient** | `ai-client.ts` | Multi-provider AI API client (Anthropic, OpenAI, Google) |
| **KeySelection** | `key-selection.ts` | Key priority, rotation, error backoff, project/workspace scoping |
| **Scheduler** | `scheduler.ts` | Cron schedule management via node-cron |
| **AutoExecutor** | `auto-executor.ts` | Dependency-aware slice execution within milestones |
| **DependencyGraph** | `dependency-graph.ts` | DAG engine, topological sort, cycle detection |
| **PlanStore** | `plan-store.ts` | Filesystem-based plan storage (milestones/slices/tasks as YAML) |
| **PlanPrompt** | `plan-prompt.ts` | AI plan generation prompt builder |
| **PromptResolver** | `prompt-resolver.ts` | Resolve task prompts from files and templates |
| **Skills** | `skills.ts` | Multi-level skill resolution; reconciler materializes the resolved set into `.claude/skills/` as symlinks |
| **MCP** | `mcp.ts` | MCP server config resolution; reconciler writes the resolved set into `.mcp.json` (read natively by Claude Code) |
| **PermissionResolver** | `permission-resolver.ts` | Resolves `permissionMode` (task → chat → project) |
| **ProjectConfig** | `project-config.ts` | Reads/writes `<project>/.flockctl/config.json` |
| **GitContext** | `git-context.ts` | Git history and diff extraction for agent context |
| **Cost** | `cost.ts` | Token usage cost calculation, per-provider pricing |
| **WSManager** | `ws-manager.ts` | WebSocket client management, broadcast |
| **MergeQueue** | `merge-queue.ts` | Serialized merge orchestration for auto-executor |

## Task Execution Flow

```
1. POST /tasks → create task (status: queued)
2. TaskExecutor.execute(taskId)
   ├── Select AI key (KeySelection)
   ├── Resolve permissionMode (PermissionResolver)
   ├── Build context (GitContext, Skills, MCP)
   ├── Create AgentSession
   │   ├── Send prompt to AI (AIClient or Claude Code SDK)
   │   ├── Receive tool calls
   │   ├── Execute tools (respecting permissionMode)
   │   ├── Return results to AI
   │   └── Loop until done
   ├── Stream logs to WebSocket clients (ws-manager)
   ├── Record usage (tokens, cost → usage_records.aiProviderKeyId)
   └── Update task status (done/failed/pending_approval)
```

## Key Design Decisions

- **Local-only by default, remote-capable by configuration** — no middle ground. The same binary serves both modes; remote mode is opt-in via `~/.flockctlrc`.
- **No Docker** — single `npm install`, runs as a local daemon.
- **No remote task workers** — tasks execute inside the daemon process via agent sessions; "remote" in Flockctl means "UI talking to a remote daemon", not distributed execution.
- **SQLite** — zero-config, WAL mode for concurrent reads.
- **File-based plans** — milestones/slices stored as YAML on disk for git-friendliness.
- **Portable project config** — model, baseBranch, testCommand, permissionMode live in `<project>/.flockctl/config.json` (git-tracked). DB keeps only machine-local state (identity, path, key scoping).
- **Multi-provider** — supports Anthropic API, OpenAI API, Google API, and Claude Code CLI / SDK.
- **Hierarchical config** — skills, MCP servers, key restrictions, and permissionMode cascade: global → workspace → project → task.
- **Timing-safe auth** — token comparison uses `crypto.timingSafeEqual`; IP source is the Node socket, not `X-Forwarded-For` (so header spoofing can't bypass localhost detection).
