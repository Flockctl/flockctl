// ─── Stalled-task detector ───
//
// A `*/5 * * * *` cron that flags any task that's been `running` for more
// than `STALL_WALL_TIME_MS` AND has produced no `task_logs` row for more
// than `STALL_IDLE_MS`. Each match emits a synthetic
// `taskTerminalEvents.emit(...)` with `status='stalled'` so the existing
// missions-event subscriber (see `event-subscriber.ts`) routes it to the
// supervisor as a `task_observed` trigger with the same machinery it
// already uses for real terminals.
//
// Why two thresholds (wall-time + idle)?
//   * Wall-time alone is too coarse — a task running a 14-minute build
//     that's actively streaming logs is healthy, not stalled.
//   * Idle alone is too aggressive — a fresh task whose first log line is
//     5 minutes away (e.g. waiting on a downstream DNS) shouldn't be
//     reported as stalled before it gets a chance to start.
//   The intersection captures the actual failure mode: "task started long
//   ago AND nothing has happened recently".
//
// Why the existing `taskTerminalEvents` channel instead of a new bus?
//   Routing through `taskTerminalEvents` reuses the missions subscriber's
//   coalescing, orphan filtering, and per-mission queue without inventing
//   a parallel pipeline. The synthetic status is `'stalled'`, distinct
//   from any real `tasks.status` value (the column is never written with
//   that string), so consumers that branch on status can detect the
//   stalled signal without ambiguity.
//
// What this file does NOT do:
//   * It does NOT mutate `tasks.status`. Stalled is an OBSERVATION, not a
//     state transition. The task-executor remains the only writer of the
//     real status column. A subsequent supervisor remediation may cancel
//     or re-prompt the task, which DOES write the column — through the
//     existing executor path, never from here.
//   * It does NOT walk the plan store. Mission resolution belongs to the
//     event subscriber; this module only fires the event.
//   * It does NOT throw on a single-row read failure. A corrupt timestamp
//     in one row must not prevent the rest of the scan from finishing.

import cron from "node-cron";
import { getRawDb } from "../../db/index.js";
import {
  taskTerminalEvents,
  STALLED_SYNTHETIC_STATUS,
} from "../auto-executor.js";
import { TaskStatus } from "../../lib/types.js";

/** Cron expression for the detector tick. */
export const STALLED_DETECTOR_CRON_EXPRESSION = "*/5 * * * *";

/** A task is a stall candidate after this many ms of wall-time. */
export const STALL_WALL_TIME_MS = 15 * 60 * 1000;

/** A stall candidate fires only if it's been idle (no log row) this long. */
export const STALL_IDLE_MS = 5 * 60 * 1000;

interface StalledRow {
  id: number;
  startedAt: string | null;
  lastLogTs: string | null;
}

/**
 * Cron-like seam — same shape as the heartbeat scheduler's. Production
 * default wraps `node-cron`; tests inject a synchronous `tick()`-able
 * fake so the detector can be driven without wall-clock waits.
 */
export interface StalledDetectorScheduler {
  schedule(expression: string, fn: () => void): { stop: () => void };
}

const defaultScheduler: StalledDetectorScheduler = {
  schedule(expression, fn) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    const task = cron.schedule(expression, fn);
    return { stop: () => task.stop() };
  },
};

/** Optional injection points for tests / fault injection. */
export interface StalledDetectorDeps {
  scheduler?: StalledDetectorScheduler;
  /** Override now() so tests can pin the wall-clock without a fake timer. */
  now?: () => number;
  /** Override the DB scan so tests can drive the detector against an
   *  in-memory list without seeding the full schema. */
  scanStalledTasks?: (now: number) => StalledRow[];
  /** Override the emit so tests can assert without listening on the
   *  module-global event emitter. Defaults to `taskTerminalEvents.emit`. */
  emit?: (taskId: number) => void;
}

/**
 * Default DB scan: select every running task whose `started_at` is older
 * than the wall-time floor AND whose most recent task_logs row (if any)
 * is older than the idle floor. We INNER/LEFT join in a single query so
 * the detector hits the DB exactly once per tick — N+1 here would scale
 * with the running-task fleet.
 *
 * The query uses julianday() arithmetic in seconds because both
 * `tasks.started_at` and `task_logs.timestamp` are TEXT defaults of
 * `datetime('now')` (UTC). Comparing the diff against
 * `STALL_*_MS / 1000` keeps us in seconds throughout.
 */
function defaultScanStalledTasks(now: number): StalledRow[] {
  const sqlite = getRawDb();
  const wallSec = Math.floor(STALL_WALL_TIME_MS / 1000);
  const idleSec = Math.floor(STALL_IDLE_MS / 1000);
  // ISO-8601 string in UTC for `now`; SQLite's datetime() compares
  // string-wise correctly for ISO-8601 zulu timestamps.
  const nowIso = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  // Subquery picks the most recent log timestamp per task (NULL if no
  // logs ever streamed). Outer predicate enforces the wall-time floor on
  // started_at and the idle floor on COALESCE(lastLog, started_at) — a
  // task with no logs at all is "idle since started_at".
  const rows = sqlite
    .prepare(
      `
      SELECT
        t.id        AS id,
        t.started_at AS startedAt,
        (SELECT MAX(timestamp) FROM task_logs l WHERE l.task_id = t.id) AS lastLogTs
      FROM tasks t
      WHERE t.status = ?
        AND t.started_at IS NOT NULL
        AND (julianday(?) - julianday(t.started_at)) * 86400 > ?
        AND (
          julianday(?) - julianday(
            COALESCE(
              (SELECT MAX(timestamp) FROM task_logs l WHERE l.task_id = t.id),
              t.started_at
            )
          )
        ) * 86400 > ?
      `,
    )
    .all(
      TaskStatus.RUNNING,
      nowIso,
      wallSec,
      nowIso,
      idleSec,
    ) as StalledRow[];
  return rows;
}

// ─── In-memory state ───
//
// Module-level handle so `stopStalledDetector()` can teardown the cron at
// shutdown without the caller threading the handle around. There is at
// most ONE detector per process — a second `startStalledDetector` call
// without a stop() in between is treated as a no-op (returns the
// existing handle's stop fn) so HMR / test reset can't double-fire.
let activeHandle: { stop: () => void } | null = null;

/**
 * Already-fired set: a synthetic `stalled` event for a given task is
 * emitted AT MOST ONCE per detector lifetime. Without this, a task that
 * stays running + idle across multiple ticks would attract a fresh event
 * every 5 minutes, flooding the missions timeline. The set is reset on
 * `stopStalledDetector()` so a daemon-restart re-arms detection.
 */
const firedTaskIds = new Set<number>();

// ─── Public API ───

/**
 * Start the detector. Returns a `{ stop }` handle the caller can hold
 * onto — same shape as the heartbeat scheduler — but production callers
 * usually rely on the module-level `stopStalledDetector()` instead.
 *
 * Idempotent: a second call without a stop in between returns the
 * existing handle and does NOT install a second cron.
 */
export function startStalledDetector(
  deps: StalledDetectorDeps = {},
): { stop: () => void } {
  if (activeHandle) return activeHandle;

  const scheduler = deps.scheduler ?? defaultScheduler;
  const now = deps.now ?? (() => Date.now());
  const scan = deps.scanStalledTasks ?? defaultScanStalledTasks;
  const emit =
    deps.emit ??
    ((taskId: number) =>
      taskTerminalEvents.emit({
        taskId,
        status: STALLED_SYNTHETIC_STATUS,
      }));

  const handle = scheduler.schedule(STALLED_DETECTOR_CRON_EXPRESSION, () => {
    let rows: StalledRow[];
    try {
      rows = scan(now());
    } catch (err) {
      /* v8 ignore next 4 — defensive: a hard SQL failure here would also
         break unrelated boot paths; we'd hear about it from a louder
         path. */
      console.warn("[missions/stalled-detector] scan threw:", err);
      return;
    }

    for (const row of rows) {
      // De-dupe across ticks: a task that stays stuck still only fires
      // ONCE — the supervisor's first remediation either cancels the
      // task (real terminal arrives, missions subscriber routes it) or
      // restarts it (fresh `started_at` → no longer matches the scan).
      if (firedTaskIds.has(row.id)) continue;
      firedTaskIds.add(row.id);
      try {
        emit(row.id);
      } catch (err) {
        /* v8 ignore next 4 — defensive: TypedEventEmitter.emit doesn't
           throw in practice; a listener throw would have been caught
           inside emit by the emitter's own swallow path. */
        console.warn(
          `[missions/stalled-detector] emit threw for task ${row.id}:`,
          err,
        );
      }
    }
  });

  activeHandle = handle;
  return handle;
}

/**
 * Stop the detector. Drops the cron handle and the de-dupe set so a
 * subsequent `startStalledDetector` call after this is a fresh start.
 * Idempotent — a second stop() without a fresh start is a no-op.
 */
export function stopStalledDetector(): boolean {
  if (!activeHandle) return false;
  try {
    activeHandle.stop();
  } catch (err) {
    /* v8 ignore next 3 — defensive; node-cron's stop() does not throw. */
    console.warn("[missions/stalled-detector] stop() threw:", err);
  }
  activeHandle = null;
  firedTaskIds.clear();
  return true;
}

// ─── Test seams ───

/** @internal — tests inspect / reset the de-dupe set between cases. */
export function __getFiredTaskIds(): number[] {
  return Array.from(firedTaskIds);
}

/** @internal — drops in-memory state without touching the cron handle. */
export function __resetStalledDetector(): void {
  stopStalledDetector();
  firedTaskIds.clear();
}
