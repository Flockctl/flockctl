// ─── Mission approve durability reconciler ───
//
// The `/missions/:id/proposals/:pid/approve` route writes the
// `remediation_approved` event FIRST, then materialises the plan-store
// entity, then UPDATES the event payload with the final target_id (see
// audit-round-3 finding). The window between event INSERT and entity
// materialisation is small (the FS write is synchronous), but a daemon
// crash inside it leaves the event flagged `{ pending: true }` with no
// matching entity on disk.
//
// This reconciler runs ONCE at boot. It scans every `remediation_approved`
// event whose payload still has `pending === true` (the only state that
// could ever leak — a successful approve clears the flag in the UPDATE)
// and emits a `mission_event_pending_approve` WS broadcast so the UI
// can surface a "needs reconciliation" banner / operator action.
//
// Why we don't auto-retry the materialisation:
//   - createMilestone/createSlice/createPlanTask all use slug-dedup
//     (`dedupeSlug`), so a retry could create a `slug-2` duplicate if
//     the prior attempt had partially completed.
//   - Operator visibility is the safer default. The banner lets the
//     operator decide: "delete the event" (rolls back the approval),
//     "re-approve through the API" (regenerates a clean entity), or
//     "find the existing entity and edit it" (resume manual flow).
//
// The reconciler is idempotent: re-running it produces the same set of
// pending events. No DB writes happen inside; only one WS broadcast per
// pending row.

import { getRawDb } from "../../db/index.js";
import { wsManager } from "../ws-manager.js";

interface PendingApproveRow {
  id: string;
  mission_id: string;
  payload: string;
  created_at: number;
}

/**
 * Scan `mission_events` for `remediation_approved` rows whose payload
 * still carries `pending: true`. Returns the array of rows so callers
 * (boot path, tests) can inspect what was found. Does NOT mutate or
 * delete the rows — operator decides next steps.
 */
export function scanPendingApproveEvents(): PendingApproveRow[] {
  const sqlite = getRawDb();
  // `json_extract` returns 1 when the boolean is truthy, NULL otherwise.
  // The combination of an indexed scan on `(kind)` (covered by the
  // existing `idx_mission_events_mission_created` compound when the
  // planner sees the equality predicate first) plus a JSON path filter
  // is fine for the typical "<10 pending across daemon lifetime"
  // payload size — this is a boot-time cold path.
  const rows = sqlite
    .prepare(
      `SELECT id, mission_id, payload, created_at
         FROM mission_events
        WHERE kind = 'remediation_approved'
          AND json_extract(payload, '$.pending') = 1`,
    )
    .all() as PendingApproveRow[];
  return rows;
}

/**
 * Run the reconciler. Called once from `server-entry.ts` at boot, AFTER
 * the DB has been opened. Surfaces every pending approve to the UI via
 * one WS broadcast per row plus a single console.warn summary line so
 * operators tailing the daemon log see the count immediately.
 */
export function reconcilePendingApproveEvents(): void {
  let pending: PendingApproveRow[];
  try {
    pending = scanPendingApproveEvents();
  } catch (err) {
    // The DB might be in an unexpected state (mid-migration, schema
    // drift); log + swallow so we don't crash the boot path.
    console.error(
      "[missions/approve-reconciler] scan failed:",
      err,
    );
    return;
  }

  if (pending.length === 0) return;

  console.warn(
    `[missions/approve-reconciler] found ${pending.length} pending ` +
      `approve event(s) without a confirmed entity — operator action required`,
  );

  for (const row of pending) {
    try {
      wsManager.broadcastAll({
        type: "mission_event_pending_approve",
        missionId: row.mission_id,
        eventId: row.id,
        createdAt: row.created_at,
      });
    } catch {
      // Defensive: WS manager throwing during boot must not crash the
      // daemon. The console.warn above already surfaced the count.
    }
  }
}
