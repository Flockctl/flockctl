import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { getFlockctlHome } from "../config/index.js";
import { join } from "path";
import { mkdirSync } from "fs";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

export type FlockctlDb = ReturnType<typeof drizzle<typeof schema>>;

export function getDb(dbPath?: string): FlockctlDb {
  if (_db) return _db;

  const dataDir = getFlockctlHome();
  mkdirSync(dataDir, { recursive: true });

  const path = dbPath ?? join(dataDir, "flockctl.db");
  _sqlite = new Database(path);
  // WAL gives us concurrent readers vs a writer (vs the default journal
  // mode that locks the whole DB on every write). Required for the
  // daemon's "many small reads + occasional writes" workload — every
  // route handler that does `db.select(...).get()` would otherwise queue
  // behind a single in-flight task-status update.
  _sqlite.pragma("journal_mode = WAL");
  // `synchronous = NORMAL` (vs the SQLite default `FULL`) skips the
  // per-write fsync between transaction boundaries. With WAL this is
  // SQLite's recommended setting — durability remains crash-safe (the
  // checkpoint on commit is still synced) and write throughput
  // increases ~2-3× under our typical task-execution load. The
  // tradeoff is a narrow window in which an OS-level crash (kernel
  // panic, sudden power loss; NOT a process crash) can lose the last
  // few committed transactions. For a single-user developer daemon the
  // tradeoff is overwhelmingly worth it; the next task run rebuilds
  // any lost state.
  _sqlite.pragma("synchronous = NORMAL");
  _sqlite.pragma("foreign_keys = ON");
  // busy_timeout (audit-round-7 finding): WAL mode lets concurrent
  // readers coexist with a single writer, but two writers (e.g. the
  // rate-limit scheduler firing while a route is processing a PATCH)
  // still serialise. Without busy_timeout, contention raises
  // SQLITE_BUSY as a synchronous Error → the catching handler returns
  // 500 (or worse, bubbles to server-entry's `unhandledRejection`
  // which calls process.exit). 5s is far more than any realistic
  // contention window and lets SQLite retry transparently.
  _sqlite.pragma("busy_timeout = 5000");

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/** Raw sqlite handle — for low-level operations (PRAGMA, unversioned columns). */
export function getRawDb(): InstanceType<typeof Database> {
  if (!_sqlite) {
    getDb();
  }
  if (!_sqlite) throw new Error("Database not initialized");
  return _sqlite;
}

/** Override DB instance (for testing with in-memory DB) */
export function setDb(db: FlockctlDb, sqlite?: InstanceType<typeof Database>) {
  _db = db;
  _sqlite = sqlite ?? null;
}

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
