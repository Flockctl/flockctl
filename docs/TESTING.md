# Testing

Flockctl has seven test tiers, ordered by cost. Run the lower tiers first; climb only as far as the change warrants.

| Tier | Name | What it checks | Command | External deps |
|---|---|---|---|---|
| 0 | Sanity | `tsc --noEmit` + UI lint | `npm run typecheck && npm run typecheck:ui && npm run lint:ui` | none |
| 1–2 | Backend unit + integration | Routes, services, DB via in-memory SQLite (Vitest) | `npm run test` | none |
| 1–2* | + Coverage | Same + v8 thresholds (80% stmts / 82% lines / 68% branches / 76% funcs) | `npm run test:coverage` | none |
| 2 | UI unit + component | Vitest + jsdom + @testing-library/react (api, hooks, panels) | `cd ui && npm test` | none |
| 3 | Smoke | Real `server-entry.ts` boot on a free port with isolated `FLOCKCTL_HOME` | `npm run test:smoke` | none (migrations run, no AI calls) |
| 4 | UI E2E | Playwright against real backend + Vite dev server | `npm run test:e2e` | Chromium (auto-installed) |
| 5 | Live | Real Anthropic / OpenAI / Claude CLI roundtrips | `FLOCKCTL_LIVE_TESTS=1 npm run test:live` | API keys, `claude` CLI |
| 6 | CLI-Docker | Every `flockctl` subcommand against a real daemon inside a disposable container | `npm run test:cli-docker` | Docker daemon, ~2 GB disk |

Tiers 0–4 run in CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)). Tiers 5 and 6 are local-only.

## Tier 0: Sanity

```bash
npm run typecheck      # backend: tsc --noEmit
npm run typecheck:ui   # UI: cd ui && tsc -b --noEmit
npm run lint:ui        # UI: cd ui && npm run lint (ESLint)
```

`pretest` automatically runs `typecheck` before `npm run test` — type errors surface before a single Vitest case executes.

## Tier 1–2: Unit + Integration (Vitest)

```bash
npm run test            # all tests
npm run test:watch      # watch mode
npm run test:coverage   # with v8 coverage + thresholds enforced
```

### Layout

Tests live in [src/__tests__/](../src/__tests__/) and mirror the source tree:

- `src/__tests__/routes/*.test.ts` — Hono routes, invoked via `app.request()`
- `src/__tests__/services/*.test.ts` — service classes and pure functions
- `src/__tests__/lib/*.test.ts` — small pure helpers (errors, pagination, slugify…)
- `src/__tests__/db.test.ts`, `schema.test.ts` — DB contract tests

### Harness: `createTestDb()`

[src/__tests__/helpers.ts](../src/__tests__/helpers.ts) exports `createTestDb()` which returns a fresh in-memory SQLite + Drizzle instance. **Its DDL must mirror [src/db/schema.ts](../src/db/schema.ts) exactly.** When you change the schema or add a migration, update both:

1. The migration file in [migrations/](../migrations/) (with `--> statement-breakpoint` between statements)
2. The journal entry in [migrations/meta/_journal.json](../migrations/meta/_journal.json)
3. The DDL inside `createTestDb()` in [src/__tests__/helpers.ts](../src/__tests__/helpers.ts)

Forgetting step 3 produces `no such table` / `no such column` errors only in tests.

### Writing a route test

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers";
import { setDb } from "../../db/index";
import app from "../../server";  // or a specific route sub-app

let db, sqlite;
beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

it("POST /projects returns 201 and the created row", async () => {
  const res = await app.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", path: "/tmp/x" }),
  });
  expect(res.status).toBe(201);
});
```

### Writing a service test

Most service tests mock the SDK boundary (`AgentSession`, `ws-manager`, `fs`) and then drive the service directly. See [src/__tests__/services/task-executor.test.ts](../src/__tests__/services/task-executor.test.ts) for the canonical pattern.

### Middleware tests

The `remoteAuth` middleware is covered in [src/__tests__/middleware/remote-auth.test.ts](../src/__tests__/middleware/remote-auth.test.ts). Each test resets the failure map via the `_resetRateLimiter()` helper and controls the "client IP" by injecting a stub socket into `c.env.incoming`, so you don't need a real TCP server to test localhost bypass / Bearer token / rate-limit paths. Reuse that pattern when adding routes that should bypass or hook into auth.

### Style

- `describe` + `it` + `expect` — no classes
- Name by behavior: `"returns 404 for nonexistent project"`, not `"test 23"`
- One logical assertion per test; helpers for repeated setup

## Tier 2: UI unit + component (Vitest)

```bash
cd ui
npm test            # one-shot
npm run test:watch  # watch mode
```

Config: [ui/vitest.config.ts](../ui/vitest.config.ts) (jsdom environment, `@/` → `ui/src/` alias). Setup: [ui/src/__tests__/setup.ts](../ui/src/__tests__/setup.ts) (jest-dom matchers, cleanup, fresh `fetch` mock per test).

Layout:

- `ui/src/__tests__/lib/*.test.ts` — api client + react-query hook contracts (URL, method, body, cache invalidation)
- `ui/src/__tests__/components/*.test.tsx` — integration-style rendering with `QueryClientProvider` and a route-aware `fetch` mock (`makeRouter({ "GET /path": body, ... })`) that throws on unmocked calls

These tests catch contract drift between UI and backend (e.g. the disable endpoints now require `{ name, level }` bodies; the MCP path is `/disabled-mcp` not `/disabled`) without spinning up a real server. They complement, not replace, Playwright E2E.

## Tier 3: Smoke

```bash
npm run test:smoke
```

Runner: [tests/smoke/run.ts](../tests/smoke/run.ts). Each `tests/smoke/test-*.ts` is an independent tsx process that:

1. Picks a free port
2. Creates a `mkdtempSync` directory as `FLOCKCTL_HOME`
3. Spawns `npx tsx src/server-entry.ts --port <free>` with that env
4. Polls `/health` until ready (15 s timeout)
5. Makes HTTP calls, asserts
6. SIGTERMs the server, cleans up tmpdir

Harness: [tests/smoke/_harness.ts](../tests/smoke/_harness.ts) exports `startFlockctl()` and `assert()`.

### Writing a new smoke test

Create `tests/smoke/test-<feature>.ts`:

```ts
import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  const r = await fetch(`${srv.baseUrl}/your/endpoint`);
  assert(r.status === 200, `expected 200, got ${r.status}`);
} finally {
  await srv.stop();
}
```

Smoke covers things unit tests can't: real migrations, real route wiring, real boot-time seeding, the actual Hono+Node server stack.

## Tier 4: UI E2E (Playwright)

```bash
npm run test:e2e
```

Config: [ui/playwright.config.ts](../ui/playwright.config.ts). Starts both:

- Backend `server-entry.ts` on port `52078` (override with `E2E_BACKEND_PORT`)
- Vite dev server on port `5174` (override with `E2E_FRONTEND_PORT`) — note we use 5174, not 5173, to avoid clashing with a manually-started dev server
- `FLOCKCTL_HOME` is set to `.e2e-data/` in the repo root

Specs live in [ui/e2e/](../ui/e2e/). Use the `request` fixture to seed data via the API, then drive the page with `page.goto()` + locators.

First-time setup:

```bash
cd ui && npx playwright install chromium
```

CI already installs `--with-deps` automatically.

### Why a separate port for E2E?

Playwright's `reuseExistingServer: !CI` option silently reuses whatever is already listening — including a `npm run dev` you forgot was running. That stale dev server has the old proxy target hardcoded, producing 502s on every request. Using a dedicated port `5174` sidesteps the issue entirely.

## Tier 5: Live (env-gated)

```bash
FLOCKCTL_LIVE_TESTS=1 \
ANTHROPIC_API_KEY=sk-ant-... \
OPENAI_API_KEY=sk-... \
npm run test:live
```

Runner: [tests/live/run.ts](../tests/live/run.ts). Each live test:

- Checks its required env var / CLI
- Exits with code `77` if the prerequisite is absent → runner logs "skipped", doesn't count as failure
- Otherwise makes a real API call and asserts on response + usage

Live tests are **not** in CI because repository secrets aren't configured by default. Run them locally before shipping any AI-integration change.

## Tier 6: CLI-Docker

```bash
npm run test:cli-docker
```

Runner: [tests/cli-docker/run.ts](../tests/cli-docker/run.ts). Dockerfile: [tests/cli-docker/Dockerfile](../tests/cli-docker/Dockerfile). The harness builds a disposable container image with Node + the locally-built `flockctl` CLI, launches a real daemon inside, and drives every `flockctl` subcommand (project, workspace, token, state-machines, lifecycle, …) against it. Each `tests/cli-docker/test-*.ts` spawns its own container so tests never share daemon state.

**What it exercises.** Every command exposed by [src/cli.ts](../src/cli.ts) and [src/cli-commands/](../src/cli-commands/), end-to-end, against a live daemon — catches argv parsing regressions, output-format drift, and exit-code contract breaks that pure unit tests can't see. This is the *only* tier that covers the CLI against a real HTTP daemon.

**Prerequisites.**

- Docker daemon reachable (the runner exits non-zero if `docker info` fails).
- ~2 GB of free disk for the base image.
- No AI keys needed — the daemon is booted without any `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

**When to run.** After any change to [src/cli.ts](../src/cli.ts) or anything under [src/cli-commands/](../src/cli-commands/). Optional otherwise. The tier is **not** part of the default `pretest` / `test:coverage` chain — it's heavy and Docker-gated, so it runs explicitly.

**Coverage gate.** The container collects c8 coverage over the CLI entry files and enforces **100% line + branch** on `src/cli.ts` + `src/cli-commands/**`. A drop below 100% on those files exits `1` and fails the tier. Regular service/route coverage still lives in Tier 1–2.

## Coverage

Current thresholds in [vitest.config.ts](../vitest.config.ts):

```ts
thresholds: {
  statements: 80,
  lines: 82,
  branches: 68,
  functions: 76,
}
```

Baseline (as of this writing) is roughly 87.6 / 90.3 / 75.2 / 83.4 — thresholds are intentionally ~5% below baseline so incidental wobble doesn't break CI but real regressions do.

View the HTML report:

```bash
npm run test:coverage
open coverage/index.html
```

If a new file legitimately can't be covered by tests (CLI entry points, process boot code, daemon wrappers), add it to `exclude` in [vitest.config.ts](../vitest.config.ts). Don't lower the thresholds to accommodate untested business logic.

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs two parallel jobs on every push to `main` and every PR:

1. **backend**: `npm ci` → `npm run typecheck` → `npm run test:coverage` → `npm run test:smoke` → uploads `coverage/` as an artifact
2. **ui**: root `npm ci` → UI `npm ci` → `typecheck:ui` → `lint:ui` → UI build → install Playwright → `test:e2e` → uploads `playwright-report/` on failure

Live tests do not run in CI.

## Rules for contributors

- **After any feature or bugfix:** `npm run test:coverage`.
- **If you touch UI:** `npm run test:e2e` too.
- **If you touch AI integration** (`ai-client.ts`, `agent-session.ts`, `claude-cli.ts`, or any file in `src/services/agents/`): run `npm run test:live` locally before opening the PR.
- **If you add or change a migration:** run `npm run test:smoke` against a fresh `FLOCKCTL_HOME`. Smoke catches missing `_journal.json` entries and unsplit multi-statement SQL.
- **If you touch `src/cli.ts` or anything under `src/cli-commands/`:** run `npm run test:cli-docker` locally before opening the PR. Docker must be running.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no such table` in a Vitest test | `src/__tests__/helpers.ts` out of sync with `src/db/schema.ts` | Add the missing DDL to `createTestDb()` |
| `more than one statement` on fresh-DB boot | `.sql` migration missing `--> statement-breakpoint` between statements | Insert breakpoints — the drizzle better-sqlite3 migrator prepares each segment as a single statement |
| Migration runs in tests but not prod | No entry in [migrations/meta/_journal.json](../migrations/meta/_journal.json) | Add the entry |
| Playwright test times out on navigation | Stale Vite dev server on the target port | Kill it, or set `E2E_FRONTEND_PORT` |
| WS test hangs in Vitest | `wsManager` clients not cleared between tests | In `afterEach`, call `wsManager.closeAll()` |
| Coverage threshold fails after adding a file | Untested logic or wrong exclude | Add tests; extend `exclude` only for non-business code (CLI, boot, daemon) |
| Smoke test fails but unit tests pass | Something only wired in real `server-entry.ts` — DB migration, seed, scheduler boot | Inspect the smoke test's stdout/stderr (runner prints both on failure) |
