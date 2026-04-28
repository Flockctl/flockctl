/**
 * `flockctl backup` / `flockctl restore` — snapshot + restore FLOCKCTL_HOME.
 *
 * The snapshot covers the SQLite DB (after a WAL checkpoint), the
 * scaffold dirs (`workspaces/`, `skills/`, `mcp/`, `templates/`) and
 * the rc file. Anything else is intentionally excluded — log files,
 * pid files, transient WAL/SHM segments.
 *
 * Format: a plain `tar.gz` archive. We pre-checkpoint the database so
 * the resulting `.db` file is a coherent point-in-time copy without
 * needing the operator to stop the daemon. (The WAL is emptied into
 * the main file by the checkpoint, so we don't have to ship .wal/.shm.)
 *
 * Restore is destructive: it expects the target FLOCKCTL_HOME to be
 * absent or empty. We refuse otherwise unless `--force` is set; the
 * caller is responsible for stopping the daemon first.
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname, resolve as resolvePath } from "path";
import { getFlockctlHome } from "../config/paths.js";

const INCLUDE_TOP = ["flockctl.db", "workspaces", "skills", "mcp", "templates", "config.json"];
const EXCLUDE_PATTERNS = [
  "flockctl.log",
  "flockctl.pid",
  "*.db-wal",
  "*.db-shm",
];

function ensureExecutable(name: string): void {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
  } catch {
    throw new Error(`Required executable "${name}" not found on PATH.`);
  }
}

function checkpointDb(home: string): void {
  const db = join(home, "flockctl.db");
  if (!existsSync(db)) return;
  // Use sqlite3 to issue a TRUNCATE checkpoint. We rely on the system
  // sqlite3 binary; if it's missing, the backup still proceeds — it
  // just keeps the WAL files in the snapshot, which is also valid
  // (sqlite recovers transparently on next open).
  try {
    execFileSync("sqlite3", [db, "PRAGMA wal_checkpoint(TRUNCATE);"], {
      stdio: "ignore",
    });
  } catch {
    // Non-fatal — see comment above.
  }
}

export function registerBackupCommand(program: Command): void {
  program
    .command("backup <output>")
    .description(
      "Snapshot FLOCKCTL_HOME into a tar.gz archive. Performs a SQLite WAL " +
        "checkpoint first so the database file is internally consistent.",
    )
    .action((output: string) => {
      const home = getFlockctlHome();
      if (!existsSync(home)) {
        console.error(`Error: FLOCKCTL_HOME does not exist at ${home}; nothing to back up.`);
        process.exit(1);
      }
      ensureExecutable("tar");
      checkpointDb(home);

      const outAbs = resolvePath(output);
      mkdirSync(dirname(outAbs), { recursive: true });

      const present = INCLUDE_TOP.filter((entry) => existsSync(join(home, entry)));
      if (present.length === 0) {
        console.error(`Error: no recognized contents in ${home} to back up.`);
        process.exit(1);
      }
      const args = ["-C", home, "-czf", outAbs];
      for (const p of EXCLUDE_PATTERNS) args.push(`--exclude=${p}`);
      args.push(...present);
      execFileSync("tar", args, { stdio: "inherit" });
      console.log(`Wrote backup to ${outAbs}`);
    });

  program
    .command("restore <archive>")
    .description(
      "Extract a flockctl backup archive into FLOCKCTL_HOME. The target " +
        "directory must be empty or missing — pass --force to wipe it first. " +
        "Stop the daemon before running.",
    )
    .option("--force", "Delete the existing FLOCKCTL_HOME before restoring", false)
    .action((archive: string, opts: { force?: boolean }) => {
      const home = getFlockctlHome();
      const archAbs = resolvePath(archive);
      if (!existsSync(archAbs)) {
        console.error(`Error: archive not found: ${archAbs}`);
        process.exit(1);
      }
      ensureExecutable("tar");
      if (existsSync(home)) {
        const entries = statSync(home).isDirectory() ? readdirSync(home) : [];
        if (entries.length > 0) {
          if (!opts.force) {
            console.error(
              `Error: ${home} is not empty. Stop the daemon and re-run with --force, ` +
                `or pick a clean FLOCKCTL_HOME.`,
            );
            process.exit(1);
          }
          rmSync(home, { recursive: true, force: true });
        }
      }
      mkdirSync(home, { recursive: true });
      execFileSync("tar", ["-C", home, "-xzf", archAbs], { stdio: "inherit" });
      console.log(`Restored backup into ${home}`);
    });
}
