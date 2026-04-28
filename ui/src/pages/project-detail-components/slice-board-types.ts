// Slice-board column definitions.
//
// Shared shape consumed by every other file in the slice-board feature
// (SliceBoard, SliceBoardColumn, SliceCard, and the slice-06 "5-column"
// upgrade). Keeping the type + defaults in their own module means the board
// component never has to know how many columns it is rendering — it just
// iterates the array it receives.
//
// Status → visual-bucket mapping is derived from `status-badge.tsx` so that
// a status can never appear in two columns by accident. The contract is
// enforced by the unit test
// `column_def_matchStatuses_arrays_are_mutually_exclusive`.
//
// Colors are intentionally NOT encoded here: SliceCard reads them from the
// badge utility at render time so the board and the badges can never drift
// apart.

import type { SliceStatus } from "@/lib/types/plan";

/**
 * "proposed" is a synthetic column id used by the mission-scoped board
 * variant (DEFAULT_MISSION_COLUMNS). It is NOT a SliceStatus — supervisor
 * proposals are `mission_events.kind === 'remediation_proposed'` rows, not
 * plan-store slices — so it lives next to SliceStatus in the column id
 * union without polluting the canonical plan enum.
 *
 * The proposed column is rendered by `SliceBoard` from a separate `proposals`
 * prop (each entry rendered by `ProposedCard`). `matchStatuses` for the
 * proposed column is the empty array on purpose: no `SliceStatus` value
 * matches it, so the slice grouping never accidentally lands a slice in
 * the proposed bucket.
 */
export type ColumnId = SliceStatus | "proposed";

/**
 * Shape of a single column on the slice board.
 *
 * - `id`       — primary status the column represents (also the column key).
 *                Includes `"proposed"` for mission-scoped boards (see
 *                `DEFAULT_MISSION_COLUMNS` below).
 * - `title`    — human-readable column heading.
 * - `matchStatuses` — every slice status that should render in this column.
 *                    Must be mutually exclusive across all columns.
 *                    Empty for the proposed column — proposals are routed
 *                    through a parallel `proposals` prop, not by status
 *                    matching.
 */
export interface ColumnDef {
  id: ColumnId;
  title: string;
  matchStatuses: SliceStatus[];
}

/**
 * Default 3-column layout for the slice board.
 *
 * `matchStatuses` groupings mirror the visual buckets defined by
 * `statusBadge()` in `ui/src/components/status-badge.tsx`:
 *
 *   pending  column → secondary badges         (pending, planning)
 *   active   column → default / active badges  (active)
 *   completed column → green-outline badges    (completed)
 *
 * `verifying` and `merging` are intentionally omitted from the default
 * layout: the auto-executor (`src/services/auto-executor.ts`) never
 * transitions a slice into either state today — `aggregateSliceStatus`
 * only emits pending/active/completed/failed, and `syncPlanFromExecutionTask`
 * maps `pending_approval` to `active`, not to `verifying`. Rendering an
 * always-empty "Verifying" column confuses users, so we hide it until the
 * backend actually produces the status. If a slice somehow acquires
 * `verifying`/`merging` out of band (manual PATCH), it falls through to
 * the `Other` fallback column — see the "unknown status fallback" tests.
 *
 * `skipped` and `failed` are also omitted for the same reason — terminal
 * buckets that land in `Other` when they appear.
 *
 * The `SliceStatus` enum still carries `verifying` and `merging` on purpose:
 * the status-badge / slice-node / slice-card components keep their colour
 * mappings so the column can be reinstated by a one-line edit here the day
 * the backend starts emitting it.
 *
 * The board component renders whatever column array it is handed, so
 * callers that want the old 4-column layout (or the slice-06 "5-column"
 * upgrade) can still pass their own `columns` prop — the mutual-exclusion
 * contract is enforced by the unit tests on whatever array is passed.
 */
export const DEFAULT_SLICE_COLUMNS: readonly ColumnDef[] = [
  {
    id: "pending",
    title: "Pending",
    matchStatuses: ["pending", "planning"],
  },
  {
    id: "active",
    title: "Active",
    matchStatuses: ["active"],
  },
  {
    id: "completed",
    title: "Completed",
    matchStatuses: ["completed"],
  },
] as const;

/**
 * Mission-scoped 5-column layout for the slice board.
 *
 * Identical to `DEFAULT_SLICE_COLUMNS` BUT prepends a violet-accented
 * "Proposed" column that holds the supervisor's outstanding remediation
 * proposals (rendered by `ProposedCard`, not `SliceCard`), AND reinstates
 * a "Verifying" bucket so the operator can see active proposals + slices
 * that have been approved-and-are-now-running side by side.
 *
 * Column count is 5 by design — the parent slice contract pins the layout
 * to "Proposed | Pending | Active | Verifying | Completed" so the mission-
 * control board reads as a full lifecycle when an operator drills into a
 * mission scope.
 *
 * Visual treatment for the Proposed column header uses the violet variant
 * added in milestone 09 slice 06 task 01 (see `status-badge.tsx`'s
 * `case "proposed"` — `border-violet-500 text-violet-600`). The column
 * header itself is a plain text label; it's the cards inside that pick
 * up the violet accent through `statusBadge("proposed")`.
 *
 * `matchStatuses` is empty for the Proposed column on purpose: proposals
 * are mission events, not slices. `SliceBoard` renders the column from
 * the separate `proposals` prop instead of routing through `groupSlices`.
 *
 * Callers swap this in via `SliceBoard.columns` when the operator selects
 * a mission in the left tree (BoardView wires the swap from `useSelection`
 * — see `ProjectDetailBoardView.BoardCenterDefault`).
 */
export const DEFAULT_MISSION_COLUMNS: readonly ColumnDef[] = [
  {
    id: "proposed",
    title: "Proposed",
    matchStatuses: [],
  },
  {
    id: "pending",
    title: "Pending",
    matchStatuses: ["pending", "planning"],
  },
  {
    id: "active",
    title: "Active",
    matchStatuses: ["active"],
  },
  {
    id: "verifying",
    title: "Verifying",
    matchStatuses: ["verifying", "merging"],
  },
  {
    id: "completed",
    title: "Completed",
    matchStatuses: ["completed"],
  },
] as const;

export default DEFAULT_SLICE_COLUMNS;
