import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./index.js";

// Resolve `migrations/` relative to *this module*, not `process.cwd()`.
// In dev: src/db/migrate.ts -> ../../migrations.
// In dist: dist/db/migrate.js -> ../../migrations (because the npm package
// ships migrations/ at the package root alongside dist/).
// Using cwd here is a real footgun: when a user runs `flockctl` from any
// directory other than the package root, drizzle resolves "./migrations"
// against their cwd, can't find _journal.json, and crashes the daemon
// before it ever opens a port. The smoke harness happened to spawn the
// daemon with cwd=repoRoot, so this manifested only after `npm install -g`.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "..", "..", "migrations");

export function runMigrations() {
  const db = getDb();
  migrate(db, { migrationsFolder });
}
