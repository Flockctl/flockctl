/**
 * Rate-limit scheduler — wakes up parked tasks and chats at their `resume_at`.
 *
 * Lifecycle:
 *   1. Task / chat executor catches an error, runs it through `classifyLimit`,
 *      gets back a `RateLimitInfo`. Persists `status='rate_limited' /
 *      resume_at=<ms>` on the row.
 *   2. Calls `rateLimitScheduler.schedule({ kind: 'task' | 'chat', id,
 *      resumeAtMs })`. The scheduler arms a `setTimeout` that fires the wake
 *      callback at the right time.
 *   3. On wake: invokes the registered handler for that kind. The handler
 *      decides what "resume" means (re-enqueue the task, spin up a fresh chat
 *      AgentSession, …). The scheduler does NOT touch the DB itself —
 *      separation of concerns means the executor still owns its row writes.
 *   4. On daemon restart: `rateLimitScheduler.recoverFromDatabase()` rehydrates
 *      timers from `tasks.status='rate_limited'` and `chats.status='rate_limited'`.
 *      Past-due rows fire (almost) immediately.
 *
 * Cancellation: `cancel({ kind, id })` clears any armed timer. Called by the
 * cancel route so a user-initiated DELETE during pause doesn't leave a stale
 * timer firing minutes later. Idempotent — calling cancel for an unknown id
 * is a no-op.
 *
 * Why setTimeout, not a cron tick: the resume cadence is per-row, not global,
 * and most rows clear in single-digit minutes. A node-cron poll would either
 * be too coarse (1-min resolution misses a 90-second `retry-after`) or too
 * chatty (per-second poll for an empty list). One timer per parked row is
 * cheaper and self-explanatory.
 *
 * Memory bound: the scheduler keeps O(parked rows) timers in memory. In
 * practice a single user's project rarely has more than a handful of
 * concurrently rate-limited rows; the partial index on resume_at keeps the
 * recovery query bounded too.
 */

import { getDb } from "../../db/index.js";
import { tasks, chats } from "../../db/schema.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { TaskStatus } from "../../lib/types.js";

export type RateLimitTargetKind = "task" | "chat";

export interface ScheduleArgs {
  kind: RateLimitTargetKind;
  id: number;
  resumeAtMs: number;
}

export type ResumeHandler = (id: number) => void | Promise<void>;

/** Minimum delay we'll arm — guards against a setTimeout(0) storm if many
 *  past-due rows recover at once. 50 ms is enough to yield to the event loop
 *  but cheap enough for users not to notice. */
const MIN_DELAY_MS = 50;
/** Hard cap on a single setTimeout. Anything beyond this gets re-armed in
 *  chunks so a malformed `resume_at` 100 years out doesn't overflow Node's
 *  internal int32 timer field (which silently fires immediately at wraparound).
 *  31 days is well under int32 ms (~24.8 days is the limit, so we cap at
 *  ~24 days to be safe — the scheduler will re-arm at wakeup). */
const MAX_TIMER_MS = 24 * 24 * 60 * 60 * 1000;

export class RateLimitScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private handlers: Partial<Record<RateLimitTargetKind, ResumeHandler>> = {};
  private inflightWakeups = new Set<string>();

  /**
   * Register the per-kind resume handler. Called once at boot by the executor
   * that owns the kind. Re-registration overwrites the previous handler —
   * useful for tests; not used by production code.
   */
  registerHandler(kind: RateLimitTargetKind, handler: ResumeHandler): void {
    this.handlers[kind] = handler;
  }

  /**
   * Arm a wake-up. If a timer already exists for this (kind, id), it is
   * cleared and replaced — newer schedule calls always win, so the executor
   * doesn't have to track previous arms when re-classifying a follow-up
   * limit error.
   */
  schedule(args: ScheduleArgs): void {
    const key = this.key(args.kind, args.id);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }

    const now = Date.now();
    let delay = Math.max(MIN_DELAY_MS, args.resumeAtMs - now);
    // Re-arm chain for absurd future timestamps.
    if (delay > MAX_TIMER_MS) {
      delay = MAX_TIMER_MS;
    }

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.fire(args);
    }, delay);
    // Don't keep the event loop alive solely for a parked task — daemon
    // shutdown should still be able to exit cleanly.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(key, timer);
  }

  /** Clear a previously-armed wake-up. No-op if none. */
  cancel(kind: RateLimitTargetKind, id: number): void {
    const key = this.key(kind, id);
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  /** Cancel every armed timer. Called on daemon shutdown. */
  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** True iff a timer is currently armed for this row. */
  isScheduled(kind: RateLimitTargetKind, id: number): boolean {
    return this.timers.has(this.key(kind, id));
  }

  /** Test seam — exposes the armed key set for assertions. */
  get scheduledKeys(): string[] {
    return Array.from(this.timers.keys()).sort();
  }

  /**
   * Boot-time recovery. Reads every row currently in `status='rate_limited'`
   * and arms a timer for each. Rows with NULL `resume_at` are repaired to
   * `now` — they should never exist in practice (the executor always writes
   * both columns together), but if they do we wake them right away rather
   * than leaving them parked forever.
   *
   * Returns the count of rows recovered, for the daemon's startup log.
   */
  recoverFromDatabase(): { tasks: number; chats: number } {
    const db = getDb();

    const taskRows = db
      .select({ id: tasks.id, resumeAt: tasks.resumeAt })
      .from(tasks)
      .where(and(eq(tasks.status, TaskStatus.RATE_LIMITED), isNotNull(tasks.resumeAt)))
      .all();

    let taskCount = 0;
    for (const row of taskRows) {
      this.schedule({
        kind: "task",
        id: row.id,
        resumeAtMs: row.resumeAt ?? Date.now(),
      });
      taskCount++;
    }

    const chatRows = db
      .select({ id: chats.id, resumeAt: chats.resumeAt })
      .from(chats)
      .where(and(eq(chats.status, "rate_limited"), isNotNull(chats.resumeAt)))
      .all();

    let chatCount = 0;
    for (const row of chatRows) {
      if (row.id === null) continue;
      this.schedule({
        kind: "chat",
        id: row.id,
        resumeAtMs: row.resumeAt ?? Date.now(),
      });
      chatCount++;
    }

    return { tasks: taskCount, chats: chatCount };
  }

  private async fire(args: ScheduleArgs): Promise<void> {
    const key = this.key(args.kind, args.id);
    if (this.inflightWakeups.has(key)) return; // racing with a re-schedule
    this.inflightWakeups.add(key);
    try {
      const handler = this.handlers[args.kind];
      if (!handler) {
        console.warn(
          `[rate-limit-scheduler] no handler registered for kind=${args.kind}; row ${args.id} stays parked`,
        );
        return;
      }
      await handler(args.id);
    } catch (err) {
      console.error(
        `[rate-limit-scheduler] handler for ${args.kind}#${args.id} threw:`,
        err,
      );
    } finally {
      this.inflightWakeups.delete(key);
    }
  }

  private key(kind: RateLimitTargetKind, id: number): string {
    return `${kind}:${id}`;
  }
}

/** Process-wide singleton, mirrors `taskExecutor` / `chatExecutor`. */
export const rateLimitScheduler = new RateLimitScheduler();
