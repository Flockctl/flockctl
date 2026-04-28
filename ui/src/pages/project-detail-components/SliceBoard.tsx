import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { SliceCard, type SlicePriority } from "./SliceCard";
import { ProposedCard, type ProposalTargetType } from "./ProposedCard";
import {
  DEFAULT_SLICE_COLUMNS,
  type ColumnDef,
} from "./slice-board-types";
import type { PlanSliceTree, SliceStatus } from "@/lib/types/plan";

// --- Slice Board (board view) ---
//
// Horizontal Kanban-style board: takes a flat array of `PlanSliceTree` and a
// list of `ColumnDef`s, groups the slices into columns by matching each
// slice's `status` against the column's `matchStatuses`, and renders each
// group as a vertical stack of `SliceCard`s.
//
// Visual anatomy:
//
//   ┌── slice-board ───────────────────────────────────────────────────────┐
//   │ ┌── column ─┐ ┌── column ─┐ ┌── column ─┐ ┌── column ─┐ ┌── Other ─┐ │
//   │ │ Pending ▪3│ │ Active  ▪1│ │ Verifying │ │ Completed │ │ <fallback>│ │
//   │ │ [SliceCard│ │ [SliceCard│ │  No slices│ │ [SliceCard│ │ [SliceCard│ │
//   │ │  SliceCard│ │           │ │           │ │           │ │           │ │
//   │ │  SliceCard│ │           │ │           │ │           │ │           │ │
//   │ └───────────┘ └───────────┘ └───────────┘ └───────────┘ └───────────┘ │
//   └───────────────────────────────────────────────────────────────────────┘
//
// Design rules this file enforces:
//
// 1. `columns` is the single source of truth for column shape — the board
//    never assumes a specific length. Swap `DEFAULT_SLICE_COLUMNS` for a
//    5-column array (slice 06) and the board re-renders with 5 columns.
//
// 2. Any slice whose status is NOT mentioned in any column's
//    `matchStatuses` falls into an "Other" fallback column. The fallback
//    column is only rendered when at least one such slice exists, so the
//    common happy path (all statuses covered) shows exactly N columns.
//
// 3. The SliceCard already reads status → color from the badge utility; the
//    board does NOT duplicate that mapping. Columns are purely structural.
//
// 4. The empty-column placeholder is a subtle muted line so the column
//    still reads as a column (keeps horizontal rhythm) but does not shout
//    for attention.
//
// 5. Selection: `selectedSliceId` is forwarded to `SliceCard` which applies
//    the focus ring. The board itself does not own selection state.
//
// Container is a horizontally-scrolling flex row; each column is a fixed
// 280px-wide vertical flex that scrolls its own contents vertically when
// the list grows longer than the viewport.

/** Which slices live in which column, plus the ids of un-matched slices. */
interface GroupedSlices {
  /** column.id → slices that matched that column, in input order. */
  byColumn: Map<string, PlanSliceTree[]>;
  /** Slices whose status was not mentioned in any column. */
  other: PlanSliceTree[];
}

function groupSlices(
  slices: readonly PlanSliceTree[],
  columns: readonly ColumnDef[],
): GroupedSlices {
  // Build a status → column.id lookup once so grouping is O(N) instead of
  // O(N * columns).
  const statusToColumnId = new Map<SliceStatus, string>();
  for (const col of columns) {
    for (const s of col.matchStatuses) {
      // Later columns silently lose to earlier columns on overlap. The
      // `column_def_matchStatuses_arrays_are_mutually_exclusive` test in
      // slice-board-types ensures this never actually happens in practice.
      if (!statusToColumnId.has(s)) {
        statusToColumnId.set(s, col.id);
      }
    }
  }

  const byColumn = new Map<string, PlanSliceTree[]>();
  for (const col of columns) {
    byColumn.set(col.id, []);
  }
  const other: PlanSliceTree[] = [];

  for (const slice of slices) {
    const columnId = statusToColumnId.get(slice.status);
    if (columnId === undefined) {
      other.push(slice);
      continue;
    }
    byColumn.get(columnId)!.push(slice);
  }

  return { byColumn, other };
}

/**
 * Mission proposal payload as flattened by the caller (typically the
 * mission proposals query). One entry per outstanding proposal — the
 * board renders these in the "proposed" column when DEFAULT_MISSION_COLUMNS
 * is in use. `missionId` is repeated per row so the proposed card can
 * fire the approve/dismiss POST without the board having to thread a
 * mission scope down separately.
 */
export interface BoardProposal {
  proposalId: string;
  missionId: string;
  rationale: string;
  targetType: ProposalTargetType;
  candidateAction: string;
  candidateSummary?: string | null;
  candidateTargetId?: string | null;
}

export interface SliceBoardProps {
  /** Flat slice array — grouped into columns internally. */
  slices: readonly PlanSliceTree[];
  /**
   * Column definitions. Defaults to `DEFAULT_SLICE_COLUMNS` so callers that
   * just want the 3-column default layout can omit this prop entirely.
   * Pass `DEFAULT_MISSION_COLUMNS` to get the 5-column mission-scoped
   * variant (Proposed | Pending | Active | Verifying | Completed).
   */
  columns?: readonly ColumnDef[];
  /**
   * Outstanding mission proposals. Rendered as `ProposedCard`s in the
   * column whose `id === "proposed"`. Empty / undefined ⇒ the proposed
   * column shows the standard empty-state placeholder.
   *
   * Only consulted when a `proposed` column actually exists in `columns`
   * — passing proposals without a proposed column is a no-op rather than
   * an error so callers can hand the same array in regardless of which
   * column layout they chose.
   */
  proposals?: readonly BoardProposal[];
  /**
   * Fires after a proposal is successfully approved on the server. The
   * caller typically invalidates its proposals query so the card drops
   * out of the proposed column on the next render.
   */
  onProposalApproved?: (proposalId: string, decisionId: string) => void;
  /** Symmetric callback for dismissed proposals. */
  onProposalDismissed?: (
    proposalId: string,
    decisionId: string,
    reason: string | null,
  ) => void;
  /**
   * Called to resolve the human-readable milestone title shown as the
   * breadcrumb on each `SliceCard`. A function (rather than a map) so the
   * caller keeps whatever lookup structure is already in hand.
   */
  milestoneTitleFor: (slice: PlanSliceTree) => string;
  /** Optional priority resolver — returns `undefined` to omit the chip. */
  priorityFor?: (slice: PlanSliceTree) => SlicePriority | undefined;
  /** Slice id that should render with the selection ring, if any. */
  selectedSliceId?: string | null;
  /** Click / keyboard activation on a card bubbles through here. */
  onSelectSlice: (sliceId: string) => void;
  /** Optional extra classes merged onto the board root. */
  className?: string;
}

export function SliceBoard({
  slices,
  columns = DEFAULT_SLICE_COLUMNS,
  proposals,
  onProposalApproved,
  onProposalDismissed,
  milestoneTitleFor,
  priorityFor,
  selectedSliceId = null,
  onSelectSlice,
  className,
}: SliceBoardProps) {
  const { byColumn, other } = useMemo(
    () => groupSlices(slices, columns),
    [slices, columns],
  );

  const showOther = other.length > 0;
  const proposalList = proposals ?? [];

  return (
    <div
      data-testid="slice-board"
      data-mission-scoped={
        columns.some((c) => c.id === "proposed") ? "true" : "false"
      }
      className={cn(
        "flex h-full w-full gap-3 overflow-x-auto overflow-y-hidden p-1",
        className,
      )}
    >
      {columns.map((column) => (
        <SliceBoardColumn
          key={column.id}
          columnId={column.id}
          title={column.title}
          slices={byColumn.get(column.id) ?? []}
          proposals={column.id === "proposed" ? proposalList : []}
          onProposalApproved={onProposalApproved}
          onProposalDismissed={onProposalDismissed}
          milestoneTitleFor={milestoneTitleFor}
          priorityFor={priorityFor}
          selectedSliceId={selectedSliceId}
          onSelectSlice={onSelectSlice}
        />
      ))}
      {showOther && (
        <SliceBoardColumn
          key="__other__"
          columnId="other"
          title="Other"
          slices={other}
          proposals={[]}
          milestoneTitleFor={milestoneTitleFor}
          priorityFor={priorityFor}
          selectedSliceId={selectedSliceId}
          onSelectSlice={onSelectSlice}
        />
      )}
    </div>
  );
}

interface SliceBoardColumnProps {
  columnId: string;
  title: string;
  slices: readonly PlanSliceTree[];
  /** Proposals to render in this column. Non-empty only for the "proposed"
   * column; every other column passes an empty array. */
  proposals: readonly BoardProposal[];
  onProposalApproved?: (proposalId: string, decisionId: string) => void;
  onProposalDismissed?: (
    proposalId: string,
    decisionId: string,
    reason: string | null,
  ) => void;
  milestoneTitleFor: (slice: PlanSliceTree) => string;
  priorityFor?: (slice: PlanSliceTree) => SlicePriority | undefined;
  selectedSliceId: string | null;
  onSelectSlice: (sliceId: string) => void;
}

function SliceBoardColumn({
  columnId,
  title,
  slices,
  proposals,
  onProposalApproved,
  onProposalDismissed,
  milestoneTitleFor,
  priorityFor,
  selectedSliceId,
  onSelectSlice,
}: SliceBoardColumnProps) {
  // Total count combines slices + proposals so the badge on the proposed
  // column reflects the number of cards the operator will see, not zero.
  const count = slices.length + proposals.length;
  const isEmpty = count === 0;

  return (
    <div
      data-testid="slice-board-column"
      data-column-id={columnId}
      data-column-count={count}
      className="flex w-[240px] shrink-0 flex-col gap-2 overflow-hidden rounded-md bg-muted/20 p-2 sm:w-[260px] md:w-[280px]"
    >
      <div
        data-testid="slice-board-column-header"
        className="flex items-center justify-between gap-2 px-1 pt-1"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <Badge
          data-testid="slice-board-column-count"
          variant="secondary"
          className="h-5 px-1.5 text-[10px] tabular-nums"
        >
          {count}
        </Badge>
      </div>

      <div
        data-testid="slice-board-column-scroll"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1"
      >
        {isEmpty ? (
          <p
            data-testid="slice-board-column-empty"
            className="px-2 py-4 text-center text-xs text-muted-foreground/70"
          >
            {columnId === "proposed" ? "No proposals" : "No slices"}
          </p>
        ) : (
          <>
            {proposals.map((p) => (
              <ProposedCard
                key={p.proposalId}
                missionId={p.missionId}
                proposalId={p.proposalId}
                rationale={p.rationale}
                targetType={p.targetType}
                candidateAction={p.candidateAction}
                candidateSummary={p.candidateSummary ?? null}
                candidateTargetId={p.candidateTargetId ?? null}
                onApproved={(decisionId) =>
                  onProposalApproved?.(p.proposalId, decisionId)
                }
                onDismissed={(decisionId, reason) =>
                  onProposalDismissed?.(p.proposalId, decisionId, reason)
                }
                className="shrink-0"
              />
            ))}
            {slices.map((slice) => (
              <SliceCard
                key={slice.id}
                slice={slice}
                milestoneTitle={milestoneTitleFor(slice)}
                priority={priorityFor?.(slice)}
                selected={selectedSliceId === slice.id}
                onSelect={onSelectSlice}
                className="shrink-0"
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default SliceBoard;
