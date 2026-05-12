import { runMigrations } from "./db/migrate.js";
import { backfillConfigsFromDb } from "./db/config-backfill.js";
import { startServer } from "./server.js";
import { SchedulerService } from "./services/scheduler.js";
import { wsManager } from "./services/ws-manager.js";
import { taskExecutor } from "./services/task-executor/index.js";
import { chatExecutor, sweepOrphanedChatQuestions, sweepOrphanedRunningChats } from "./services/chat-executor.js";
import { rateLimitScheduler } from "./services/agents/rate-limit-scheduler.js";
import { seedDefaultKey } from "./services/ai/key-selection.js";
import { reconcilePlanStatuses, resumeStaleMilestones, cancelOrphanedExecutionTasks } from "./services/auto-executor.js";
import {
  registerHeartbeats,
  unregisterAllHeartbeats,
  type HeartbeatCallback,
} from "./services/missions/heartbeat.js";
import {
  startStalledDetector,
  stopStalledDetector,
} from "./services/missions/stalled-detector.js";
import { subscribeMissionEvents } from "./services/missions/event-subscriber.js";
import { reconcilePendingApproveEvents } from "./services/missions/approve-reconciler.js";
import { supervisorService } from "./services/missions/service.js";
import {
  startWakeupWorker,
  stopWakeupWorker,
} from "./services/wakeups/wakeup-worker.js";
import type { WakeupRow } from "./services/wakeups/wakeup-service.js";
import {
  DEFAULT_DAEMON_PORT,
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

const port = parseInt(argValue("--port") ?? String(DEFAULT_DAEMON_PORT), 10);
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

// 2c-questions. Sweep chat-bound `agent_questions` rows left in `pending`
// from a previous daemon instance. Chat AgentSessions don't persist
// (no cold-resume path), so any pending chat question on boot is orphaned —
// the question card in the UI would otherwise show forever and reject every
// answer attempt with "Agent question already resolved" 409. Tasks have a
// real cold-resume path so their pending rows are intentionally untouched.
{
  const cancelled = sweepOrphanedChatQuestions();
  if (cancelled > 0) {
    console.log(`[chat-questions] cancelled ${cancelled} orphaned pending question(s)`);
  }
}

// 2b-running-chats. Chats left with `status='running'` after a crashed
// daemon are orphans — the in-memory executor is gone but the row reads
// 'busy' forever, blocking new turns from the UI. Sweep them back to
// 'idle' so the operator can re-engage. Audit-round-7 finding.
{
  const reset = sweepOrphanedRunningChats();
  if (reset > 0) {
    console.log(`[chat-executor] reset ${reset} orphaned running chat(s) to idle`);
  }
}

// 2c-rate-limit. Re-arm wake-up timers for tasks/chats parked in
// `status='rate_limited'` from a prior daemon instance. The scheduler reads
// `resume_at` off the row and arms a setTimeout per parked entry; a row whose
// resume_at has already passed fires after the 50ms event-loop floor (see
// MIN_DELAY_MS in rate-limit-scheduler.ts). MUST run after taskExecutor and
// chatExecutor are imported (handlers register in their constructors) — the
// scheduler logs a warning and skips a row whose handler isn't registered yet.
{
  const rl = rateLimitScheduler.recoverFromDatabase();
  if (rl.tasks > 0 || rl.chats > 0) {
    console.log(
      `[rate-limit] re-armed ${rl.tasks} task(s) and ${rl.chats} chat(s) parked in rate_limited`,
    );
  }
}

// 2d. Resume auto-execution for milestones that were active before shutdown
resumeStaleMilestones();

// 3. Start background services
const scheduler = new SchedulerService();
scheduler.loadExistingSchedules();

// 3a-mission. Mission-tier liveness wiring. MUST run AFTER `SchedulerService`
//   has started (the heartbeat + stalled-detector use the same node-cron
//   tick infrastructure as scheduler.ts) AND BEFORE the synthetic
//   `taskTerminalEvents` emit from the stalled-detector — otherwise the
//   first synthetic stalled event would be a tree-falls-in-the-forest
//   (no listener attached yet).
//
//   Wiring order inside this block, top → bottom:
//     1. subscribeMissionEvents(supervisorService)
//          — attaches the listener that resolves task → mission and routes
//            `task_observed` triggers into the supervisor.
//     2. registerHeartbeats(heartbeatDispatch)
//          — installs the per-mission cron handles that fan `heartbeat`
//            triggers into the same supervisor instance every 15 minutes.
//     3. startStalledDetector()
//          — emits synthetic `taskTerminalEvents` for tasks that have been
//            running past the stalled threshold; lands on the listener
//            installed in step 1.
//
//   `heartbeatDispatch` calls `supervisorService.evaluate(missionId,
//   { kind: 'heartbeat' })`. The supervisor short-circuits heartbeat
//   triggers internally (no LLM round-trip, no spend — see
//   `supervisor.ts` §"Heartbeat short-circuit"), so a 15-minute tick is
//   bounded to one INSERT into `mission_events`. Errors from evaluate()
//   (DB closed, mission deleted between tick and read, etc.) are caught
//   inside `heartbeat.ts` itself — logged + swallowed so a single bad
//   tick can never kill the dispatcher for the rest of the missions.
const unsubscribeMissionEvents = subscribeMissionEvents(supervisorService);

// Boot-time durability reconciler: surface any `remediation_approved`
// events that were recorded but never confirmed (operator approved a
// proposal, daemon crashed between the event INSERT and the FS
// materialisation). One WS broadcast per row + a console.warn summary
// so the operator sees them immediately. Pure scan — does not mutate.
reconcilePendingApproveEvents();
const heartbeatDispatch: HeartbeatCallback = (missionId) =>
  supervisorService.evaluate(missionId, { kind: "heartbeat" }).then(
    () => undefined,
    // Defensive: heartbeat.ts already logs + swallows callback rejections,
    // but returning a resolved void here keeps the typed callback contract
    // (`void | Promise<void>`) free of an unhandled rejection in the rare
    // case the heartbeat dispatcher's outer try/catch is bypassed.
    (err: unknown) => {
      console.warn(
        `[missions/heartbeat] supervisor.evaluate rejected for ${missionId}:`,
        err,
      );
    },
  );
const { registered: registeredHeartbeats } = registerHeartbeats(heartbeatDispatch);
if (registeredHeartbeats.length > 0) {
  console.log(
    `[missions] heartbeat installed for ${registeredHeartbeats.length} active mission(s)`,
  );
}
startStalledDetector();

// 3a-wakeups. Scheduled-wakeups tick worker.
//
//   Fires every WAKEUP_TICK_INTERVAL_MS (10 s by default) and walks the
//   `scheduled_wakeups` partial-indexed pending set. The fire callback
//   below is the seam where the production resume integration plugs in
//   — for the current skeleton it logs and broadcasts but does NOT yet
//   spawn a `claude --resume` subprocess. That follow-up wiring lands
//   alongside the chat/task session-resume entrypoint; until then a
//   fired row appears in the UI inbox as "fired (no resume wired)" so
//   the operator sees that the timer fired even when the actual chat
//   resume is still a manual "claude --resume" away.
//
//   `onMissed` and `onFired` push WS broadcasts so the UI inbox swaps
//   the countdown chip for a "fired" / "missed" badge in real time
//   without polling. Per-row resolution (so we know chat_id/task_id at
//   broadcast time) flows through wsManager.broadcastWakeupStatus.
const wakeupFire = (row: WakeupRow): void => {
  /* v8 ignore start — production resume integration replaces this. */
  console.log(
    `[wakeups] tick fired row=${row.id} chat=${row.chatId} task=${row.taskId} ` +
      `claudeSession=${row.claudeSessionId} reason=${row.reason ?? "(none)"}`,
  );
  /* v8 ignore stop */
};
const wakeupOnMissed = (ids: string[]): void => {
  for (const id of ids) {
    // The service has already transitioned the row; we re-read the
    // row inline here rather than caching the post-update state in the
    // worker so the broadcast reflects the canonical row shape (the UI
    // refetches on click anyway).
    /* v8 ignore start — exercised when a daemon was down past grace. */
    import("./services/wakeups/wakeup-service.js").then(({ getById }) => {
      const row = getById(id);
      if (!row) return;
      wsManager.broadcastWakeupStatus({
        wakeup_id: row.id,
        chat_id: row.chatId,
        task_id: row.taskId,
        status: row.status,
        fire_at: row.fireAt,
        reason: row.reason,
      });
    }).catch(() => undefined);
    /* v8 ignore stop */
  }
};
const wakeupOnFired = (row: WakeupRow): void => {
  wsManager.broadcastWakeupStatus({
    wakeup_id: row.id,
    chat_id: row.chatId,
    task_id: row.taskId,
    status: row.status,
    fire_at: row.fireAt,
    reason: row.reason,
  });
};
startWakeupWorker(wakeupFire, { onMissed: wakeupOnMissed, onFired: wakeupOnFired });

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
    unregisterAllHeartbeats();
    unsubscribeMissionEvents();
    stopStalledDetector();
    stopWakeupWorker();
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
