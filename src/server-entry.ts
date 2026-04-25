import { runMigrations } from "./db/migrate.js";
import { backfillConfigsFromDb } from "./db/config-backfill.js";
import { startServer } from "./server.js";
import { SchedulerService } from "./services/scheduler.js";
import { wsManager } from "./services/ws-manager.js";
import { taskExecutor } from "./services/task-executor/index.js";
import { chatExecutor } from "./services/chat-executor.js";
import { seedDefaultKey } from "./services/ai/key-selection.js";
import { reconcilePlanStatuses, resumeStaleMilestones, cancelOrphanedExecutionTasks } from "./services/auto-executor.js";
import {
  seedBundledSkills,
  checkRcPermissions,
  hasRemoteAuth,
  purgeLegacyRemoteServers,
  getRemoteServers,
} from "./config/index.js";
import { seedDefaultSkills } from "./services/default-skills-seeder.js";
import { reconcileAllProjects } from "./services/claude/skills-sync.js";
import { reconcileAllMcp } from "./services/claude/mcp-sync.js";
import { evaluateBindSecurity } from "./lib/security-gate.js";
import { sweepOrphans as sweepAttachmentOrphans } from "./services/attachments.js";
import { closeDb } from "./db/index.js";
import { remoteServersPostDeps } from "./routes/meta.js";
import type { SshTunnelManager } from "./services/ssh-tunnels/manager.js";

// The process-wide SshTunnelManager lives as the default value of
// `remoteServersPostDeps.manager` in src/routes/meta.ts — same instance is
// used by the autostart below, the SIGTERM drain, and every `POST /meta/
// remote-servers` / `GET /meta/remote-servers` handler. Sharing the instance
// is what makes `getByServerId` return a meaningful status for an
// autostarted tunnel when the UI first lists servers. The type is narrowed
// on the dep object (for test-seam reasons); we cast to the full class here
// so we can reach `shutdown()` from the SIGTERM path.
const tunnelManager = remoteServersPostDeps.manager as SshTunnelManager;

function argValue(flag: string): string | undefined {
  return process.argv.find((_: string, i: number, a: string[]) => a[i - 1] === flag);
}
function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const port = parseInt(argValue("--port") ?? "52077", 10);
const host = argValue("--host") ?? "127.0.0.1";
const allowInsecurePublic = argFlag("--allow-insecure-public");

// 0. Pre-flight security gate — runs BEFORE any side-effecting startup work
//    so refusing to start doesn't run migrations or touch the DB.
{
  const decision = evaluateBindSecurity({
    host,
    port,
    hasToken: hasRemoteAuth(),
    allowInsecurePublic,
  });
  if (decision.action === "refuse") {
    console.error(decision.error);
    process.exit(1);
  }
  if (decision.warning) console.warn(decision.warning);
  if (decision.info) console.log(decision.info);
}

// 0a. Strip legacy direct-HTTP remote-server entries from ~/.flockctlrc
//     before anything else touches config or the DB. Runs here — after the
//     bind gate but before migrations — so the warning is grouped with the
//     other boot-time security/config notices and the rc file is already
//     in its post-migration shape by the time routes bind.
purgeLegacyRemoteServers();

// 1. Copy config fields from DB to .flockctl/config.json (JSON wins on
//    conflict). MUST run BEFORE migrations drop the old columns.
backfillConfigsFromDb();

// 2. Run migrations (may drop columns backfilled above)
runMigrations();

// 2. Seed default key if none exist
seedDefaultKey();

// 2d. Seed bundled skills to ~/flockctl/skills/
seedBundledSkills();

// 2d-ii. Seed default skills (src/resources/default-skills/) into
//        ~/flockctl/skills/. Copies, not symlinks — user must be free
//        to edit. Idempotent: existing targets are never overwritten.
try {
  const { seeded } = seedDefaultSkills();
  if (seeded.length > 0) {
    console.log(`[skills] seeded default skills: ${seeded.join(", ")}`);
  }
} catch (err) {
  console.warn("[skills] default-skills seeding failed:", err);
}

// 2e. Warn if .flockctlrc permissions are insecure when remote auth is active
if (hasRemoteAuth()) {
  const perms = checkRcPermissions();
  if (!perms.secure) {
    console.warn(`[SECURITY WARNING] ${perms.message}`);
  }
}

// 2f. Sweep orphaned attachment blobs — files on disk with no matching
//     chat_attachments row. Non-blocking: log and continue on error so a
//     corrupt attachments dir can't prevent boot.
try {
  const swept = sweepAttachmentOrphans();
  if (swept.removed > 0) {
    console.log(
      `[attachments] swept ${swept.removed} orphan(s) of ${swept.scanned} file(s) scanned`,
    );
  }
} catch (err) {
  console.warn("[attachments] orphan sweep failed:", err);
}

// 2a. Cancel duplicate execution tasks left behind when a plan re-trigger
//     repointed the plan file at a newer exec task id. Must run BEFORE
//     resetStaleTasks so those orphans don't get re-enqueued.
cancelOrphanedExecutionTasks();

// 2b. Reconcile plan task statuses with completed execution tasks
reconcilePlanStatuses();

// 2c. Re-queue stale tasks left running OR queued by previous daemon instance
const requeued = taskExecutor.resetStaleTasks();

// 2d. Resume auto-execution for milestones that were active before shutdown
resumeStaleMilestones();

// 3. Start background services
const scheduler = new SchedulerService();
scheduler.loadExistingSchedules();

// 3. Start HTTP server
startServer(port, host);

// 3a. Re-execute tasks that were interrupted by a previous daemon restart
for (const taskId of requeued) {
  taskExecutor.execute(taskId);
}

// 3a-ii. Autostart SSH tunnels for every persisted remote-server entry.
//
//   Fire-and-forget on purpose: we must NOT await. Each `manager.start()`
//   spawns ssh, runs the ready-gate probe (up to 10 s), and only resolves
//   once the tunnel is ready / errored out. If we awaited N of those in
//   sequence, /health would be unreachable for the full N × 10 s budget —
//   the bug that `daemon_sigterm_during_boot_autostart` prevents.
//
//   Errors from `start()` (port-alloc RangeError, buildSshArgs
//   ValidationError) are swallowed *per entry* so a single malformed rc
//   row cannot kill the rest of the fan-out. Non-throw failure modes
//   (ssh auth fail, ready-gate timeout) are reflected on the handle's
//   `status` / `errorCode` and surface via `GET /meta/remote-servers`.
void Promise.allSettled(
  getRemoteServers().map((server) =>
    Promise.resolve(tunnelManager.start(server)).catch((err) => {
      console.warn(
        `[tunnels] autostart failed for ${server.name} (${server.id}):`,
        err,
      );
    }),
  ),
);

// 3b. Catch up on skill/MCP drift from teammate pulls or prior crashes.
//     Async so the listener isn't blocked on reconciling N projects.
setImmediate(() => {
  try {
    reconcileAllProjects();
    reconcileAllMcp();
  } catch (err) {
    console.error("[startup] reconcile failed:", err);
  }
});

// 4. Signal parent process that we're ready (for daemon mode)
if (process.send) {
  process.send("ready");
}

// 5. Graceful shutdown — chat SSE handlers finish their save AFTER session.run()
// returns, so we must wait for chatExecutor to drain before exiting; otherwise
// an in-flight chat loses its assistant message AND the per-turn
// `claudeSessionId` update on every restart (incl. tsx watch and `make
// reinstall`). The 15 s budget mirrors `GRACEFUL_STOP_TIMEOUT_MS` in
// daemon.ts — keep the two in sync so `flockctl stop` never returns early.
let shuttingDown = false;
async function shutdown(reason: string = "signal") {
  if (shuttingDown) return; // idempotent — double SIGTERM etc.
  shuttingDown = true;
  console.log(`Shutting down Flockctl (${reason})...`);
  try {
    scheduler.stopAll();
    taskExecutor.cancelAll();
    chatExecutor.cancelAll();
    // Drain chat streams and tear down ssh tunnels in parallel — both are
    // IO-bound and have independent, bounded worst-case wall times (chat:
    // 15 s waitForIdle cap; tunnels: 3 s SIGTERM grace + 1 s SIGKILL grace
    // per child, all children stopped concurrently). Running them serially
    // would push total shutdown latency past the 15 s daemon-stop budget.
    await Promise.all([
      chatExecutor.waitForIdle(15_000),
      tunnelManager.shutdown().catch((err) => {
        console.error("[shutdown] tunnel shutdown failed:", err);
      }),
    ]);
    wsManager.closeAll();
  } catch (err) {
    console.error("[shutdown] error during drain:", err);
  }
  try {
    closeDb();
  } catch (err) {
    console.error("[shutdown] db close failed:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Crash handlers — log, drain, then exit non-zero. Without these the process
// dies silently on an uncaught rejection and the PID file is left stale.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});
