import { runMigrations } from "./db/migrate.js";
import { backfillConfigsFromDb } from "./db/config-backfill.js";
import { startServer } from "./server.js";
import { SchedulerService } from "./services/scheduler.js";
import { wsManager } from "./services/ws-manager.js";
import { taskExecutor } from "./services/task-executor.js";
import { chatExecutor } from "./services/chat-executor.js";
import { seedDefaultKey } from "./services/key-selection.js";
import { reconcilePlanStatuses, resumeStaleMilestones } from "./services/auto-executor.js";
import {
  seedBundledSkills,
  checkRcPermissions,
  hasRemoteAuth,
} from "./config.js";
import { cleanupClaudeCodePlugin } from "./services/plugin-cleanup.js";
import { reconcileAllProjects } from "./services/claude-skills-sync.js";
import { reconcileAllMcp } from "./services/claude-mcp-sync.js";
import { reconcileAllAgents } from "./services/claude-agents-sync.js";
import { evaluateBindSecurity } from "./lib/security-gate.js";

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

// 1. Copy config fields from DB to .flockctl/config.json (JSON wins on
//    conflict). MUST run BEFORE migrations drop the old columns.
backfillConfigsFromDb();

// 2. Run migrations (may drop columns backfilled above)
runMigrations();

// 2. Seed default key if none exist
seedDefaultKey();

// 2d. Seed bundled skills to ~/flockctl/skills/
seedBundledSkills();

// 2d-i. Remove legacy Claude Code plugin artifacts (reconciler is now the
//       single delivery mechanism). Idempotent — cheap to run every boot.
cleanupClaudeCodePlugin();

// 2e. Warn if .flockctlrc permissions are insecure when remote auth is active
if (hasRemoteAuth()) {
  const perms = checkRcPermissions();
  if (!perms.secure) {
    console.warn(`[SECURITY WARNING] ${perms.message}`);
  }
}

// 2a. Re-queue stale tasks left running by previous daemon instance
const requeued = taskExecutor.resetStaleTasks();

// 2b. Reconcile plan task statuses with completed execution tasks
reconcilePlanStatuses();

// 2c. Resume auto-execution for milestones that were active before shutdown
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

// 3b. Catch up on skill/MCP drift from teammate pulls or prior crashes.
//     Async so the listener isn't blocked on reconciling N projects.
setImmediate(() => {
  try {
    reconcileAllProjects();
    reconcileAllMcp();
    reconcileAllAgents();
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
// an in-flight chat loses its assistant message on every restart (incl. tsx watch).
async function shutdown() {
  console.log("Shutting down Flockctl...");
  scheduler.stopAll();
  taskExecutor.cancelAll();
  chatExecutor.cancelAll();
  await chatExecutor.waitForIdle(5000);
  wsManager.closeAll();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
