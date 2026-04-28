// ─── Mission heartbeat scheduler ───
//
// Periodic "mission still alive" ping that fires once every 15 minutes for
// each ACTIVE mission. Pairs with the supervisor's heartbeat short-circuit
// (see `src/services/missions/supervisor.ts` §"Heartbeat short-circuit") —
// the trigger funnels through `guardedEvaluate` so kill-switch + depth
// gates fire, but skips the LLM round-trip and records a zero-cost
// `heartbeat` event on the mission timeline.
//
// Why a separate scheduler instead of piggy-backing on `taskTerminalEvents`:
// heartbeat is *not* a downstream-task observation — it's a wall-clock
// liveness ping. Routing it through the same event bus would force a
// synthetic "task" to exist for every mission, and it would couple the
// missions subscriber's coalescing semantics to a clock signal it has no
// business reasoning about.
//
// Lifecycle contract:
//   • boot                 — `registerHeartbeats()` reads every mission
//                            with `status='active'` and installs one cron
//                            handle per mission. Idempotent: a second
//                            register for the same mission is a no-op.
//   • mission active       — `registerHeartbeat(missionId)` installs a
//                            single cron handle keyed by mission id. The
//                            handler re-checks status on each tick and
//                            self-unregisters if the mission has since
//                            been paused / aborted / completed (rogue-tick
//                            prevention; see §"Rogue-tick prevention").
//   • pause / abort / complete / delete
//                          — caller invokes `unregisterHeartbeat(missionId)`
//                            so the handle stops firing and the in-memory
//                            map drops the entry. Caller is the route /
//                            service that flips mission.status; this
//                            module does NOT subscribe to a status-change
//                            event itself (no such bus today; would over-
//                            couple this module).
//   • daemon reboot        — boot path re-invokes `registerHeartbeats()`
//                            so an active mission whose handle was lost
//                            on the previous process exit reattaches a
//                            fresh cron at the next boot. Tested by
//                            `daemon_reboot_reregisters` (slice 11/04
//                            corner-case set).
//
// Cron expression — `*/15 * * * *` (every 15 minutes, on the quarter hour
// in UTC). The 15-minute cadence balances supervisor responsiveness against
// budget pressure: 96 ticks/day × N missions × ~0¢/tick (heartbeat is the
// LLM-free path) is comfortably free, but tighter than 5 minutes adds noise
// without observable benefit since the slowest task wall-time floor is
// ~1 minute.
//
// Rogue-tick prevention:
//   A cron handle that survived past `unregisterHeartbeat` (e.g. a tick
//   queued just before stop()) MUST NOT fire a heartbeat against a
//   non-active mission. The handler re-reads `missions.status` on every
//   tick and bails (and unregisters) if the mission is no longer active.
//   This makes the unregister path eventually-consistent: a tick that
//   races with a status flip is a no-op, not a stale heartbeat.

import cron from "node-cron";
import { getRawDb } from "../../db/index.js";

/** Cron expression for the heartbeat tick. Exported so tests can pin the
 *  literal without re-typing it. */
export const HEARTBEAT_CRON_EXPRESSION = "*/15 * * * *";

/**
 * Cron-like scheduler seam. The default impl wraps `node-cron` so the
 * production path is byte-identical to `SchedulerService.schedule`'s use
 * of `cron.schedule`. Tests inject a synchronous fake (`makeFakeScheduler`)
 * so we can drive ticks deterministically without waiting for wall-clock.
 */
export interface HeartbeatScheduler {
  schedule(expression: string, fn: () => void): { stop: () => void };
}

const defaultScheduler: HeartbeatScheduler = {
  schedule(expression, fn) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    const task = cron.schedule(expression, fn);
    return { stop: () => task.stop() };
  },
};

/**
 * Hook the per-tick callback invokes when the mission is still active.
 * The wiring layer in `server-entry.ts` plugs this into the production
 * `SupervisorService.evaluate(missionId, { kind: 'heartbeat' })` call;
 * tests pass an in-memory recorder so they can assert tick semantics
 * without spinning the supervisor stack.
 *
 * Errors thrown from `onHeartbeat` are LOGGED + SWALLOWED: a single LLM
 * blip (or even a programming error) MUST NOT kill the daemon's only
 * heartbeat dispatcher. The mission timeline is the durable source of
 * truth; the next tick will run with a fresh attempt against the same
 * mission state.
 */
export type HeartbeatCallback = (missionId: string) => void | Promise<void>;

/** DB-readers + scheduler exposed for tests. Production callers use the
 *  defaults (better-sqlite3 + node-cron). */
export interface HeartbeatDeps {
  scheduler?: HeartbeatScheduler;
  /** Look up the active-mission ids for boot-time re-registration. */
  readActiveMissionIds?: () => string[];
  /**
   * Look up a single mission's status. Returns `null` if the mission was
   * deleted; the handler treats that the same as "not active" — drop the
   * tick and unregister. */
  readMissionStatus?: (missionId: string) => string | null;
}

function defaultReadActiveMissionIds(): string[] {
  const sqlite = getRawDb();
  const rows = sqlite
    .prepare("SELECT id FROM missions WHERE status = 'active'")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function defaultReadMissionStatus(missionId: string): string | null {
  const sqlite = getRawDb();
  const row = sqlite
    .prepare("SELECT status FROM missions WHERE id = ?")
    .get(missionId) as { status: string } | undefined;
  return row ? row.status : null;
}

// ─── In-memory state ───
//
// Map of mission_id → cron handle. Module-level singleton because there's
// only one heartbeat dispatcher per process — multiple instances would
// double-fire ticks against the same mission and inflate the timeline.
const handles = new Map<string, { stop: () => void }>();

/** The HeartbeatCallback the registered ticks invoke. Re-set on every
 *  `registerHeartbeats(...)` so a daemon-restart (or test reset) can swap
 *  the dispatcher. */
let activeCallback: HeartbeatCallback = () => undefined;

/** The deps tuple captured at the most recent registration so per-mission
 *  registers can reuse the test-injected scheduler / status reader. */
let activeDeps: Required<HeartbeatDeps> = {
  scheduler: defaultScheduler,
  readActiveMissionIds: defaultReadActiveMissionIds,
  readMissionStatus: defaultReadMissionStatus,
};

// ─── Public API ───

/**
 * Register a heartbeat for ONE mission. Idempotent — a second call for the
 * same mission id is a no-op (the existing handle keeps firing). The
 * caller is responsible for invoking `unregisterHeartbeat` on
 * pause / abort / complete / delete.
 */
export function registerHeartbeat(missionId: string): void {
  if (handles.has(missionId)) return; // idempotent

  const handle = activeDeps.scheduler.schedule(HEARTBEAT_CRON_EXPRESSION, () => {
    // Rogue-tick prevention: a tick that fires AFTER unregister (e.g.
    // queued before stop() landed) sees the absent map entry and bails.
    if (!handles.has(missionId)) return;

    // Re-read live status — a paused / aborted / completed mission must
    // not record a heartbeat. The kill-switch in BudgetEnforcer would
    // also catch a non-active mission downstream, but bailing here saves
    // a useless call into the supervisor stack.
    let status: string | null;
    try {
      status = activeDeps.readMissionStatus(missionId);
    } catch (err) {
      console.warn(
        `[missions/heartbeat] readMissionStatus threw for ${missionId}:`,
        err,
      );
      return;
    }
    if (status !== "active") {
      // Self-unregister: the mission has moved on; don't keep the cron
      // alive against a target that will never accept a tick.
      unregisterHeartbeat(missionId);
      return;
    }

    try {
      const result = activeCallback(missionId);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          console.warn(
            `[missions/heartbeat] callback rejected for ${missionId}:`,
            err,
          );
        });
      }
    } catch (err) {
      console.warn(
        `[missions/heartbeat] callback threw for ${missionId}:`,
        err,
      );
    }
  });

  handles.set(missionId, handle);
}

/**
 * Unregister the heartbeat for ONE mission. Returns `true` if a handle was
 * removed, `false` if no handle existed (idempotent — pause/abort/delete
 * paths can call this without first checking). */
export function unregisterHeartbeat(missionId: string): boolean {
  const handle = handles.get(missionId);
  if (!handle) return false;
  try {
    handle.stop();
  } catch (err) {
    /* v8 ignore next 4 — defensive: node-cron's stop() does not throw in
       practice; the catch covers a future contract drift. */
    console.warn(
      `[missions/heartbeat] stop() threw for ${missionId}:`,
      err,
    );
  }
  handles.delete(missionId);
  return true;
}

/**
 * Unregister every heartbeat currently scheduled. Used by the daemon
 * shutdown path AND by tests between cases — callers MUST NOT rely on
 * this for runtime mission-state changes (use `unregisterHeartbeat`
 * scoped to one mission instead).
 */
export function unregisterAllHeartbeats(): void {
  for (const [, handle] of handles) {
    try {
      handle.stop();
    } catch (err) {
      /* v8 ignore next 3 — same defensive net as unregisterHeartbeat. */
      console.warn("[missions/heartbeat] stop() threw during teardown:", err);
    }
  }
  handles.clear();
}

/**
 * Boot-time entry point. Reads every active mission from the DB and
 * registers a heartbeat for each. Idempotent — missions whose handle is
 * already installed are skipped (so a tsx watch HMR reload doesn't
 * double-schedule).
 *
 * `callback` is the per-tick hook the production wiring uses to call
 * `SupervisorService.evaluate(missionId, { kind: 'heartbeat' })`. Tests
 * pass an in-memory recorder.
 *
 * Returns `{ registered, alreadyActive }` so the boot log line can
 * report exactly how many fresh handles were installed vs. how many
 * pre-existing handles were left in place.
 */
export function registerHeartbeats(
  callback: HeartbeatCallback,
  deps: HeartbeatDeps = {},
): { registered: string[]; alreadyActive: string[] } {
  activeCallback = callback;
  activeDeps = {
    scheduler: deps.scheduler ?? defaultScheduler,
    readActiveMissionIds: deps.readActiveMissionIds ?? defaultReadActiveMissionIds,
    readMissionStatus: deps.readMissionStatus ?? defaultReadMissionStatus,
  };

  const registered: string[] = [];
  const alreadyActive: string[] = [];
  let ids: string[];
  try {
    ids = activeDeps.readActiveMissionIds();
  } catch (err) {
    /* v8 ignore next 4 — defensive: the production reader is a single
       indexed SELECT against an in-process SQLite handle. */
    console.warn("[missions/heartbeat] readActiveMissionIds threw:", err);
    return { registered, alreadyActive };
  }

  for (const id of ids) {
    if (handles.has(id)) {
      alreadyActive.push(id);
      continue;
    }
    registerHeartbeat(id);
    registered.push(id);
  }
  return { registered, alreadyActive };
}

// ─── Test seams ───
//
// Exported ONLY so the unit tests can introspect handle state without
// poking at module internals via the runtime require cache. Production
// callers must NOT import these.

/** @internal — current set of mission ids with an installed heartbeat. */
export function __getHeartbeatMissionIds(): string[] {
  return Array.from(handles.keys());
}

/** @internal — drop in-memory state between test cases. Does NOT touch the
 *  DB; tests own their own DB lifecycle. */
export function __resetHeartbeats(): void {
  unregisterAllHeartbeats();
  activeCallback = () => undefined;
  activeDeps = {
    scheduler: defaultScheduler,
    readActiveMissionIds: defaultReadActiveMissionIds,
    readMissionStatus: defaultReadMissionStatus,
  };
}
