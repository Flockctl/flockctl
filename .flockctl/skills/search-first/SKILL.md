---
name: search-first
description: "Research-before-coding workflow — before writing new code, search the existing codebase for reusable utilities, patterns, and modules. Prevents reinventing the wheel and ensures DRY compliance. Use before implementing any new feature, utility function, helper, or abstraction. Keywords: search first, research, поищи, check existing, проверь существующее, reuse, переиспользуй, DRY, duplicate, дубликат, уже есть, already exists, existing utility, добавь функциональность, реализуй, implement, add feature, new helper."
---

# Search First — Research Before You Code

Before writing any new utility, service, Drizzle query, route, or React component — search the existing codebase. This prevents duplicate code, ensures consistency, and often saves significant time.

## When to Activate

Before writing ANY of these:
- A new utility function or helper in `src/lib/` or `ui/src/lib/`
- A new API endpoint that might overlap with an existing route
- A new Drizzle query pattern (joins, aggregates, pagination)
- A new Zod schema or type
- A new React component, hook, or dialog
- Installing a new npm package

## The Workflow

```
1. DEFINE NEED      → What functionality? Which layer?
2. SEARCH CODEBASE  → Grep + file glob (parallel)
3. EVALUATE MATCHES → Exact? Partial? Extendable?
4. DECIDE           → Reuse | Extend | Build
```

### Step 1: Define the Need

Be specific:
- **Function**: "Validate and compare a bearer token constant-time"
- **Pattern**: "Paginated list endpoint with a `label` filter"
- **Query**: "Join tasks with their assigned AI-key label"
- **Component**: "Drawer that streams task logs over WebSocket"

### Step 2: Search the Codebase

**Backend** ([src/](src/)):

```
# Function / class definitions
Grep: "^(export )?(async )?function <keyword>"   glob: src/**/*.ts
Grep: "^export class <Keyword>"                   glob: src/**/*.ts

# Existing routes — URL strings + router method calls
Grep: "\\.(get|post|patch|delete|put)\\("        glob: src/routes/**/*.ts
Grep: "<keyword>"                                  glob: src/routes/**/*.ts

# Schema / table definitions
Grep: "sqliteTable"                               path: src/db/schema.ts
Grep: "<keyword>"                                  path: src/db/schema.ts

# Services — business logic
Grep: "<keyword>"                                  glob: src/services/**/*.ts
```

**Shared helpers** (always check before writing a new utility):

```
src/lib/errors.ts         AppError, NotFoundError, ValidationError
src/lib/pagination.ts     paginationParams, PaginatedResponse
src/lib/types.ts          Task / Milestone / Slice status enums + validateTaskTransition
src/lib/slugify.ts        slugify()
src/lib/security-gate.ts  evaluateBindSecurity — startup bind rules
src/middleware/remote-auth.ts   remoteAuth, verifyWsToken, safeCompare, isLocalhost
```

**Frontend** ([ui/src/](ui/src/)):

```
Glob: ui/src/components/**/*.tsx    # Existing UI components
Glob: ui/src/pages/**/*.tsx         # Existing pages — route-level files
Glob: ui/src/lib/**/*.ts            # api.ts, hooks.ts, ws.ts, types.ts, utils.ts

Grep: "<keyword>"                    glob: ui/src/**/*.{ts,tsx}
```

**Tests** (to check conventions before writing yours):

```
Glob: src/__tests__/routes/*.test.ts
Glob: src/__tests__/services/*.test.ts
Glob: src/__tests__/lib/*.test.ts
Glob: tests/smoke/*.ts
Glob: ui/e2e/*.spec.ts
```

### Step 3: Evaluate Matches

| Signal | Action |
|---|---|
| **Exact match** — function/helper does exactly what's needed | **Reuse** — import directly |
| **Partial match** — covers 80% | **Extend** — add a parameter/overload in place |
| **Pattern match** — similar code exists for a neighbouring resource | **Follow pattern** — write new code in the same shape |
| **Nothing found** | **Build** — informed by existing conventions |

### Step 4: Decide and Document

**Reuse**: Import and go. No new file.

**Extend**: Add to the existing file. Follow the established patterns (naming, error style, test layout).

**Build new**: Before writing, verify:
1. Is there a naming convention in the target directory? → Follow it
2. Is there a test file pattern? → Mirror it under `src/__tests__/…` or `ui/e2e/…`
3. Is there an existing idiom (e.g. `getDb()`, `wsManager.broadcast*`, `paginationParams`)? → Use it

## Search Shortcuts by Domain

### Auth, tokens, remote access
- [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts) — `remoteAuth`, `verifyWsToken`, rate-limiter
- [src/config.ts](src/config.ts) — `hasRemoteAuth`, `findMatchingToken`, `checkRcPermissions`, CORS origins
- [src/lib/security-gate.ts](src/lib/security-gate.ts) — bind-host rules at startup

### API endpoints + response shapes
- [src/routes/](src/routes/) — all 15 routers
- [src/lib/errors.ts](src/lib/errors.ts) / [src/lib/pagination.ts](src/lib/pagination.ts) — uniform error + list shapes

### Database / Drizzle
- [src/db/schema.ts](src/db/schema.ts) — every table
- [src/db/index.ts](src/db/index.ts) — `getDb`, `getRawDb`, `setDb`
- [migrations/](migrations/) + [migrations/meta/_journal.json](migrations/meta/_journal.json)

### WebSocket + SSE
- [src/services/ws-manager.ts](src/services/ws-manager.ts) — fan-out
- [src/routes/chats.ts](src/routes/chats.ts) — SSE streaming pattern (`streamSSE`)
- [src/services/chat-executor.ts](src/services/chat-executor.ts) — graceful drain

### AI integration
- [src/services/ai-client.ts](src/services/ai-client.ts) — Claude chat / agent SDK wrapper
- [src/services/agents/](src/services/agents/) — Claude Code agent glue (`registry.ts`, `types.ts`)
- [src/services/key-selection.ts](src/services/key-selection.ts) — priority / denylist / `disabledUntil`
- [src/services/cost.ts](src/services/cost.ts) — pricing table, `calculateCost`
- [src/services/budget.ts](src/services/budget.ts) — `checkBudget`

### Task execution
- [src/services/task-executor.ts](src/services/task-executor.ts) — queue, concurrency, rerun
- [src/services/scheduler.ts](src/services/scheduler.ts) — cron / one-shot, DST-aware next-fire
- [src/services/auto-executor.ts](src/services/auto-executor.ts) — dependency-aware plan execution

### Planning
- [src/services/plan-store.ts](src/services/plan-store.ts) — FS CRUD
- [src/services/plan-prompt.ts](src/services/plan-prompt.ts) — prompt assembly
- [src/routes/planning.ts](src/routes/planning.ts) — REST + SSE for plan generation

### Frontend
- [ui/src/components/](ui/src/components/) — shared components (`confirm-dialog`, `status-badge`, `server-switcher`, …)
- [ui/src/pages/](ui/src/pages/) — route-level pages
- [ui/src/lib/api.ts](ui/src/lib/api.ts) — backend HTTP client
- [ui/src/lib/ws.ts](ui/src/lib/ws.ts) — single WebSocket consumer
- [ui/src/lib/hooks.ts](ui/src/lib/hooks.ts) — shared hooks

## Anti-Patterns

- **Jumping to code** without grepping existing routes / services / components
- **Installing a package** for functionality already in the codebase
- **Constructing `new Database()` / `drizzle()`** instead of `getDb()`
- **Hand-crafting `c.json({ error }, …)`** instead of throwing an error class
- **Writing a bespoke WebSocket fan-out** instead of `wsManager.broadcast*`
- **Re-parsing `page` / `per_page`** instead of `paginationParams(c)`
- **Duplicating status-transition logic** instead of `validateTaskTransition` + constants from `src/lib/types.ts`
