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
 * Shape of a single column on the slice board.
 *
 * - `id`       — primary status the column represents (also the column key).
 * - `title`    — human-readable column heading.
 * - `matchStatuses` — every slice status that should render in this column.
 *                    Must be mutually exclusive across all columns.
 */
export interface ColumnDef {
  id: SliceStatus;
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

export default DEFAULT_SLICE_COLUMNS;
