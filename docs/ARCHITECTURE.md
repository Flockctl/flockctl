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
| **AgentSession** | `agent-session/session.ts` | Agent loop with tool calls, permission requests. On every session start, `buildSystemPrompt()` runs, then `injectAgentGuidance()` appends the merged three-layer AGENTS.md cascade (user → workspace-public → project-public) to the system prompt via the pure `loadAgentGuidance` loader. No reconciler writes to disk — the merge is in-memory per session. See [AGENTS-LAYERING.md](AGENTS-LAYERING.md) for the full layer contract, size caps, and banner format. |
| **AIClient** | `ai-client.ts` | Multi-provider AI API client (Anthropic, OpenAI, Google) |
| **KeySelection** | `key-selection.ts` | Key priority, rotation, error backoff, project/workspace scoping |
| **Scheduler** | `scheduler.ts` | Cron schedule management via node-cron |
| **AutoExecutor** | `auto-executor.ts` | Dependency-aware slice execution within milestones |
| **DependencyGraph** | `dependency-graph.ts` | DAG engine, topological sort, cycle detection |
| **PlanStore** | `plan-store.ts` | Filesystem-based plan storage (milestones/slices/tasks as YAML) |
| **PlanPrompt** | `plan-prompt.ts` | AI plan generation prompt builder |
| **PromptResolver** | `prompt-resolver.ts` | Resolve task prompts from files and templates |
| **Skills** | `skills.ts` | Multi-level skill resolution; reconciler materializes the resolved set into `.claude/skills/` as symlinks |
| **MCP** | `mcp.ts` | MCP server config resolution; reconciler writes `.mcp.json` (for the interactive `claude` CLI) AND `AgentSession` forwards the same resolved set to the Claude Agent SDK via `provider.chat({ mcpServers })` — the SDK does NOT auto-read `.mcp.json`, so explicit forwarding is required for agents to see `mcp__*` tools |
| **PermissionResolver** | `permission-resolver.ts` | Resolves `permissionMode` (task → chat → project) |
| **ProjectConfig** | `project-config.ts` | Reads/writes `<project>/.flockctl/config.json` |
| **GitContext** | `git-context.ts` | Git history and diff extraction for agent context |
| **Cost** | `cost.ts` | Token usage cost calculation, per-provider pricing |
| **WSManager** | `ws-manager.ts` | WebSocket client management, broadcast |
| **MergeQueue** | `merge-queue.ts` | Serialized merge orchestration for auto-executor |

### UI Components (milestone 09 — mission-control layout)

The project-detail and tasks surfaces were re-built around a URL-backed view-mode state machine (`ui/src/lib/use-view-mode.ts`, exposing `ViewMode = "board" | "tree" | "swimlane"`) together with sibling hooks `use-selection.ts`, `use-kpi-data.ts`, and `use-tasks-view-mode.ts`. The components below are the public surface of that layout — route files import them, e2e specs target them by test-id, and doc references go through this table:

| Component | File | Role |
|-----------|------|------|
| **ViewModeToggle** | `ui/src/pages/project-detail-components/ViewModeToggle.tsx` | Segmented Board / Tree / Swimlane toggle; reads & writes `?view=` via `useViewMode()`. |
| **ProjectDetailBoardView** | `ui/src/pages/project-detail-components/ProjectDetailBoardView.tsx` | Board-mode shell rendered when `?view=board`; hosts `SliceBoard` + detail panel. |
| **ProjectDetailTreeView** | `ui/src/pages/project-detail-components/ProjectDetailTreeView.tsx` | Tree-mode shell rendered when `?view=tree`; hosts `ProjectTreePanel` + detail panel. |
| **ProjectTreePanel** | `ui/src/pages/project-detail-components/ProjectTreePanel.tsx` | Left-rail milestone → slice tree with keyboard navigation and URL-synced selection. |
| **SliceBoard** | `ui/src/pages/project-detail-components/SliceBoard.tsx` | Kanban-style board grouping slices by status column. |
| **SliceCard** | `ui/src/pages/project-detail-components/SliceCard.tsx` | Draggable card rendered inside `SliceBoard`; shows priority, progress, and selection state. |
| **SliceDetailPanel** | `ui/src/pages/project-detail-components/SliceDetailPanel.tsx` | Right-rail detail panel shared by both view modes. |
| **SliceDetailTabs** | `ui/src/pages/project-detail-components/SliceDetailTabs.tsx` | Tabbed header inside `SliceDetailPanel` (overview / tasks / chat / plan file). |
| **MissionControlKpiBar** | `ui/src/pages/project-detail-components/MissionControlKpiBar.tsx` | Top-of-page KPI strip; consumes `use-kpi-data` and collapses responsively. |
| **TaskCard** | `ui/src/pages/tasks-components/TaskCard.tsx` | Card renderer used by `TasksGroupedView` when the tasks page is in card mode. |
| **TasksGroupedView** | `ui/src/pages/tasks-components/TasksGroupedView.tsx` | Grouped (by status / project / key) card layout for `/tasks`. |
| **LiveRunsRail** | `ui/src/pages/tasks-components/LiveRunsRail.tsx` | Sticky side-rail showing currently-running tasks on the tasks page. |

Shared types for the board layout live in `slice-board-types.ts`; see [CONCEPTS.md §View mode](CONCEPTS.md) for the user-facing model behind Board / Tree / Swimlane.

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

## AI / Agent Session

`AgentSession` (in `src/services/agent-session/`) is the in-process runner for every task and chat turn. Its life-cycle is:

1. `buildSystemPrompt()` composes the baseline prompt (agent identity, workspace project list when workspace-scoped, incidents, state machines, tool format hints).
2. `injectAgentGuidance()` appends the merged AGENTS.md cascade. The pure `loadAgentGuidance` loader reads up to three layers — `user` → `workspace-public` → `project-public` — and concatenates them with per-layer header banners. The call is fail-open: an I/O error logs and returns the unmodified prompt so a guidance read never blocks a chat.
3. The final prompt is handed to the provider (Claude Agent SDK for tasks/chats, direct API for a few specialised flows) alongside resolved MCP servers, tools, and permission settings.

Older versions of Flockctl materialised a reconciled `AGENTS.md` at the project root by gluing workspace + project content with `BEGIN/END` markers. That reconciler has been removed: nothing is written to disk, the merge is recomputed per session, and the Claude Agent SDK (which does not read project files on its own) now receives the same guidance as the interactive `claude` CLI. Per-layer size caps (256 KiB per layer, 1 MiB total merged) and the exact banner format used by the merged string are specified in [AGENTS-LAYERING.md](AGENTS-LAYERING.md).

## Mission Control

"Mission Control" is the project-detail surface introduced in milestone 09. It is the single page users land on when they click a project — planning tree, slice board, KPIs, detail panel, and the chat pane all render inside one shell. The shell is intentionally dumb: layout only, no data fetching. Every panel plugs into a fixed slot; swapping a panel does not require changes to the shell.

### 3-column layout

`ProjectDetailBoardView` (and the symmetric `ProjectDetailTreeView`) lay out a CSS grid with three named slots:

| Slot | Width | Content |
|------|-------|---------|
| **left** | 260px fixed | `ProjectTreePanel` — milestone → slice outline with keyboard nav and URL-synced selection. |
| **center** | fluid (`min-w-0`) | `SliceBoard` in board mode, milestone cards in tree mode, a "coming soon" stub in swimlane mode. |
| **right** | 360px fixed | `SliceDetailPanel` wrapped in `SliceDetailTabs` — the currently-selected slice, tabs for future surfaces. |

Height pins to the viewport minus the app bar via the `--appbar-h` custom property; if the property is missing the `calc(100vh - 0)` expression gracefully falls back to the full viewport. Every slot sets `min-w-0` so a long milestone title in the center cannot push the right pane off-screen, and every slot owns its own scroll container — the shell clips overflow but never scrolls itself.

Exact dimensions match `docs/prototypes/mission-control.html` so the visual regression snapshot taken from the prototype is reusable.

### View-mode state machine

The `useViewMode()` hook (`ui/src/lib/use-view-mode.ts`) is a URL-backed state machine with a strict allow-list:

```
ViewMode = "board" | "tree" | "swimlane"
```

Resolution precedence, cheapest source first:

1. `?view=` query param — validated against the allow-list.
2. `localStorage["flockctl.viewMode.<projectId>"]` — the last choice persisted per project.
3. Default `"tree"`.

Any value outside the allow-list (empty string, unicode, injection payload, stale bookmark from a retired mode) silently falls back to step 2 → step 3 instead of throwing. The corrupted URL path must never crash the page or leak into the DOM unescaped.

`setMode(next)` is referentially stable across renders (safe in effect dep arrays). It writes localStorage first, then pushes `?view=next` with `replace: true` so the state machine is a same-tick contract: a synchronous re-read of `useViewMode()` after `setMode()` sees the new value even if React batches the `setSearchParams` flush.

The tasks page has its own mode switch (`useTasksViewMode`, table vs. cross-project kanban) built on the same pattern — URL-backed, allow-listed, fallback default.

### Extension points

Three public hooks keep Mission Control open for extension without re-opening the shell:

- **`SliceBoard` `columns` prop.** `SliceBoard` groups slices by a caller-supplied `readonly ColumnDef[]`; it never assumes a specific column count. Swap `DEFAULT_SLICE_COLUMNS` for a 5-column layout and the board re-renders with 5 columns — no other changes required. Any slice whose status is not mentioned in any column's `matchStatuses` falls into an auto-rendered "Other" fallback column, which only appears when at least one such slice exists. Column definitions are purely structural — status → color mapping stays on `SliceCard` via the badge utility, so the board does not duplicate the palette.
- **`SliceDetailTabs` registry.** The right-pane tabbed surface reads a `tabs?: TabDef[]` prop that defaults to `DEFAULT_SLICE_TABS`. New tabs plug in via `tabs={[...DEFAULT_SLICE_TABS, myTab]}` — no edit to the component is required. Each `TabDef` carries its own `render(ctx)` and receives a minimal `{ sliceId }` context, so a future Supervisor log tab (milestone 10) can fetch its own data without the registry growing to expose the entire slice model. If the registry changes under an uncontrolled active tab and the previously-active id disappears, the component silently resets to `tabs[0]`.
- **`status-badge` `proposed` variant.** `statusBadge(status)` (`ui/src/components/status-badge.tsx`) is the central colour map; adding a new planning status means adding a `case` and nothing else. The current `proposed` variant renders a violet outline badge — it is the shape every new status should follow. Callers read the badge through this function; they must never hand-render `<Badge>` with a status string.

Shared types for the board layout live in `ui/src/pages/project-detail-components/slice-board-types.ts`. See [CONCEPTS.md §View mode](CONCEPTS.md) for the user-facing model behind Board / Tree / Swimlane.

## Missions subsystem

A **mission** is a long-running, supervised goal layered on top of the existing planning hierarchy. Where a slice or task captures "one PR's worth of work", a mission captures "the agent should keep watching this objective and propose the next move whenever something changes". Missions are introduced and specified in detail in [MISSIONS.md](MISSIONS.md); this section names the components so other architecture readers can locate them.

```
┌─ event-subscriber ──┐    ┌─ heartbeat ─────┐    ┌─ stalled-detector ─┐
│ task / chat events  │    │ periodic ticks  │    │ no-progress timer  │
└──────────┬──────────┘    └────────┬────────┘    └──────────┬─────────┘
           │                        │                        │
           └────────────────────────▼────────────────────────┘
                          guardedEvaluate
              BudgetEnforcer.check ─► MaxDepthGuard.check
                          │
                          ▼
                  SupervisorService.evaluate
            (read-only, prompt vX.Y.Z, JSON-only output)
                          │
                          ▼
              BudgetEnforcer.increment ─► INSERT mission_events
                          │
                          ▼
                /missions router  (approval queue, REST + SSE)
```

Components (all under `src/services/missions/` unless noted):

| Component | File | Role |
|-----------|------|------|
| **SupervisorService** | `supervisor.ts` | Read-only LLM proposer. Builds a trusted-context envelope, runs an agent session under the supervisor prompt (`supervisor-prompt.ts`), parses the reply against `proposal-schema.ts`, and returns `propose` / `no_action`. Imports nothing from `routes/planning.ts` or `plan-store/{milestones,slices,tasks}.ts` — enforced by a static-import test. |
| **guardedEvaluate** | `guarded-evaluate.ts` | The single entry point every supervisor invocation flows through. Sequences `BudgetEnforcer.check` → `MaxDepthGuard.check` → evaluator → `BudgetEnforcer.increment` → `INSERT mission_events`. Failures at any stage downgrade to a `no_action` event with the cause captured. |
| **BudgetEnforcer** | `budget-enforcer.ts` | Per-mission token + USD budget. Refuses evaluation once a cap is hit; increments on every successful round-trip. |
| **MaxDepthGuard** | `max-depth-guard.ts` | Caps recursion depth (supervisor proposing actions that re-trigger the supervisor). Refuses evaluation past the configured ceiling. |
| **proposal-schema** | `proposal-schema.ts` | Zod schema for the supervisor's JSON output. The `notDestructiveVerb` refinement on `candidate.action` rejects `delete` / `drop` / `remove` / `destroy` / `truncate` / `rm ` at parse time. |
| **event-subscriber** | `event-subscriber.ts` | Bridges task / chat terminal events into mission triggers (`trigger_kind: "task_observed"`). |
| **heartbeat** | `heartbeat.ts` | Periodic supervisor wake-up (`trigger_kind: "heartbeat"`) so a mission keeps progressing even when no other event fires. |
| **stalled-detector** | `stalled-detector.ts` | Marks missions as stalled when no new events arrive within a configured window; surfaces them in the approval queue. |
| **missions router** | `src/routes/missions.ts` | REST + SSE surface — list missions, fetch the event timeline, list pending proposals, approve / reject. |
| **mission events table** | `src/db/schema.ts` (migration `0043_add_missions.sql`) | Append-only audit log: every supervisor decision, every approval, every budget reject is one row. |

Autonomy is gated. Even when a supervisor proposes an action, nothing is applied until a human approves it from the approval queue. The `auto` autonomy level (apply-without-approval) is wired at the schema level but disabled in v1 — every proposal lands in the queue.

## Key Design Decisions

- **Local-only by default, remote-capable by configuration** — no middle ground. The same binary serves both modes; remote mode is opt-in via `~/.flockctlrc`.
- **No Docker** — single `npm install`, runs as a local daemon.
- **No remote task workers** — tasks execute inside the daemon process via agent sessions; "remote" in Flockctl means "UI talking to a remote daemon", not distributed execution.
- **SQLite** — zero-config, WAL mode for concurrent reads.
- **File-based plans** — milestones/slices stored as YAML on disk for git-friendliness.
- **Portable project config** — model, baseBranch, testCommand, permissionMode live in `<project>/.flockctl/config.json` (git-tracked). DB keeps only machine-local state (identity, path, key scoping).
- **Multi-provider** — supports Anthropic API, OpenAI API, Google API, and Claude Code CLI / SDK.
- **Hierarchical config** — skills, MCP servers, key restrictions, and permissionMode cascade: global → workspace → project → task.
- **AGENTS.md is read at session start, not reconciled to disk** — the three-layer cascade (user → workspace-public → project-public) is merged in memory by `loadAgentGuidance` and appended to the system prompt by `AgentSession.injectAgentGuidance()`. Each scope owns exactly one editable `AGENTS.md` file; nothing is written to the project root by Flockctl. See [AGENTS-LAYERING.md](AGENTS-LAYERING.md).
- **Timing-safe auth** — token comparison uses `crypto.timingSafeEqual`; IP source is the Node socket, not `X-Forwarded-For` (so header spoofing can't bypass localhost detection).
