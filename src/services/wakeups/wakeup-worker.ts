// ─── Wakeup tick worker ───
//
// Drives the wall-clock side of the scheduled-wakeups feature: every N
// seconds it sweeps the partial-indexed pending set, demotes anything
// overdue past the grace window to `missed`, and invokes a per-row
// fire callback for everything that's just become due.
//
// Why a separate module from `wakeup-service.ts`:
//   - The service exposes pure SQL transitions (record / list / fire /
//     cancel / sweep). It's safe to import from a route handler, a
//     hook ingest endpoint, or a test — all stateless.
//   - The worker owns process-level state: a single timer handle, a
//     guard against re-entrant ticks, and the wired-in callback. That
//     state belongs in exactly one place per process; co-locating it
//     with the service would invite tests to accidentally start a real
//     timer.
//   - This split mirrors `services/missions/heartbeat.ts` (cron seam
//     module) vs. `services/missions/supervisor.ts` (per-tick logic).
//
// Tick cadence — `WAKEUP_TICK_INTERVAL_SECONDS` (default 10s). Tighter
// than that adds little: the smallest sensible `delaySeconds` agents
// pass to `ScheduleWakeup` is on the order of 60s (the lower clamp in
// the tool itself), so a 10s tick gives ≤10s firing latency, which is
// well under the human-noticeable threshold the feature exists to fix.
// Looser than 30s would let a pile of due wakeups stack up between
// ticks and noticeably lag the chat resume.
//
// Re-entrancy guard: a tick that takes longer than the interval (e.g.
// the fire callback awaits a slow `claude --resume` spawn) MUST NOT
// start a second tick on top of itself — that would race the same
// `pending` row twice and the second `markFired` would silently no-op
// (status no longer pending), leaving the operator with "looks like one
// fire but I see two resume attempts in the chat". The `ticking` flag
// drops overlapping ticks and the next interval picks up where this one
// left off.

import { findDuePending, markFired, sweepMissed, type WakeupFireCallback, type WakeupRow } from "./wakeup-service.js";

/** Default tick interval in milliseconds. Exported so tests can pin the
 *  literal without re-typing it. */
export const WAKEUP_TICK_INTERVAL_MS = 10_000;

/** Seam over `setInterval` / `clearInterval` so tests can drive ticks
 *  on a fake clock without spinning real wall-clock time. */
export interface WakeupTimer {
  setInterval(fn: () => void, ms: number): { stop: () => void };
}

const defaultTimer: WakeupTimer = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    /* v8 ignore next 1 — Node typing: NodeJS.Timeout has .unref() */
    if (typeof (handle as NodeJS.Timeout).unref === "function") (handle as NodeJS.Timeout).unref();
    return { stop: () => clearInterval(handle) };
  },
};

/** Hook invoked whenever the worker decides "this row should be fired
 *  NOW". The caller (server-entry boot wiring) plugs the production
 *  resume integration in here; the default is a logged no-op so the
 *  daemon boots cleanly even before the resume integration lands. */
let activeFireCallback: WakeupFireCallback = (row: WakeupRow) => {
  /* v8 ignore start — exercised only on a daemon booted with the
     skeleton no-op callback (production wiring overrides this). */
  console.log(
    `[wakeups] would-fire row=${row.id} chat=${row.chatId} task=${row.taskId} ` +
      `claudeSession=${row.claudeSessionId} reason=${row.reason ?? "(none)"} ` +
      `— no resume callback wired; row will mark fired but no message will be sent`,
  );
  /* v8 ignore stop */
};

/** Optional hook for "I just transitioned rows to status=missed" — the
 *  WS-broadcast wiring layer plugs in here. Skeleton default is a
 *  no-op; the route layer subscribes via setOnMissedCallback during
 *  boot so UI chats get a yellow "Missed wake" badge in real time. */
let activeMissedCallback: (ids: string[]) => void = () => undefined;

/** Optional hook for "I just transitioned a row to status=fired" — same
 *  wiring shape as `onMissed`. Skeleton default is a no-op. */
let activeFiredCallback: (row: WakeupRow) => void = () => undefined;

let timerHandle: { stop: () => void } | null = null;
let ticking = false;

/**
 * Run one tick:
 *   1. Sweep any pending row past the grace window into `missed`.
 *      Done FIRST so a backlog after a downtime doesn't blast the
 *      callback with hours of stale wakeups — the operator sees them
 *      in the inbox and decides what to do.
 *   2. For every still-due-pending row, invoke `activeFireCallback`,
 *      then `markFired` on success. A throwing callback leaves the
 *      row pending so the next tick retries (transient blip safety).
 *
 * Re-entrant ticks (overlapping with a slow callback) are dropped via
 * the module-level `ticking` flag — see header comment.
 *
 * Exported (not just internal) so tests can drive a tick deterministically
 * without spinning the timer; the production timer also calls this. */
export async function runWakeupTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const missedIds = sweepMissed();
    if (missedIds.length > 0) {
      try {
        activeMissedCallback(missedIds);
      } catch (err) {
        /* v8 ignore next 4 — defensive: the broadcast hook is a thin
           WS write and is not expected to throw in production. */
        console.warn("[wakeups] onMissed callback threw:", err);
      }
    }

    const due = findDuePending();
    for (const row of due) {
      try {
        const result = activeFireCallback(row);
        if (result && typeof (result as Promise<void>).then === "function") {
          await (result as Promise<void>);
        }
      } catch (err) {
        // Leave row in `pending` — next tick will retry. We deliberately
        // do NOT exponential-backoff or move-to-dead-letter at this
        // skeleton stage; the row will keep matching `findDuePending`
        // and a chronically failing callback will be visible in logs.
        console.warn(`[wakeups] fire callback threw for ${row.id}:`, err);
        continue;
      }
      const fired = markFired(row.id);
      if (fired) {
        try {
          activeFiredCallback(fired);
        } catch (err) {
          /* v8 ignore next 4 — defensive: same WS-broadcast shape
             as onMissed. */
          console.warn("[wakeups] onFired callback threw:", err);
        }
      }
    }
  } finally {
    ticking = false;
  }
}

/** Boot-time entry. Idempotent — a second call replaces the callback
 *  but does NOT spin up a second timer (that would double-fire every
 *  pending row). Returns `false` if a timer was already running so the
 *  boot log can record "callback re-bound, timer reused". */
export function startWakeupWorker(
  fireCallback: WakeupFireCallback,
  opts: {
    timer?: WakeupTimer;
    intervalMs?: number;
    onMissed?: (ids: string[]) => void;
    onFired?: (row: WakeupRow) => void;
  } = {},
): boolean {
  activeFireCallback = fireCallback;
  if (opts.onMissed) activeMissedCallback = opts.onMissed;
  if (opts.onFired) activeFiredCallback = opts.onFired;

  if (timerHandle) return false; // timer already running, callback rebound

  const timer = opts.timer ?? defaultTimer;
  const intervalMs = opts.intervalMs ?? WAKEUP_TICK_INTERVAL_MS;
  timerHandle = timer.setInterval(() => {
    void runWakeupTick();
  }, intervalMs);
  return true;
}

/** Stop the timer (no-op if not running). Used by daemon shutdown and
 *  by tests between cases. Does NOT touch DB state — pending rows stay
 *  pending across a stop/start cycle, which is exactly what we want for
 *  the daemon-restart-mid-flight case. */
export function stopWakeupWorker(): void {
  if (!timerHandle) return;
  try {
    timerHandle.stop();
  } catch (err) {
    /* v8 ignore next 3 — defensive: clearInterval doesn't throw. */
    console.warn("[wakeups] timer.stop() threw:", err);
  }
  timerHandle = null;
}

// ─── Test seams ───
// Exported ONLY so unit tests can introspect / reset module state without
// poking at the require cache.

/** @internal — true if the timer is currently running. */
export function __isWakeupWorkerRunning(): boolean {
  return timerHandle !== null;
}

/** @internal — drop in-memory state between test cases. */
export function __resetWakeupWorker(): void {
  stopWakeupWorker();
  ticking = false;
  activeFireCallback = (row: WakeupRow) => {
    /* v8 ignore next 1 — replaced in production wiring. */
    void row;
  };
  activeMissedCallback = () => undefined;
  activeFiredCallback = () => undefined;
}
