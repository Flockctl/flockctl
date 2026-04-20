# Flockctl — Development Guide

## Setup

```bash
git clone <repo-url> && cd Flockctl
npm install
npm run dev          # Start with hot-reload (tsx watch)
```

Server runs at `http://localhost:52077`.

## Tech Stack

- **TypeScript** (ESM, strict mode)
- **Hono** — HTTP framework
- **Drizzle ORM** + **better-sqlite3** — database
- **Vitest** — testing
- **Commander.js** — CLI
- **React 18** + **Vite** + **shadcn/ui** — frontend (in `ui/`)

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with tsx watch |
| `npm run build` | Build TypeScript + UI |
| `npm start` | Start daemon (requires build) |
| `npm stop` | Stop daemon |
| `npm test` | Vitest unit + integration (pretest runs typecheck) |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run test:coverage` | Vitest + v8 coverage + threshold enforcement |
| `npm run test:smoke` | Real `server-entry.ts` boot + HTTP assertions |
| `npm run test:e2e` | UI E2E via Playwright (headless Chromium) |
| `FLOCKCTL_LIVE_TESTS=1 npm run test:live` | Live AI / CLI roundtrips (not in CI) |
| `npm run typecheck` / `npm run typecheck:ui` | TypeScript `--noEmit` for backend / UI |
| `npm run lint:ui` | ESLint for the UI package |
| `npm run db:generate` | Generate Drizzle migration |
| `npm run db:migrate` | Apply migrations |

## Project Layout

```
src/
├── cli.ts              # CLI (flockctl start/stop/status/token)
├── daemon.ts           # PID file, fork-based background process
├── server.ts           # Hono app setup, dynamic CORS, route registration
├── server-entry.ts     # Process entry point (migrations, rc-perm check, services)
├── config.ts           # FLOCKCTL_HOME + ~/.flockctlrc (incl. remoteAccessToken)
├── middleware/
│   └── remote-auth.ts  # Bearer-token guard, rate limiter, WS token verify
├── db/
│   ├── schema.ts       # 11 Drizzle ORM table definitions
│   ├── index.ts        # DB connection
│   └── migrate.ts      # Migration runner
├── routes/             # 14 Hono route files
├── services/           # business logic modules (incl. permission-resolver, project-config)
├── lib/                # Shared utilities (errors, pagination, slugify, types)
└── __tests__/          # Vitest tests
```

## Adding a New API Endpoint

1. Create or edit a route file in `src/routes/`
2. Register it in `src/server.ts` via `app.route("/prefix", routes)`
3. Write tests in `src/__tests__/routes/`
4. Update `docs/API.md`

## Adding a Database Column

1. Edit `src/db/schema.ts`
2. Run `npm run db:generate` to create a migration
3. Migration is applied automatically on next startup
4. Update `docs/DATABASE.md`

## Testing

Full details and the six-tier ladder live in [TESTING.md](TESTING.md). Quick reference:

```bash
npm run test             # Vitest (in-memory SQLite, ~60 files)
npm run test:coverage    # + v8 coverage thresholds
npm run test:smoke       # real server boot + HTTP
npm run test:e2e         # UI E2E (Playwright)
FLOCKCTL_LIVE_TESTS=1 npm run test:live   # real AI / CLI roundtrips
```

After any feature or bugfix run at minimum `npm run test:coverage`; if you touched the UI, also `npm run test:e2e`; if you touched AI integration, run `npm run test:live` locally before the PR.

Helpers: `createTestDb()` in [src/__tests__/helpers.ts](../src/__tests__/helpers.ts) — its DDL must mirror [src/db/schema.ts](../src/db/schema.ts) exactly.

## Conventions

- All API responses are JSON with `charset=UTF-8`
- Pagination: `page` + `perPage` params → `{ items, total, page, perPage }`
- Errors: `{ error: string, details?: any }` with appropriate HTTP status
- Timestamps: ISO 8601 in UTC
- JSON arrays in DB: stored as stringified JSON (e.g., `allowedKeyIds`, `envVars`)
- **Auth is mode-dependent.** Local mode (no `remoteAccessToken` in `~/.flockctlrc`) leaves endpoints open. Remote mode adds a `remoteAuth` middleware that requires `Authorization: Bearer <token>` for non-localhost callers — see [SECURITY.md](SECURITY.md).
- Planning entities (milestones, slices, tasks) are stored as YAML files on disk, not in SQLite
- Portable project config (`model`, `baseBranch`, `testCommand`, `permissionMode`, `disabledSkills`, `disabledMcpServers`, …) lives in `<project>/.flockctl/config.json`. The DB stores only machine-local state.
