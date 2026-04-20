---
name: performance
description: Flockctl performance profiling and optimization — SQLite WAL tuning, better-sqlite3 prepared statements, WebSocket fan-out efficiency, SSE backpressure, React rendering, and Vite bundle analysis. Use when optimizing slow endpoints, profiling queries, improving load time, reducing bundle size, investigating memory leaks, or tuning concurrency. Keywords: performance, производительность, оптимизация, optimize, профилирование, profiling, slow, медленно, тормозит, bundle, бандл, N+1, prepared statement, wal, sqlite, websocket, sse.
---

# Flockctl Performance

## Architecture Overview

Flockctl is a single Node.js daemon:

- **Backend**: Hono on `@hono/node-server` — synchronous better-sqlite3 queries, event-loop-driven, no worker pool
- **DB**: One SQLite file in WAL mode (see [src/db/index.ts](src/db/index.ts))
- **Realtime**: SSE (chat) + WebSocket fan-out via [src/services/ws-manager.ts](src/services/ws-manager.ts)
- **Frontend**: React + Vite SPA under [ui/](ui/)

There's no Postgres, Redis, or message broker — performance work targets SQLite, event-loop latency, and bundle/render cost.

## Backend Performance

### SQLite / WAL

[src/db/index.ts](src/db/index.ts) opens the DB with:

```ts
_sqlite = new Database(path);
_sqlite.pragma("journal_mode = WAL");
_sqlite.pragma("foreign_keys = ON");
```

WAL gives concurrent readers against a writer. Writes still serialise — don't wrap long-running transactions around WebSocket fan-out or SDK calls.

Useful extra pragmas when investigating slow queries:

```ts
sqlite.pragma("synchronous = NORMAL");     // safe with WAL
sqlite.pragma("cache_size = -65536");       // 64 MB page cache
sqlite.pragma("temp_store = MEMORY");
sqlite.pragma("mmap_size = 268435456");     // 256 MB mmap
```

Benchmark before and after — on small DBs the default is already fine.

### Indexes and Hot Queries

Indexes are declared inline in [src/db/schema.ts](src/db/schema.ts):

```ts
}, (table) => [
  index("idx_tasks_project_status").on(table.projectId, table.status),
  index("idx_tasks_status_created").on(table.status, table.createdAt),
]);
```

Before adding one, `EXPLAIN QUERY PLAN` the slow statement:

```ts
const plan = getRawDb().prepare("EXPLAIN QUERY PLAN SELECT ... ").all();
```

If you see `SCAN TABLE tasks`, you need an index. If you already have one but it isn't used, check that the column order in the `WHERE`/`ORDER BY` matches the index.

### Prepared Statements

better-sqlite3 caches prepared statements per `Database` instance automatically when you call `.prepare()` and reuse it. Drizzle's `.get()` / `.all()` paths prepare internally, but for hot loops you can drop down:

```ts
const stmt = getRawDb().prepare(`SELECT id FROM tasks WHERE status = ?`);
for (const status of statuses) {
  const rows = stmt.all(status);
}
```

Don't re-prepare inside a loop — that defeats the cache.

### Avoid N+1

```ts
// BAD — one query per task
for (const t of tasks) {
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, t.assignedKeyId)).get();
}

// GOOD — one join
const rows = db.select({ task: tasks, assignedKeyLabel: aiProviderKeys.label })
  .from(tasks)
  .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
  .all();
```

See the task-list query in [src/routes/tasks.ts](src/routes/tasks.ts) for the canonical join pattern.

### Pagination

Every list endpoint goes through `paginationParams(c)` in [src/lib/pagination.ts](src/lib/pagination.ts). `perPage` is clamped to `1..100`. Don't invent your own offset math.

### Synchronous I/O vs. the Event Loop

better-sqlite3 blocks the event loop while it runs. That's fine for fast indexed queries (µs) but catastrophic for full-table scans under load. When profiling a slow route:

1. Time the SQL alone (`console.time` around the `.all()` / `.get()`).
2. If it's >5 ms, fix the index or the query shape before blaming Hono / JSON.
3. Never hold the DB across an `await` on a network / SDK call — do the query, release locals, then `await`.

### WebSocket Fan-Out

[src/services/ws-manager.ts](src/services/ws-manager.ts) routes every message. Cost factors:

- `broadcastAll` is O(connected clients) — fine for dozens, expensive for thousands
- `broadcast(taskId, …)` only touches subscribers of that task; prefer it over `broadcastAll` for per-task events
- Messages are JSON-stringified once per call (`_send` reuses the string across clients) — don't stringify inside your loop before calling the manager

For high-volume log streaming (task logs during a long task), batch emits on a timer (e.g. 100 ms) rather than on every chunk.

### SSE Streams

Chat turns stream over SSE via `streamSSE(c, …)` in [src/routes/chats.ts](src/routes/chats.ts). Backpressure: if a client is slow, `stream.writeSSE` awaits — use `AbortSignal` hooks in [src/services/chat-executor.ts](src/services/chat-executor.ts) to cancel the SDK turn when a client disconnects, otherwise the executor keeps generating tokens into a dead socket.

## Frontend Performance

### Vite Bundle

Config: [ui/vite.config.ts](ui/vite.config.ts).

```bash
cd ui && npm run build
ls -lah dist/assets/
```

Route-level code-splitting is in [ui/src/main.tsx](ui/src/main.tsx) (`React.lazy` + `Suspense`). Each page in [ui/src/pages/](ui/src/pages/) ships as its own chunk.

### React Render Cost

- TanStack Query handles caching — set `staleTime` per query, don't refetch on every focus unless the data truly changes that often.
- Memoize list rows (`React.memo`) before adding virtualization.
- Drawer/dialog components should not mount the heavy body until opened — see the pattern in [ui/src/components/confirm-dialog.tsx](ui/src/components/confirm-dialog.tsx).

### WebSocket Client

[ui/src/lib/ws.ts](ui/src/lib/ws.ts) is the single consumer. Avoid subscribing to `broadcastAll` from per-row components — subscribe in a page-level effect and push updates down via React Query's cache.

## Profiling Commands

```bash
# SQLite: live query plans
sqlite3 ~/flockctl/flockctl.db
sqlite> EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = 1 AND status = 'queued';

# Backend: log SQL — temporarily wrap getRawDb() calls with console.time,
# or use better-sqlite3's profile hook:
#   sqlite.function("profile", { deterministic: false }, (sql, ms) => console.log(ms, sql));

# Frontend bundle analysis:
cd ui && npm run build && du -sh dist/assets/*

# Backend live resource usage (Node):
node --inspect dist/cli.js start
# then attach Chrome DevTools at chrome://inspect
```

## Performance Checklist

### Backend
- [ ] Hot queries have an index (check `EXPLAIN QUERY PLAN`)
- [ ] List endpoints go through `paginationParams`
- [ ] No queries inside loops — replace with a join
- [ ] Long-running SDK calls do not hold a DB statement across an `await`
- [ ] WebSocket fan-out uses the scoped method (`broadcast`, `broadcastChat`) when possible
- [ ] SSE streams cancel the underlying chat SDK call on disconnect

### Frontend
- [ ] Pages are lazy-loaded via `React.lazy` + `Suspense`
- [ ] TanStack Query has appropriate `staleTime` per query
- [ ] No unnecessary re-renders (React DevTools Profiler)
- [ ] New deps checked for bundle-size impact

### DB
- [ ] WAL on (default via `src/db/index.ts`) — verify after schema rebuilds in tests
- [ ] `foreign_keys = ON` so cascades behave consistently
- [ ] Added migrations mirrored into `createTestDb()` ([src/__tests__/helpers.ts](src/__tests__/helpers.ts)) and [migrations/meta/_journal.json](migrations/meta/_journal.json)
