// ─── Wakeup service ───
//
// Persists "agent asked to be resumed at T" intent and exposes the CRUD
// surface (record / list / cancel / fire / mark-missed) that the route
// layer, the tick worker, and the UI inbox all share.
//
// Why a service module rather than ad-hoc queries in the route file:
//   - The tick worker (wakeup-worker.ts), the hook-ingest endpoint, AND
//     the UI inbox routes all need to read or transition the same set of
//     rows. Centralising the SQL here keeps the status machine in one
//     place — adding a new state ("snoozed", say) or a new index touches
//     this file alone.
//   - Tests (slice 03) want a deterministic seam to drive `tick()`
//     against a fake clock. Encapsulating "find due pending rows" behind
//     a method makes that injection trivial.
//
// The service does NOT itself own the timer — the worker (sibling
// module) drives the cron tick. This split mirrors the missions
// heartbeat split (`heartbeat.ts` schedules; the supervisor service
// owns the per-tick semantics).

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getRawDb } from "../../db/index.js";

// Per-handle prepared-statement cache. Every helper below previously called
// `sqlite.prepare(...)` inline, which makes better-sqlite3 reparse + replan
// the SQL on every call. `findDuePending` runs on every worker tick and
// `getById` runs on every API hit — adding a WeakMap-keyed cache mirrors the
// pattern proven in `services/missions/supervisor.ts:69`, `event-subscriber.ts`,
// `guarded-evaluate.ts`, and `budget-enforcer.ts`.
//
// The WeakMap is keyed on the Database handle so tests that swap the DB
// (`getRawDb()` resolves to a fresh instance per test) get a fresh cache
// without leaking statements across tests.
interface WakeupStmts {
  insert: Database.Statement;
  getById: Database.Statement;
  findDuePending: Database.Statement;
  markFired: Database.Statement;
  cancel: Database.Statement;
  markMissed: Database.Statement;
  sweepSelect: Database.Statement;
  sweepUpdate: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, WakeupStmts>();

function getStmts(sqlite: Database.Database): WakeupStmts {
  let cached = stmtCache.get(sqlite);
  if (cached) return cached;
  cached = {
    insert: sqlite.prepare(
      `INSERT INTO scheduled_wakeups
         (id, chat_id, task_id, claude_session_id, fire_at, prompt, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ),
    getById: sqlite.prepare(`SELECT * FROM scheduled_wakeups WHERE id = ?`),
    findDuePending: sqlite.prepare(
      `SELECT * FROM scheduled_wakeups
        WHERE status = 'pending' AND fire_at <= ?
        ORDER BY fire_at ASC`,
    ),
    markFired: sqlite.prepare(
      `UPDATE scheduled_wakeups
          SET status = 'fired', fired_at = ?
        WHERE id = ? AND status = 'pending'`,
    ),
    cancel: sqlite.prepare(
      `UPDATE scheduled_wakeups
          SET status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND status = 'pending'`,
    ),
    markMissed: sqlite.prepare(
      `UPDATE scheduled_wakeups
          SET status = 'missed', missed_at = ?
        WHERE id = ? AND status = 'pending'`,
    ),
    sweepSelect: sqlite.prepare(
      `SELECT id FROM scheduled_wakeups
        WHERE status = 'pending' AND fire_at < ?`,
    ),
    sweepUpdate: sqlite.prepare(
      `UPDATE scheduled_wakeups
          SET status = 'missed', missed_at = ?
        WHERE id = ? AND status = 'pending'`,
    ),
  };
  stmtCache.set(sqlite, cached);
  return cached;
}

/** Status enum mirror of the DB CHECK in 0047_scheduled_wakeups.sql. */
export type WakeupStatus = "pending" | "fired" | "cancelled" | "missed";

/** A row as it lives in `scheduled_wakeups`. Times are unix-epoch SECONDS
 *  (matching the migration's `unixepoch()` default). */
export interface WakeupRow {
  id: string;
  chatId: number | null;
  taskId: number | null;
  claudeSessionId: string;
  fireAt: number;
  prompt: string;
  reason: string | null;
  status: WakeupStatus;
  firedAt: number | null;
  missedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
}

/** Input for `record()` — service asserts exactly-one of chatId/taskId. */
export interface RecordWakeupInput {
  chatId?: number | null;
  taskId?: number | null;
  claudeSessionId: string;
  /** Seconds-from-now until the wakeup should fire. Service computes
   *  fireAt = now() + delaySeconds so the caller doesn't have to think
   *  about clock skew between the hook host and the daemon host (here
   *  they're the same process, so it's a no-op — but keeps the API the
   *  same shape as `ScheduleWakeup` itself). */
  delaySeconds: number;
  prompt: string;
  reason?: string | null;
}

/** Number of seconds past `fire_at` the worker still treats a row as
 *  "go ahead and fire late, the operator's monitoring is the safety net"
 *  before flipping it to `missed`. Tuned conservatively: a 60s grace
 *  absorbs OS sleep / GC pause / sluggish event loop on the daemon, but
 *  is well under the human-noticeable "did the agent forget about me?"
 *  threshold the feature exists to fix. */
export const WAKEUP_FIRE_GRACE_SECONDS = 60;

/** Worker-tick callback — invoked once per due-pending row. Returning
 *  cleanly marks the row `fired`; throwing leaves it `pending` so the
 *  next tick retries (a transient transport blip mustn't lose a wakeup).
 *
 *  The production wiring layer plugs this seam into the actual
 *  session-resume path (typically `claude --resume <sessionId> --print
 *  <prompt>` for a chat). The skeleton ships a no-op default so the
 *  daemon boots cleanly even before the resume integration lands. */
export type WakeupFireCallback = (row: WakeupRow) => void | Promise<void>;

interface WakeupRawRow {
  id: string;
  chat_id: number | null;
  task_id: number | null;
  claude_session_id: string;
  fire_at: number;
  prompt: string;
  reason: string | null;
  status: WakeupStatus;
  fired_at: number | null;
  missed_at: number | null;
  cancelled_at: number | null;
  created_at: number;
}

function mapRow(r: WakeupRawRow): WakeupRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    taskId: r.task_id,
    claudeSessionId: r.claude_session_id,
    fireAt: r.fire_at,
    prompt: r.prompt,
    reason: r.reason,
    status: r.status,
    firedAt: r.fired_at,
    missedAt: r.missed_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Insert a new pending wakeup. Asserts exactly-one of chatId/taskId so a
 * row scoped to "both" or "neither" cannot be persisted (the DB CHECK
 * only covers "neither" — at-least-one — so the service layer enforces
 * the upper bound).
 */
export function record(input: RecordWakeupInput): WakeupRow {
  const chatId = input.chatId ?? null;
  const taskId = input.taskId ?? null;

  if (chatId === null && taskId === null) {
    throw new Error("scheduled_wakeups: must scope to chatId OR taskId");
  }
  if (chatId !== null && taskId !== null) {
    throw new Error("scheduled_wakeups: must scope to chatId XOR taskId, not both");
  }
  if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 0) {
    throw new Error("scheduled_wakeups: delaySeconds must be a non-negative finite number");
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new Error("scheduled_wakeups: prompt is required");
  }
  if (typeof input.claudeSessionId !== "string" || input.claudeSessionId.length === 0) {
    throw new Error("scheduled_wakeups: claudeSessionId is required");
  }

  const id = randomUUID();
  const fireAt = nowSeconds() + Math.floor(input.delaySeconds);

  const sqlite = getRawDb();
  getStmts(sqlite).insert.run(
    id,
    chatId,
    taskId,
    input.claudeSessionId,
    fireAt,
    input.prompt,
    input.reason ?? null,
  );

  return getById(id)!;
}

export function getById(id: string): WakeupRow | null {
  const sqlite = getRawDb();
  const row = getStmts(sqlite).getById.get(id) as WakeupRawRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * List wakeups, newest-first. Filters are AND-composed; pass `status` to
 * scope to a particular state (the UI inbox uses `status='pending'` for
 * the live countdown view, `status='missed'` for the recovery view).
 */
export function list(filter: {
  chatId?: number;
  taskId?: number;
  status?: WakeupStatus;
  limit?: number;
} = {}): WakeupRow[] {
  const conds: string[] = [];
  const args: Array<number | string> = [];
  if (typeof filter.chatId === "number") {
    conds.push("chat_id = ?");
    args.push(filter.chatId);
  }
  if (typeof filter.taskId === "number") {
    conds.push("task_id = ?");
    args.push(filter.taskId);
  }
  if (filter.status) {
    conds.push("status = ?");
    args.push(filter.status);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);

  // `list` is the only helper whose SQL shape depends on caller filters; the
  // statement cache above can't memoize it across all variants, so we keep
  // the inline prepare. With at most 8 shape variants (chatId/taskId/status
  // ON/OFF), better-sqlite3's per-string statement memo is sufficient.
  const sqlite = getRawDb();
  const rows = sqlite
    .prepare(`SELECT * FROM scheduled_wakeups ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit) as WakeupRawRow[];
  return rows.map(mapRow);
}

/**
 * Find every pending row whose `fire_at <= asOfSeconds` — the worker hot
 * path. Bounded by the partial index `idx_scheduled_wakeups_pending` so
 * the scan size is "outstanding-due-pending", not table-size. Ordered
 * ASC by fire_at so the worker fires oldest-first and a backlog after a
 * downtime drains in chronological order.
 */
export function findDuePending(asOfSeconds: number = nowSeconds()): WakeupRow[] {
  const sqlite = getRawDb();
  const rows = getStmts(sqlite).findDuePending.all(asOfSeconds) as WakeupRawRow[];
  return rows.map(mapRow);
}

/**
 * Mark a pending row as fired. Idempotent: a no-op for any row not
 * currently in `pending` so a double-tick (rogue scheduler, parallel
 * fire-now click) cannot double-emit. Returns the new row state.
 */
export function markFired(id: string, firedAt: number = nowSeconds()): WakeupRow | null {
  const sqlite = getRawDb();
  getStmts(sqlite).markFired.run(firedAt, id);
  return getById(id);
}

/**
 * Cancel a pending row. Idempotent on non-pending status (no-op). The
 * UI "✕" button and the chat-deletion cleanup both flow through here.
 */
export function cancel(id: string, cancelledAt: number = nowSeconds()): WakeupRow | null {
  const sqlite = getRawDb();
  getStmts(sqlite).cancel.run(cancelledAt, id);
  return getById(id);
}

/**
 * Mark a pending row as missed because the daemon was down past its
 * fire_at + grace window. Visible in the UI as a yellow "Missed wake"
 * badge with a "Resume now" / "Dismiss" affordance — the row is NOT
 * auto-fired here so the operator stays in control of "what to do with
 * a chat that slept past its alarm".
 */
export function markMissed(id: string, missedAt: number = nowSeconds()): WakeupRow | null {
  const sqlite = getRawDb();
  getStmts(sqlite).markMissed.run(missedAt, id);
  return getById(id);
}

/**
 * Sweep every pending row whose `fire_at + WAKEUP_FIRE_GRACE_SECONDS <
 * now()` and flip them to `missed`. Called by the worker on each tick
 * BEFORE invoking the fire callback so a backlog of overdue rows
 * doesn't all get blast-fired late — anything past the grace window is
 * recovered manually by the operator instead.
 *
 * Returns the ids that transitioned so the caller can broadcast a
 * batched WS event without re-querying.
 */
export function sweepMissed(
  asOfSeconds: number = nowSeconds(),
  graceSeconds: number = WAKEUP_FIRE_GRACE_SECONDS,
): string[] {
  const sqlite = getRawDb();
  const stmts = getStmts(sqlite);
  const cutoff = asOfSeconds - graceSeconds;
  const rows = stmts.sweepSelect.all(cutoff) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const update = stmts.sweepUpdate;
  const tx = sqlite.transaction((ids: string[]) => {
    for (const id of ids) update.run(asOfSeconds, id);
  });
  const ids = rows.map((r) => r.id);
  tx(ids);
  return ids;
}
