---
name: code-audit
description: Post-implementation code audit — finding duplicate code, dead code, missed reuse opportunities, cross-module side effects, and pattern inconsistencies AFTER a change is implemented. Use when asked to audit code, check code quality, find duplicates, detect unused code, check for side effects, or validate pattern consistency. This is a READ-ONLY review skill. Keywords: audit, аудит, code review, code quality, проверь изменения, проверь код, дубли кода, duplicate code, dead code, мёртвый код, reuse, пересечения, overlap, побочные эффекты, side effect, consistency, консистентность, DRY, post-implementation.
---

# Flockctl Code Audit

Run this audit after completing any code change. The goal: catch duplications, missed reuse, dead code, cross-module side effects, and pattern violations.

## When to Trigger

After:
- Implementing a new feature or endpoint
- Refactoring existing code
- Adding new utility functions
- Modifying schema or business logic
- Any change touching 3+ files

## Audit Checklist

### 1. Duplicate Code Detection

**Backend — check against existing modules before writing anything new:**

| Module | Contains |
|---|---|
| [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts) | `remoteAuth`, `verifyWsToken`, `safeCompare`, `isLocalhost`, rate-limiter |
| [src/db/index.ts](src/db/index.ts) | `getDb()`, `getRawDb()`, `setDb()`, `closeDb()` — single shared handle |
| [src/db/schema.ts](src/db/schema.ts) | All Drizzle tables — don't create per-resource schema files |
| [src/lib/errors.ts](src/lib/errors.ts) | `AppError`, `NotFoundError`, `ValidationError` |
| [src/lib/pagination.ts](src/lib/pagination.ts) | `paginationParams(c)`, `PaginatedResponse<T>` |
| [src/lib/types.ts](src/lib/types.ts) | Status enums + `validateTaskTransition` (task state machine) |
| [src/lib/slugify.ts](src/lib/slugify.ts) | `slugify()` for plan / resource names |
| [src/lib/security-gate.ts](src/lib/security-gate.ts) | Startup bind-safety check |
| [src/services/key-selection.ts](src/services/key-selection.ts) | `selectKeyForTask`, `seedDefaultKey`, priority/denylist logic |
| [src/services/ai-client.ts](src/services/ai-client.ts) | Streaming chat calls, session label, cost math |
| [src/services/cost.ts](src/services/cost.ts) | Per-provider / per-model pricing tables + `calculateCost()` |
| [src/services/ws-manager.ts](src/services/ws-manager.ts) | `wsManager.broadcast*` — only place that fans out to clients |
| [src/services/agent-session.ts](src/services/agent-session.ts) | Agent SDK session wrapper (tools, permissions, usage) |
| [src/services/permission-resolver.ts](src/services/permission-resolver.ts) | `resolvePermissionMode`, `allowedRoots` |
| [src/services/plan-store.ts](src/services/plan-store.ts) | FS CRUD for milestones / slices / plan tasks |
| [src/services/budget.ts](src/services/budget.ts) | `checkBudget` — do not inline budget math |

**Common duplication patterns to flag:**
- Inline bearer-token compare instead of `remoteAuth` / `safeCompare`
- New `new Database(...)` / `drizzle(...)` call instead of `getDb()`
- Hand-crafted `c.json({ error }, 422)` instead of throwing `ValidationError`
- Ad-hoc `page`/`per_page` parsing instead of `paginationParams`
- Per-route WS emit loops instead of `wsManager.broadcast*`
- Redefining a task / milestone / slice / schedule status string instead of using the constants in `src/lib/types.ts`

### 2. Dead Code Detection

- Functions / classes defined but never imported
- Commented-out blocks (>3 lines)
- Unused imports
- TODO / FIXME referring to resolved issues
- Unreachable branches

### 3. Pattern Consistency

**TypeScript backend:**
- Routes live in `src/routes/<resource>.ts`, export a named `Hono()` sub-app
- Bodies validated with **Zod**, not hand-rolled type guards
- DB access via `getDb()` — never by constructing `Database` / `drizzle` directly
- Errors thrown as `NotFoundError` / `ValidationError` / `AppError`
- Task status transitions guarded by `validateTaskTransition`
- Services export plain functions / singletons — no DI framework
- File-system writes for plans go through [src/services/plan-store.ts](src/services/plan-store.ts), not ad-hoc `fs.writeFileSync`

**Tests:**
- Vitest `describe` / `it` / `expect`
- DB fixture via `createTestDb()` + `setDb()` — no direct `new Database`
- Route tests drive the router with Hono's `app.request()`
- Names describe behavior: `"should 404 when project is deleted"`

### 4. Cross-Module Side Effects

**Known coupling points:**
- `task-executor.ts` ↔ `ws-manager.ts` — task status changes must broadcast
- `auto-executor.ts` ↔ `dependency-graph.ts` — wave computation depends on slice `depends`
- `scheduler.ts` ↔ `task-executor.ts` — schedule fire creates a task
- `key-selection.ts` ↔ `ai-client.ts` ↔ `agent-session.ts` — selected key drives the SDK call
- `chat-executor.ts` ↔ `ws-manager.ts` ↔ SSE stream in [src/routes/chats.ts](src/routes/chats.ts) — assistant message must be saved before connection closes; `waitForIdle` on shutdown
- Drizzle schema cascade / set-null rules in [src/db/schema.ts](src/db/schema.ts) — deleting a project cascades to tasks / templates / chats, but workspace delete only nulls `projects.workspaceId`

**Questions to answer:**
1. Does this change alter data the UI watches over WebSocket? → Ensure a `wsManager.broadcast*` call.
2. Does this change touch the task state machine? → Update `TASK_STATUS_TRANSITIONS` and `auto-executor` + `scheduler`.
3. Does this change alter schema? → Drizzle migration + `_journal.json` entry + mirror into `createTestDb()` in [src/__tests__/helpers.ts](src/__tests__/helpers.ts).
4. Does this change alter key selection? → Check `allowedKeyIds` / `deniedKeyIds` and `disabledUntil` paths.

### 5. Improvement Opportunities

- Functions > 50 lines → split into smaller units
- Deeply-nested conditionals → early returns
- Repeated `db.select()` patterns that could be a helper
- Missing indexes on columns used in `where` / `orderBy` (see `index()` declarations in `schema.ts`)
- Magic numbers → named constants in `src/lib/` or module top
- `any` types — should be rare; if used, comment why

### 6. Test Coverage

- New public functions have tests in [src/__tests__/](src/__tests__/)
- Edge cases covered (empty strings, null FK, boundary values)
- Error paths tested
- Regressions: each bugfix has a matching test named for the behavior

## Output Format

```
## Audit Results

### Findings
1. **[DUPLICATE]** src/routes/new.ts:42 — inline bearer compare, use remoteAuth / safeCompare
2. **[DEAD_CODE]** src/services/foo.ts:150 — unused helper
3. **[PATTERN]** src/routes/tasks.ts:30 — status change without wsManager.broadcastAll
4. **[SIDE_EFFECT]** src/services/auto-executor.ts:88 — schedule change, scheduler.ts not updated

### Clean
- No duplicates detected
- All patterns consistent

### Action Items
- [ ] Fix finding #1
- [ ] Fix finding #3
```
