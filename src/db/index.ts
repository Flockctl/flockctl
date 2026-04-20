import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { getFlockctlHome } from "../config.js";
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
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

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
