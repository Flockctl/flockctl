---
name: test-design
description: Test case design strategy for Flockctl — corner cases, boundary values, negative testing, and test quality heuristics. Determines WHAT to test, not HOW to run tests (that's the testing skill). Use when writing new tests for a feature or bugfix, improving test quality, increasing coverage, finding untested paths, or adding edge cases. Keywords: напиши тесты, покрой кейсы, edge cases, corner cases, граничные значения, mutation testing, improve test quality, качество тестов, что ещё протестировать, какие кейсы, тест-дизайн, test design, boundary testing, negative testing, негативные тесты.
---

# Test Design — What to Test and Why

This skill drives test case generation strategy. It answers "what should I test?" — the `testing` skill answers "how do I write and run it?"

**Core principle: every test must catch a real bug.** If removing the assertion doesn't break the test — the test is worthless.

## Test Case Design Process

### Step 1: Identify the Unit Under Test

Before writing any test, answer:
- What function / route / service am I testing?
- What are its inputs? (Hono request params/body, DB state, WebSocket messages, SSE events, FS plan files)
- What are its outputs? (JSON response, DB mutations, `wsManager.broadcast*` calls, filesystem side effects under `.flockctl/plan/`)
- What invariants must hold? (no orphaned rows, no double-executed tasks, no AI-key leakage, task state machine stays consistent with [src/lib/types.ts](src/lib/types.ts) transitions)

### Step 2: Apply the Category Checklist

For every unit under test, walk through these categories.

#### A. Happy Path (baseline)
- Standard successful operation with valid inputs
- Verifies the core contract works

#### B. Boundary Values

| Input Type | Test Values |
|---|---|
| **Integer** | 0, 1, -1, MAX, just below/above limits |
| **String** | `""`, `" "`, 1 char, max length, Unicode, SQL special chars (`'`, `"`, `<script>`) |
| **Date/Time** | Epoch, far future, midnight boundaries, timezone edge cases |
| **Collection** | `[]` empty, 1 element, at limit, limit+1, duplicates |
| **Boolean** | `true`, `false`, absent (default behavior) |
| **Enum** | Each valid value, invalid value |
| **Timeout** | 0, 1, very large, negative |

#### C. Null / Missing / Absent
- Required field is `null` or absent from request body (Zod catches this — assert 422)
- Optional field absent vs. explicitly `null`
- Empty object `{}` as input
- FK reference to non-existent record (dangling ID)

#### D. Negative / Error Paths

| Category | Examples |
|---|---|
| **Validation rejection** | Missing `prompt` and `promptFile`, empty project `name`, invalid cron, negative `timeoutSeconds` |
| **Auth (remote mode)** | No token when `~/.flockctlrc` has tokens, wrong token, missing `?token=` on WS, rate-limited IP (5× 401 in 60 s → 429) |
| **Not found** | Non-existent task ID, deleted project, archived chat |
| **Conflict / duplicate** | Duplicate workspace name, re-queuing a running task |
| **State violations** | Cancel already-completed task, approve a non-pending task, run a schedule whose template was deleted |

#### E. State Transitions

For entities with a status lifecycle (Task, Milestone, Slice, PlanTask, Schedule):
- Every valid transition in `TASK_STATUS_TRANSITIONS` (see [src/lib/types.ts](src/lib/types.ts)): `queued → running → done` (and `→ failed`, `→ cancelled`, `→ timed_out`)
- Every invalid transition must be rejected: `done → running`
- Transition side effects: `wsManager.broadcastAll({ type: "task_status", ... })`? Log row inserted? `usage_records` written?

#### F. Concurrency / Race Conditions

- Two POST `/tasks/:id/cancel` in quick succession
- Task executor at `maxConcurrent` — next task must queue, not drop
- Scheduler fires while the template is being deleted
- Chat SSE connection closes mid-stream — assistant message still saved? (see `chatExecutor.waitForIdle`)

#### G. Cross-Entity Side Effects

- Delete a project → tasks, templates, schedules, chats, chat_messages: what cascades? (See `ON DELETE CASCADE` in [src/db/schema.ts](src/db/schema.ts).)
- Delete a workspace → projects go to `workspaceId = NULL` (SET NULL), not cascaded
- Delete an AI provider key → `tasks.assignedKeyId` goes NULL; `usage_records.ai_provider_key_id` goes NULL (migration 0021)
- Update a template → existing schedules still resolve correctly
- Delete a milestone directory on disk → auto-executor reconciliation on next boot

#### H. Idempotency
- Same POST twice → same result, no duplicate rows
- Schedule fires on boot when `last_fire_time` was missed — does it re-execute or skip based on `misfireGraceSeconds`?

#### I. Pagination / Filtering
- Empty result set
- Exactly 1 result
- Page boundary (exactly `perPage` items, clamped to 1..100 by [src/lib/pagination.ts](src/lib/pagination.ts))
- Combined filters (`status=running&project_id=1&created_after=...`)

### Step 3: Flockctl Domain Checklist

Corner cases specific to Flockctl's business domain:

#### Tasks
- [ ] Task with zero / negative / very large `timeoutSeconds`
- [ ] Task with very long prompt (10K chars) vs. `promptFile` pointing at a non-existent path
- [ ] Task where `workingDir` ≠ project path — executor should respect the task override
- [ ] Task with no `workingDir` AND no project path — executor falls back to `getFlockctlHome()`
- [ ] Task cancel mid-execution — SDK abort + status transition + WS broadcast
- [ ] Task rerun of a failed task — fresh row vs. updating the old one
- [ ] `requiresApproval=true` task — must not run before `/approve`
- [ ] Permission mode propagation: task → session → SDK option (see [src/services/permission-resolver.ts](src/services/permission-resolver.ts))

#### AI Provider Keys
- [ ] `key-selection.ts`: `allowedKeyIds` / `deniedKeyIds` at project and workspace level
- [ ] Expired OAuth token → provider-specific refresh path
- [ ] Key with `disabledUntil` in the future → skipped
- [ ] Priority ordering (higher priority first)
- [ ] All keys disabled → `NoKeyAvailableError`
- [ ] `consecutiveErrors` threshold → automatic disable
- [ ] Config-dir keys vs. DB-stored keys (`providerType = "cli"` vs. `"api"`)

#### Scheduling
- [ ] Cron expression with invalid syntax → 400 from POST `/schedules`
- [ ] One-time schedule with `runAt` in the past
- [ ] Schedule pause/resume cycle via PATCH
- [ ] DST-crossing schedule in a non-UTC timezone — `cron-parser` + `computeNextFireTime`
- [ ] Schedule whose template is deleted → scheduler logs and skips

#### Chats
- [ ] Chat with no messages — SSE still opens cleanly
- [ ] Chat `permissionMode=plan` — tools should be restricted
- [ ] Simultaneous UI clients subscribed to `/ws/chats/:chatId/events`
- [ ] Chat executor `waitForIdle` — shutdown blocks until in-flight saves complete
- [ ] Session resume via `claudeSessionId` → SDK reloads prior turns

#### Planning
- [ ] File-based `plan-store` write / read roundtrip
- [ ] Plan status reconcile on boot (`reconcilePlanStatuses`)
- [ ] Slice with missing `depends` reference
- [ ] Milestone resume — `resumeStaleMilestones` after a crash

#### Usage / Budget
- [ ] Cost calculation parity between live providers and [src/services/cost.ts](src/services/cost.ts) pricing table
- [ ] Budget limit with `action=pause` — new tasks blocked past the threshold
- [ ] Per-project vs. per-key scope

#### WebSocket
- [ ] Connect with invalid `verifyWsToken` → close 1008
- [ ] Rapid reconnect — no memory leak in `wsManager` client maps
- [ ] Global `/ws/chats/events` vs. per-chat subscription — correct routing

### Step 4: Prioritize

| Priority | Criteria | Action |
|---|---|---|
| **P0 — Must test** | AI-key leakage, task state corruption, cross-project data bleed, auth bypass in remote mode | Write test immediately |
| **P1 — Should test** | Wrong API response, missing WS broadcast, incorrect status transition | Write in the same PR |
| **P2 — Nice to have** | Cosmetic issues, rare edge cases | File a TODO or skip |

**P0 domains for Flockctl**: AI provider key handling and isolation, task state machine, workspace/project data isolation, remote auth token validation, migration safety.
