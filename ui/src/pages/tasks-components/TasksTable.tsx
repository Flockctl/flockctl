import * as React from "react";
import { useNavigate } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";

import { LiveDot, StatusPill } from "@/components/design";
import { statusPillTone, liveDotFor } from "@/lib/task-status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, timeAgo } from "@/lib/utils";
import { formatCost } from "@/lib/format";
import type { TaskStatus } from "@/lib/types";

/**
 * TasksTable — dense, presentational table view of tasks under the M22
 * design tokens (slice 24-00 T02). Restyles the legacy
 * `tasks-table.tsx`/shadcn `<Table>` listing into a flat-surface table:
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────┐
 *   │ □  ID         TITLE                  PROJECT     STATUS       CREATED   COST │  ← header (uppercase tracking-wider zinc-500 font-semibold)
 *   │──────────────────────────────────────────────────────────────────────────────│  ← divide-y between body rows
 *   │ ☑  abc12345   Refactor auth          [flockctl]  ● RUNNING    3m ago    $0.04│  ← hover bg-zinc-50 dark:bg-zinc-800/40
 *   │ □  4f7a09b1   Migrate schema         [cms]       ● QUEUED     1h ago    $0.00│
 *   └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - Presentational: the parent (e.g. `tasks.tsx`) is responsible for
 *     fetching, sorting, paging, and filtering. Multi-select state lives
 *     in the parent — this component is fully controlled via
 *     {@link TasksTableProps.selectedIds} + {@link TasksTableProps.onSelectionChange}.
 *   - The status column's tone + optional `<LiveDot>` is derived in
 *     {@link statusPillTone} and {@link liveDotFor} from the canonical mapping
 *     captured in the slice's audit findings:
 *       running              → success + live (pulse halo)
 *       queued / assigned    → info + idle
 *       done                 → success
 *       failed / timed_out   → danger
 *       cancelled            → neutral
 *       waiting_for_input    → warning + idle (operator-blocking, do NOT pulse)
 *       pending_approval     → warning + idle
 *       rate_limited         → warning + idle
 *   - Project pill uses `<StatusPill tone="info">` and accepts an optional
 *     `accentClassName` so callers can paint each workspace's family colour.
 *   - Row click navigates to `/tasks/:id`; the kebab dropdown stops
 *     propagation. Clicking the checkbox cell (or its label area) does NOT
 *     navigate either — only the actual row click area does.
 *   - Cost renders as monospace `$N.NN`. Falls back to `$0.00` when the
 *     task has not produced a usage row yet.
 *   - Long titles + project labels truncate via `min-w-0 truncate`.
 */

export interface TasksTableRow {
  id: string;
  title: string;
  status: TaskStatus | string;
  /** Optional pill rendered in the project column. Omit for unassigned tasks. */
  project?: {
    name: string;
    /**
     * Tailwind override for the pill's bg + text colour. Defaults to
     * StatusPill's `info` tone (indigo).
     */
    accentClassName?: string;
  };
  /** ISO timestamp; falls back to `—`. */
  created_at: string | null;
  /** Total USD cost from `usage_records`. Defaults to 0. */
  cost_usd?: number | null;
}

export interface TasksTableProps {
  rows: ReadonlyArray<TasksTableRow>;
  /** Currently-selected row ids (controlled). */
  selectedIds?: ReadonlyArray<string>;
  /** Fires whenever the selection changes (header tri-state OR row toggle). */
  onSelectionChange?: (ids: string[]) => void;
  /** Override the default `nav('/tasks/:id')` row click. */
  onRowClick?: (id: string) => void;
  /** Optional kebab actions. Omit any callback to hide its menu item. */
  onCancel?: (id: string) => void;
  onRerun?: (id: string) => void;
  onCopyId?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

const HEADER_CELL =
  "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

const BODY_CELL = "px-3 py-2 align-middle";

const ROW =
  "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors";

// Status pill tone / live-dot mapping live in `@/lib/task-status` so RunsTab
// and TasksTable agree on what every status row should look like.

/**
 * Local USD wrapper that defends against null/NaN/Infinity inputs by clamping
 * to `0` before delegating to the canonical `formatCost`. Kept as a thin
 * wrapper rather than expanding `formatCost` itself because the table is the
 * only place where "missing → $0.00" is the desired display.
 */
function formatCostOrZero(cost: number | null | undefined): string {
  const value = typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
  return formatCost(value);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function TasksTable({
  rows,
  selectedIds,
  onSelectionChange,
  onRowClick,
  onCancel,
  onRerun,
  onCopyId,
  className,
  "data-testid": testId,
}: TasksTableProps): React.JSX.Element {
  const navigate = useNavigate();
  const hasKebab = Boolean(onCancel || onRerun || onCopyId);

  const selected = React.useMemo(
    () => new Set(selectedIds ?? []),
    [selectedIds],
  );

  const allIds = React.useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = rows.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selected.has(id));
  // Radix Checkbox supports `checked={true | false | "indeterminate"}`.
  const headerChecked: boolean | "indeterminate" = allSelected
    ? true
    : someSelected
      ? "indeterminate"
      : false;

  const emit = React.useCallback(
    (next: Set<string>) => {
      if (!onSelectionChange) return;
      onSelectionChange(allIds.filter((id) => next.has(id)));
    },
    [allIds, onSelectionChange],
  );

  const handleToggleAll = React.useCallback(
    (checked: boolean | "indeterminate") => {
      if (!onSelectionChange) return;
      const next = new Set(selected);
      if (checked === true) {
        for (const id of allIds) next.add(id);
      } else {
        for (const id of allIds) next.delete(id);
      }
      emit(next);
    },
    [allIds, emit, onSelectionChange, selected],
  );

  const handleToggleRow = React.useCallback(
    (id: string, checked: boolean | "indeterminate") => {
      if (!onSelectionChange) return;
      const next = new Set(selected);
      if (checked === true) next.add(id);
      else next.delete(id);
      emit(next);
    },
    [emit, onSelectionChange, selected],
  );

  const handleOpen = React.useCallback(
    (id: string) => {
      if (onRowClick) {
        onRowClick(id);
        return;
      }
      navigate(`/tasks/${id}`);
    },
    [navigate, onRowClick],
  );

  return (
    <table
      data-testid={testId ?? "tasks-table"}
      className={cn("w-full text-[12.5px]", className)}
    >
      <thead data-testid="tasks-table-head">
        <tr>
          <th scope="col" className={cn(HEADER_CELL, "w-[36px]")}>
            <span className="sr-only">Select</span>
            <Checkbox
              data-testid="tasks-table-select-all"
              aria-label={
                allSelected ? "Deselect all tasks" : "Select all tasks"
              }
              checked={headerChecked}
              onCheckedChange={handleToggleAll}
              disabled={rows.length === 0 || !onSelectionChange}
              onClick={(e) => e.stopPropagation()}
            />
          </th>
          <th scope="col" className={HEADER_CELL}>
            ID
          </th>
          <th scope="col" className={HEADER_CELL}>
            Title
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Project
          </th>
          <th scope="col" className={HEADER_CELL}>
            Status
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Created
          </th>
          <th
            scope="col"
            className={cn(HEADER_CELL, "hidden sm:table-cell text-right")}
          >
            Cost
          </th>
          <th
            scope="col"
            className={cn(HEADER_CELL, "w-[44px] text-right")}
            aria-label="Actions"
          />
        </tr>
      </thead>
      <tbody
        data-testid="tasks-table-body"
        className="divide-y divide-zinc-100 dark:divide-zinc-800"
      >
        {rows.map((row) => {
          const isSelected = selected.has(row.id);
          const tone = statusPillTone(row.status);
          const dot = liveDotFor(row.status);
          return (
            <tr
              key={row.id}
              data-testid="tasks-table-row"
              data-task-id={row.id}
              data-selected={isSelected ? "true" : "false"}
              onClick={() => handleOpen(row.id)}
              className={ROW}
            >
              {/* Multi-select checkbox cell — clicking it toggles selection
                  but does NOT propagate the row click handler. */}
              <td
                className={cn(BODY_CELL, "w-[36px]")}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Checkbox
                  data-testid="tasks-table-row-checkbox"
                  aria-label={isSelected ? "Deselect task" : "Select task"}
                  checked={isSelected}
                  onCheckedChange={(checked) =>
                    handleToggleRow(row.id, checked)
                  }
                  disabled={!onSelectionChange}
                />
              </td>

              {/* ID — short hex in mono. */}
              <td
                className={cn(
                  BODY_CELL,
                  "font-mono text-[11.5px] text-zinc-500",
                )}
              >
                <span data-testid="tasks-table-id">{shortId(row.id)}</span>
              </td>

              {/* Title — truncate. */}
              <td className={cn(BODY_CELL, "min-w-0")}>
                <div
                  data-testid="tasks-table-title"
                  className="truncate font-medium text-[12.5px]"
                  title={row.title}
                >
                  {row.title}
                </div>
              </td>

              {/* Project pill */}
              <td className={cn(BODY_CELL, "hidden md:table-cell")}>
                {row.project ? (
                  <StatusPill
                    tone="info"
                    data-testid="tasks-table-project-pill"
                    className={cn(row.project.accentClassName)}
                  >
                    {row.project.name}
                  </StatusPill>
                ) : (
                  <span
                    data-testid="tasks-table-project-empty"
                    className="text-zinc-400"
                  >
                    —
                  </span>
                )}
              </td>

              {/* Status — pill + optional LiveDot for live/idle states. */}
              <td className={BODY_CELL}>
                <span
                  data-testid="tasks-table-status"
                  className="inline-flex items-center gap-1.5"
                >
                  {dot && (
                    <LiveDot
                      data-testid="tasks-table-status-dot"
                      state={dot}
                      size="xs"
                    />
                  )}
                  <StatusPill tone={tone}>{String(row.status)}</StatusPill>
                </span>
              </td>

              {/* Created (relative time). */}
              <td
                className={cn(
                  BODY_CELL,
                  "hidden sm:table-cell text-[11.5px] text-zinc-500",
                )}
              >
                <span data-testid="tasks-table-created">
                  {timeAgo(row.created_at)}
                </span>
              </td>

              {/* Cost — mono $N.NN. */}
              <td
                className={cn(
                  BODY_CELL,
                  "hidden sm:table-cell font-mono text-[11.5px] text-right tabular-nums",
                )}
              >
                <span data-testid="tasks-table-cost">
                  {formatCostOrZero(row.cost_usd)}
                </span>
              </td>

              {/* Actions kebab */}
              <td className={cn(BODY_CELL, "text-right w-[44px]")}>
                {hasKebab ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="inline-flex"
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="More actions"
                          data-testid="tasks-table-kebab"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        {onCopyId && (
                          <DropdownMenuItem
                            onSelect={() => onCopyId(row.id)}
                          >
                            Copy ID
                          </DropdownMenuItem>
                        )}
                        {onRerun && (
                          <DropdownMenuItem
                            onSelect={() => onRerun(row.id)}
                          >
                            Re-run
                          </DropdownMenuItem>
                        )}
                        {onCancel && (
                          <>
                            {(onCopyId || onRerun) && (
                              <DropdownMenuSeparator />
                            )}
                            <DropdownMenuItem
                              onSelect={() => onCancel(row.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              Cancel
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default TasksTable;
