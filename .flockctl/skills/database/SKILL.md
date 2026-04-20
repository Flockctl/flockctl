---
name: database
description: Flockctl database schema and ORM patterns — Drizzle ORM tables, better-sqlite3 in WAL mode, drizzle-kit migrations, journal/helpers invariants, column conventions, indexes, cascade rules, and query idioms. Use when creating or modifying a Drizzle table, generating a migration, adding a column, optimizing a query, or designing schema changes. Keywords: database, db, drizzle, drizzle-orm, drizzle-kit, better-sqlite3, sqlite, WAL, schema, схема, column, колонка, добавь поле, table, таблица, index, индекс, foreign key, cascade, migration, миграция, _journal.json, statement-breakpoint.
---

# Flockctl Database Conventions

## Tech Stack

- **ORM**: [drizzle-orm](https://orm.drizzle.team/) with the SQLite dialect
- **Driver**: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — synchronous, in-process
- **Migrations**: [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) (`npm run db:generate` / `npm run db:migrate`)
- **Mode**: WAL (`journal_mode = WAL`, `foreign_keys = ON`) — set in [src/db/index.ts](src/db/index.ts)
- **Tests**: In-memory SQLite via `createTestDb()` in [src/__tests__/helpers.ts](src/__tests__/helpers.ts)

There is **no** Postgres, Alembic, or async driver in this project. Every DB call is synchronous.

## Schema Overview

All tables live in a single file: [src/db/schema.ts](src/db/schema.ts). The README lists 11 core tables:

```
Workspace (1) ── (N) Project
                    │
                    ├── (N) Task ── (N) TaskLog
                    ├── (N) TaskTemplate ── (N) Schedule
                    ├── (N) Chat ── (N) ChatMessage
                    └── (N) Milestone (FS, not DB)
                          └── (N) Slice ── (N) PlanTask  (both FS-backed)

AIProviderKey (stand-alone; referenced by Task.assignedKeyId / UsageRecord.aiProviderKeyId)
UsageRecord  (← Task, ChatMessage, Project, AIProviderKey  all ON DELETE SET NULL)
BudgetLimit  (scope = global | project | workspace)
```

> Milestones, slices, and plan tasks live on disk under `{projectPath}/.flockctl/plan/` — see the `planning` skill. The DB stores only execution tasks.

### Core tables (see [src/db/schema.ts](src/db/schema.ts) for the full definition)

| Table | Purpose | Notable columns |
|---|---|---|
| `workspaces` | Top-level grouping | `name` (unique), `path` (unique), `allowedKeyIds` |
| `projects` | Git-backed work unit | `workspaceId` (SET NULL on workspace delete), `path`, `allowedKeyIds`, `deniedKeyIds` |
| `tasks` | Execution unit | `projectId` (CASCADE), `status`, `taskType`, `assignedKeyId`, `requiresApproval`, `claudeSessionId`, `permissionMode` |
| `task_logs` | Streaming log lines | `taskId` (CASCADE), `content`, `streamType` |
| `task_templates` | Reusable recipe | `projectId` (CASCADE), `prompt`, `assignedKeyId` |
| `schedules` | Cron / one-shot | `templateId` (CASCADE), `cronExpression`, `timezone`, `status`, `nextFireTime` |
| `chats` | Conversation | `workspaceId` (SET NULL), `projectId` (CASCADE), `claudeSessionId` |
| `chat_messages` | Single turn | `chatId` (CASCADE), `role`, `content` |
| `usage_records` | Per-call tokens / cost | everything SET NULL so history survives deletions |
| `budget_limits` | Spend cap | `scope` (global/project/workspace), `period`, `limitUsd`, `action` |
| `ai_provider_keys` | API key / CLI config | `provider`, `providerType`, `priority`, `consecutiveErrors`, `disabledUntil` |

## Table Definition Pattern

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  prompt: text("prompt"),
  status: text("status").default("queued").notNull(),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_tasks_project_status").on(table.projectId, table.status),
]);
```

### Column Conventions

| Area | Convention |
|---|---|
| Table name | Plural snake_case: `tasks`, `ai_provider_keys`, `chat_messages` |
| Column name | snake_case DB side, camelCase TS side (Drizzle maps both) |
| Primary key | `integer("id").primaryKey({ autoIncrement: true })` |
| FK with cascade | `integer("…_id").references(() => parent.id, { onDelete: "cascade" })` |
| FK that should survive parent delete | `{ onDelete: "set null" }` — used for `usage_records` fields and `projects.workspaceId` |
| Boolean | `integer("…", { mode: "boolean" }).default(false)` — SQLite has no native bool |
| Timestamp | `text("created_at").default(sql\`(datetime('now'))\`)` |
| JSON-ish data | `text("...")` storing `JSON.stringify` output — see `allowedKeyIds`, `failedKeyIds`, `envVars` |
| Enum-ish status | `text("status")` + constants in [src/lib/types.ts](src/lib/types.ts) + guard functions |

## Query Idioms

Always go through `getDb()` — never instantiate your own `new Database(...)`.

```ts
import { getDb } from "../db/index";
import { tasks } from "../db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

// one
const task = getDb().select().from(tasks).where(eq(tasks.id, id)).get();

// many
const queued = getDb().select().from(tasks)
  .where(and(eq(tasks.status, "queued"), eq(tasks.projectId, pid)))
  .orderBy(desc(tasks.createdAt))
  .limit(50)
  .all();

// count
const count = getDb().select({ n: sql<number>`count(*)` }).from(tasks).get()?.n ?? 0;

// insert
const row = getDb().insert(tasks).values({ prompt: "hi", projectId: 1 }).returning().get();

// update
getDb().update(tasks).set({ status: "running", startedAt: new Date().toISOString() })
  .where(eq(tasks.id, id)).run();

// delete
getDb().delete(tasks).where(eq(tasks.id, id)).run();
```

Pagination goes through [src/lib/pagination.ts](src/lib/pagination.ts) (`paginationParams(c) → { page, perPage, offset }`).

## Migrations (drizzle-kit)

### Workflow

```bash
# 1. Edit src/db/schema.ts — add a column / table / index
# 2. Generate SQL:
npm run db:generate          # writes migrations/NNNN_*.sql + updates migrations/meta/

# 3. Inspect the generated file — drizzle-kit sometimes emits TABLE rewrites
#    when you only wanted ALTER. Trim to the minimal diff when possible.

# 4. Apply to your local DB (the daemon also runs this at startup via
#    src/db/migrate.ts):
npm run db:migrate
```

Migrations live in [migrations/](migrations/). Names are zero-padded: `0023_add_something.sql`.

### CRITICAL — three-place invariant

> See memory note **feedback_drizzle_migrations**.

Every new `.sql` migration **must** be mirrored in three places, or tests / smoke / production will diverge silently:

1. **The `.sql` file** in [migrations/](migrations/) — with `--> statement-breakpoint` between every statement. The drizzle / better-sqlite3 migrator prepares each segment as a single statement; without breakpoints you get `SQLITE_ERROR: more than one statement` at boot.
2. **An entry in [migrations/meta/_journal.json](migrations/meta/_journal.json)** — `{ idx, version, when, tag, breakpoints }`. `drizzle-kit generate` adds this for you, but if you hand-author a migration or rename one, update the journal by hand.
3. **The DDL inside `createTestDb()`** in [src/__tests__/helpers.ts](src/__tests__/helpers.ts). In-memory tests don't run the migration files — they rebuild the schema from scratch. If you add a column only to the real migration, every Vitest test that touches the new column will fail with `no such column: …`.

The smoke tier ([tests/smoke/test-migrations-clean.ts](tests/smoke/test-migrations-clean.ts)) boots a fresh DB end-to-end and catches (1) and (2). Forgetting (3) only shows up in Vitest.

### Statement breakpoint example

```sql
ALTER TABLE usage_records ADD COLUMN ai_provider_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX idx_usage_records_key ON usage_records(ai_provider_key_id);
```

### Data migrations

Plain SQL, still needs the breakpoint:

```sql
UPDATE tasks SET status = 'queued' WHERE status IS NULL;
--> statement-breakpoint
```

## Cascade / Set-Null Rules (reference)

- `projects.workspaceId` → `SET NULL` — deleting a workspace orphans its projects but keeps them.
- `tasks.projectId`, `task_logs.taskId`, `task_templates.projectId`, `schedules.templateId`, `chats.projectId`, `chat_messages.chatId` → `CASCADE`.
- `chats.workspaceId` → `SET NULL`.
- Every FK in `usage_records` → `SET NULL` (spend history survives resource deletion).

When you add a new FK, decide explicitly which rule applies and add it to the audit questions in the `code-audit` skill.

## Testing With In-Memory SQLite

`createTestDb()` returns `{ sqlite, db }`. Call `setDb(db, sqlite)` from `src/db/index.ts` inside `beforeEach` so route/service code under test picks up the in-memory handle.

Behavioural differences from the real DB:
- `:memory:` databases **do** enforce foreign keys because `createTestDb()` sets `PRAGMA foreign_keys = ON`.
- No migration files are executed; DDL in `helpers.ts` is the source of truth.
- WAL is enabled but meaningless for `:memory:`.
