---
name: bugfix
description: Structured bugfix workflow — reproduce the bug with a test first, confirm it fails, fix the code, then verify the fix passes. Use this skill whenever the user reports a bug, asks to fix a broken feature, debug an issue, investigate why something doesn't work, or mentions an error/regression. Also use when the user says "почини", "пофикси", "баг", "сломалось", "не работает", "ошибка", "fix bug", "broken", "regression", "debug this", "investigate issue", "doesn't work", "something broke". NOT for new feature development, refactoring, performance optimization, or code review. Keywords: bug, баг, fix, фикс, починить, почини, пофикси, сломалось, не работает, ошибка, regression, регрессия, broken, debug, issue, investigate, doesn't work, error, fails, failing, crash, wrong behavior, incorrect, unexpected.
---

# Bugfix Workflow

A structured, test-driven approach to fixing bugs. Core principle: **prove the bug exists with a failing test, then prove the fix works by making that test pass.**

## Workflow Overview

```
Phase 1: Understand   → Gather context, identify the broken behavior
Phase 2: Reproduce    → Write a failing test that captures the bug
Phase 3: Confirm      → Run the test, verify it fails for the right reason
Phase 4: Fix          → Fix the code (follow project conventions — see `api-design`, `database`, `security` skills)
Phase 5: Verify       → Re-run the test, confirm it passes
Phase 6: Full suite   → Run the testing skill's tier ladder (vitest → smoke → e2e)
```

## Phase 1: Understand the Bug

Before writing any code, build a clear mental model of what's broken.

### Gather context

1. **Read the bug report** — user description, error message, logs
2. **Identify the affected area** — which route, service, or UI page
3. **Find the relevant code** — grep the codebase; use the `Explore` agent for broad questions
4. **Check recent changes** — `git log --oneline -20 -- <path>` to see if something was recently touched

### Classify the bug

| Bug type | Test tier | Primary fix location |
|---|---|---|
| **API returns wrong data / status** | Vitest integration | [src/routes/](src/routes/) |
| **Service logic wrong** (task executor, scheduler, budget, key selection) | Vitest integration | [src/services/](src/services/) |
| **DB migration / schema mismatch** | Smoke (fresh DB) | [migrations/](migrations/) + [src/db/schema.ts](src/db/schema.ts) + [src/__tests__/helpers.ts](src/__tests__/helpers.ts) |
| **WebSocket message wrong** | Vitest integration | [src/services/ws-manager.ts](src/services/ws-manager.ts) or the emitting service |
| **Chat SSE dropping messages** | Vitest unit (chat-executor) + manual | [src/services/chat-executor.ts](src/services/chat-executor.ts) |
| **AI provider call shape** | Vitest unit + Tier 5 live | [src/services/ai-client.ts](src/services/ai-client.ts), `src/services/agents/` |
| **Remote auth / token validation** | Vitest integration | [src/middleware/remote-auth.ts](src/middleware/remote-auth.ts) |
| **UI renders incorrectly** | Playwright E2E | [ui/src/](ui/src/) |
| **CLI command broken** | Vitest unit | [src/cli.ts](src/cli.ts) |
| **Planning FS layout wrong** | Vitest unit | [src/services/plan-store.ts](src/services/plan-store.ts) |

## Phase 2: Write a Failing Test

Capture the broken behavior in an automated test **before** fixing anything.

### Backend (most common)

Use the existing `createTestDb()` harness and route-level `app.request()`. Follow the style already in [src/__tests__/routes/](src/__tests__/routes/):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers";
import { setDb } from "../../db/index";

describe("GET /tasks/:id", () => {
  let db, sqlite;
  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    setDb(db, sqlite);
  });

  it("returns 404 for deleted project's tasks", async () => {
    // regression: <describe what was broken>
    // arrange: create task, then cascade-delete project
    // act: GET /tasks/:id
    // assert: 404 — not stale data
  });
});
```

### UI regression

Add a Playwright spec in [ui/e2e/](ui/e2e/). Seed state via the `request` fixture, then drive the page and assert the corrected behavior.

### Smoke regression

If the bug is boot-time (migrations, seeding, config), add or extend a file in [tests/smoke/](tests/smoke/) — the harness spawns a fresh `server-entry.ts` against a clean `FLOCKCTL_HOME`.

### Test naming

- Add to an existing test file if one covers the affected area
- Create a new `*.test.ts` only when needed
- Name the test for the behavior, not the bug ID — "returns 404 for X" beats "fix issue 123"
- Add a short comment: `// regression: <what was broken>`

### Skip the test when

- The bug is in infra/config that can't be tested (system paths, machine-specific permissions)
- The fix is a one-character typo in a literal string
- When skipping, document why in a commit/PR message and proceed to Phase 4

## Phase 3: Confirm the Bug

Run only the new test:

```bash
npx vitest run src/__tests__/<path>/<file>.test.ts -t "<test name>"
```

Or for Playwright:

```bash
cd ui && npx playwright test e2e/<file>.spec.ts
```

What to check:
- **Test fails** → good, bug confirmed
- **Test fails for the right reason** — the business assertion is failing, not the setup
- **Test passes unexpectedly** — the bug isn't what you thought, or the test doesn't actually exercise it

## Phase 4: Fix the Code

Fix the minimum amount needed. Follow conventions from related skills:
- Routes / endpoints → `api-design`
- DB / schema / migrations → `database`
- Auth / tokens / keys → `security`
- Performance → `performance`

### Migration-specific note

If the fix involves a new `.sql` migration, remember the invariants from memory:
- Add the entry to [migrations/meta/_journal.json](migrations/meta/_journal.json)
- Mirror the schema change into [src/__tests__/helpers.ts](src/__tests__/helpers.ts) (`createTestDb()` DDL)
- Each SQL statement in the migration file must be separated by `--> statement-breakpoint` — the drizzle / better-sqlite3 migrator prepares each segment as a single statement

## Phase 5: Verify the Fix

Re-run the same test. It must pass. If it doesn't, the fix is incomplete — iterate.

## Phase 6: Full Suite

Use the `testing` skill's tier ladder:

```bash
npm run test:coverage      # Tier 1–2: vitest + coverage thresholds
npm run test:smoke         # Tier 3: real server boot
npm run test:e2e           # Tier 4: Playwright (only if UI touched)
# Tier 5 live — only if AI integration changed
```

Don't claim "fixed" until the tier appropriate to the change is green.
