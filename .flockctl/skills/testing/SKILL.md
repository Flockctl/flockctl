---
name: testing
description: Flockctl unified testing workflow — Vitest backend + Playwright UI E2E + smoke/live tiers. Use when the user asks to run tests, fix failing tests, validate a feature, or check nothing is broken. MANDATORY after completing any feature or bugfix. Keywords: test, тест, тесты, vitest, playwright, npm run test, прогони тесты, запусти тесты, coverage, smoke, e2e, live tests, валидация, проверка, фича готова, feature done.
---

# Flockctl Testing

Six tiers, ordered by cost. Run lower tiers first; climb only as far as the change warrants. The canonical test scripts live in [package.json](package.json). Long-form operator docs: [docs/TESTING.md](docs/TESTING.md).

| Tier | What it checks | Command | When |
|---|---|---|---|
| 0 Sanity | Typecheck (backend + UI), UI lint | `npm run typecheck && npm run typecheck:ui && npm run lint:ui` | Always, before anything |
| 1–2 Unit + Integration | Routes, services, DB via in-memory SQLite | `npm run test` | After every code change |
| 1–2 + Coverage | Same + v8 thresholds | `npm run test:coverage` | Before declaring a feature done |
| 3 Smoke | Real `server-entry.ts` boot, `/health`, `/meta`, CRUD via HTTP | `npm run test:smoke` | Before merging backend changes |
| 4 UI E2E | Playwright against real backend + Vite dev server | `npm run test:e2e` | When UI changes |
| 5 Live | Real Anthropic / OpenAI / Claude CLI roundtrips | `FLOCKCTL_LIVE_TESTS=1 npm run test:live` | Before shipping AI-integration changes |

Tiers 0–4 run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)). Tier 5 is local-only and env-gated.

## Tier 0: Sanity

```bash
npm run typecheck      # tsc --noEmit (backend)
npm run typecheck:ui   # cd ui && tsc -b --noEmit
npm run lint:ui        # cd ui && npm run lint
```

`pretest` auto-runs `typecheck` before `npm run test`.

## Tier 1–2: Unit + Integration (Vitest)

```bash
npm run test            # all tests
npm run test:watch      # watch mode
npm run test:coverage   # with v8 coverage + thresholds
```

**Test locations:** [src/__tests__/](src/__tests__/) — mirrors source layout.

- `src/__tests__/routes/*.test.ts` — Hono routes, driven via `app.request()`
- `src/__tests__/services/*.test.ts` — service classes / pure functions
- `src/__tests__/lib/*.test.ts` — small helpers (errors, pagination, types)
- `src/__tests__/db.test.ts`, `schema.test.ts` — DB contract tests
- `src/__tests__/middleware/remote-auth.test.ts` — bearer auth + rate limiting

**Harness:** [src/__tests__/helpers.ts](src/__tests__/helpers.ts) exposes `createTestDb()` → in-memory SQLite + Drizzle + DDL that **must mirror** [src/db/schema.ts](src/db/schema.ts). When you change the schema, update the migration **and** `createTestDb()` **and** [migrations/meta/_journal.json](migrations/meta/_journal.json) — see memory `feedback_drizzle_migrations`.

**Route tests:** use Hono's `app.request()` to invoke routes directly without a network hop. Always `setDb(db, sqlite)` from [src/db/index.ts](src/db/index.ts) inside `beforeEach` so the code under test sees the in-memory handle.

**Style:** `describe` / `it` / `expect`. No classes. Names: `"should <action> when <condition>"` or plain English.

## Tier 3: Smoke

```bash
npm run test:smoke
```

Runner: [tests/smoke/run.ts](tests/smoke/run.ts). Each `tests/smoke/test-*.ts` spawns a **real** `server-entry.ts` on a free port with `FLOCKCTL_HOME` pointing at a `mkdtempSync` directory, makes HTTP calls, and asserts. Shared harness in [tests/smoke/_harness.ts](tests/smoke/_harness.ts) — `startFlockctl()` returns `{ baseUrl, home, stop }`.

Smoke is where real migrations, real route wiring, and real boot-time seeding get checked end-to-end. [tests/smoke/test-migrations-clean.ts](tests/smoke/test-migrations-clean.ts) specifically guards the migration journal.

## Tier 4: UI E2E (Playwright)

```bash
npm run test:e2e
```

Config: [ui/playwright.config.ts](ui/playwright.config.ts) starts both backend (port 52078) and Vite (port 5174) with `reuseExistingServer: !CI`. Specs in [ui/e2e/](ui/e2e/) drive real Chromium. Use the `request` fixture to seed data via the API before navigating.

Install browsers once: `cd ui && npx playwright install chromium`.

## Tier 5: Live (env-gated, NOT in CI)

```bash
FLOCKCTL_LIVE_TESTS=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm run test:live
```

Runner: [tests/live/run.ts](tests/live/run.ts). Individual tests exit with code `77` when their prerequisite key/binary is absent, so a partial environment is still useful.

## Common Issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `no such table` / `no such column` in a Vitest test | `src/__tests__/helpers.ts` out of sync with `src/db/schema.ts` | Add the missing DDL to `createTestDb()`; see memory `feedback_drizzle_migrations` |
| Migration applies in tests but fails on real DB boot | Missing entry in `migrations/meta/_journal.json` | Add the journal entry |
| Fresh-DB boot fails with "more than one statement" | SQL migration missing `--> statement-breakpoint` between statements | Add breakpoints — drizzle's better-sqlite3 migrator prepares one statement per segment |
| Coverage threshold fails on a new file | Uncovered code | Add a test or extend `exclude` in `vitest.config.ts` (the latter only for non-business logic) |
| Playwright reuses a stale dev server | Another `vite` instance on port 5174 | Kill it, or set `E2E_FRONTEND_PORT` to something free |
| Smoke test hangs | Server didn't signal ready | Check `server-entry.ts` logs; the harness waits on `/health` |
| 401 from smoke test | Smoke harness set a token you didn't authenticate with | Use the helper; don't hard-code `Authorization` headers in specs |

## Rules

- After **any** feature or bugfix: `npm run test:coverage`.
- If the change touches UI: **also** `npm run test:e2e`.
- If the change touches AI integration (`ai-client`, `agent-session`, `claude-cli`, `services/agents/`, any provider): run `npm run test:live` locally before opening the PR. Don't rely on CI for this.
- If the change touches migrations: run `npm run test:smoke` against a clean `FLOCKCTL_HOME` — smoke boots a fresh DB end-to-end and catches unapplied migrations.
