/**
 * `flockctl migrate ...` — drive the SQLite schema migration without
 * starting the daemon.
 *
 * The daemon already runs `runMigrations()` on every boot via
 * `server-entry.ts`, so this command is mostly an escape hatch:
 *
 *   - You stopped the daemon, restored a backup from an older version,
 *     and want to upgrade the schema before booting again.
 *   - You're poking at FLOCKCTL_HOME from a separate shell and need to
 *     make sure migrations are applied.
 *
 * Subcommands:
 *   status — list migration files in the bundled folder
 *   up     — apply pending migrations (idempotent)
 *
 * `status` does NOT inspect the SQLite `__drizzle_migrations` table;
 * a "real" status diff would need to mirror Drizzle's hashing logic
 * and we don't have a stable public API for that. Listing the on-disk
 * migration set is the next-best thing for ops use.
 */
import type { Command } from "commander";
import { readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

function getMigrationsFolder(): string {
  // Mirror src/db/migrate.ts: relative to this module, not process.cwd().
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "migrations");
}

export function registerMigrateCommand(program: Command): void {
  const cmd = program
    .command("migrate")
    .description("Apply / inspect the SQLite schema migrations.");

  cmd
    .command("status")
    .description("List migration files bundled with this build.")
    .action(() => {
      const folder = getMigrationsFolder();
      if (!existsSync(folder)) {
        console.error(`Error: migrations folder not found at ${folder}.`);
        process.exit(1);
      }
      const journal = join(folder, "meta", "_journal.json");
      const sqlFiles = readdirSync(folder)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      console.log(`folder:  ${folder}`);
      console.log(`journal: ${existsSync(journal) ? "present" : "MISSING"}`);
      console.log(`files:`);
      for (const f of sqlFiles) console.log(`  ${f}`);
    });

  cmd
    .command("up")
    .description("Apply pending migrations against FLOCKCTL_HOME's flockctl.db.")
    .action(async () => {
      const { runMigrations } = await import("../db/migrate.js");
      try {
        runMigrations();
        console.log("Migrations applied.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error applying migrations: ${msg}`);
        process.exit(1);
      }
    });
}
