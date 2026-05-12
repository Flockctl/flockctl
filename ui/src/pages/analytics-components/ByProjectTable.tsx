import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn, timeAgo } from "@/lib/utils";

/**
 * ByProjectTable — analytics-side per-project rollup with sortable
 * column headers (M25 analytics slice — T03).
 *
 * Layout
 * ------
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ PROJECT  ▲│  TASKS COMPLETED  │  TOTAL COST  │  TOKENS  │  LAST ACTIVITY │
 *   │─────────────────────────────────────────────────────────────────│
 *   │ Flockctl   │  17               │  $12.34       │  42K     │  3h ago        │
 *   │ cms        │  4                │  $0.12        │  2.1K    │  2d ago        │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Columns (left → right):
 *   1. Project          — project name (left-aligned, non-mono).
 *   2. Tasks completed  — integer count (right-aligned, non-mono).
 *   3. Total cost       — USD `$X.XX` (right-aligned, mono — financial).
 *   4. Tokens           — compact-formatted integer (right-aligned, mono).
 *   5. Last activity    — humanised relative time (right-aligned).
 *
 * Sorting
 * -------
 * Each `<th>` is a button. Clicking cycles the column through a
 * three-state cycle:
 *
 *     off → asc → desc → off
 *
 * Selecting a different column resets the previous column to `off` and
 * starts the new column at `asc`. Sort state lives inside the component
 * (uncontrolled) so callers can drop the table in without wiring a
 * reducer; controlled mode is intentionally NOT exposed yet — slice 25-02
 * does not have a remote-sort consumer.
 *
 * Numeric formatting
 * ------------------
 *   - **Total cost** uses 2-decimal USD (matches the KPI strip's "Spend").
 *   - **Tokens** uses `Intl.NumberFormat`'s compact notation (`42K`, `1.2M`)
 *     so the column stays single-line at every magnitude.
 *   - **Tasks completed** is rendered raw (it's an index, not a financial
 *     figure, and never grows past 4 digits in real data).
 *   - **Last activity** uses `timeAgo` for parity with `ProjectsTable`;
 *     undefined / null falls back to an em-dash.
 */

export type SortKey =
  | "project"
  | "tasksCompleted"
  | "totalCostUsd"
  | "tokens"
  | "lastActivity";

export type SortDirection = "asc" | "desc";

export interface ByProjectTableRow {
  id: string;
  name: string;
  tasksCompleted: number;
  totalCostUsd: number;
  tokens: number;
  /** ISO timestamp of last activity for this project, or null. */
  lastActivity: string | null;
}

export interface ByProjectTableProps {
  rows: ReadonlyArray<ByProjectTableRow>;
  /** Optional row click handler (e.g. navigate to /projects/:id). */
  onRowClick?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

const USD_2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const TOKENS_COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const HEADER_CELL =
  "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

const HEADER_CELL_NUMERIC =
  "px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

const BODY_CELL = "px-3 py-2 align-middle";

const ROW =
  "hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors";

interface SortableHeaderProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey | null;
  activeDirection: SortDirection | null;
  onToggle: (key: SortKey) => void;
  align?: "left" | "right";
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  activeDirection,
  onToggle,
  align = "left",
}: SortableHeaderProps): React.JSX.Element {
  const isActive = activeKey === sortKey && activeDirection !== null;
  const ariaSort: React.AriaAttributes["aria-sort"] = !isActive
    ? "none"
    : activeDirection === "asc"
      ? "ascending"
      : "descending";

  return (
    <th
      scope="col"
      className={align === "right" ? HEADER_CELL_NUMERIC : HEADER_CELL}
      aria-sort={ariaSort}
      data-testid={`by-project-table-header-${sortKey}`}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider",
          align === "right" && "ml-auto",
          "hover:text-zinc-700 dark:hover:text-zinc-300",
        )}
        data-testid={`by-project-table-header-button-${sortKey}`}
        data-sort-direction={isActive ? activeDirection : "off"}
      >
        <span>{label}</span>
        {isActive ? (
          activeDirection === "asc" ? (
            <ChevronUp
              className="h-3 w-3"
              aria-hidden="true"
              data-testid={`by-project-table-sort-icon-${sortKey}`}
              data-sort-icon="asc"
            />
          ) : (
            <ChevronDown
              className="h-3 w-3"
              aria-hidden="true"
              data-testid={`by-project-table-sort-icon-${sortKey}`}
              data-sort-icon="desc"
            />
          )
        ) : null}
      </button>
    </th>
  );
}

function compareRows(
  a: ByProjectTableRow,
  b: ByProjectTableRow,
  key: SortKey,
): number {
  switch (key) {
    case "project":
      return a.name.localeCompare(b.name);
    case "tasksCompleted":
      return a.tasksCompleted - b.tasksCompleted;
    case "totalCostUsd":
      return a.totalCostUsd - b.totalCostUsd;
    case "tokens":
      return a.tokens - b.tokens;
    case "lastActivity": {
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return aTime - bTime;
    }
  }
}

export function ByProjectTable({
  rows,
  onRowClick,
  className,
  "data-testid": testId,
}: ByProjectTableProps): React.JSX.Element {
  const [sortKey, setSortKey] = React.useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] =
    React.useState<SortDirection | null>(null);

  const toggleSort = React.useCallback(
    (key: SortKey) => {
      if (sortKey !== key) {
        setSortKey(key);
        setSortDirection("asc");
        return;
      }
      // Same column: cycle asc → desc → off.
      if (sortDirection === "asc") {
        setSortDirection("desc");
        return;
      }
      if (sortDirection === "desc") {
        setSortKey(null);
        setSortDirection(null);
        return;
      }
      // Column was previously off (defensive — should not be reachable
      // because off is represented by sortKey === null).
      setSortDirection("asc");
    },
    [sortKey, sortDirection],
  );

  const sortedRows = React.useMemo(() => {
    if (sortKey === null || sortDirection === null) {
      return rows;
    }
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => compareRows(a, b, sortKey) * direction);
  }, [rows, sortKey, sortDirection]);

  return (
    <table
      data-testid={testId ?? "by-project-table"}
      className={cn("w-full text-[12.5px]", className)}
    >
      <thead data-testid="by-project-table-head">
        <tr>
          <SortableHeader
            label="Project"
            sortKey="project"
            activeKey={sortKey}
            activeDirection={sortDirection}
            onToggle={toggleSort}
          />
          <SortableHeader
            label="Tasks completed"
            sortKey="tasksCompleted"
            activeKey={sortKey}
            activeDirection={sortDirection}
            onToggle={toggleSort}
            align="right"
          />
          <SortableHeader
            label="Total cost"
            sortKey="totalCostUsd"
            activeKey={sortKey}
            activeDirection={sortDirection}
            onToggle={toggleSort}
            align="right"
          />
          <SortableHeader
            label="Tokens"
            sortKey="tokens"
            activeKey={sortKey}
            activeDirection={sortDirection}
            onToggle={toggleSort}
            align="right"
          />
          <SortableHeader
            label="Last activity"
            sortKey="lastActivity"
            activeKey={sortKey}
            activeDirection={sortDirection}
            onToggle={toggleSort}
            align="right"
          />
        </tr>
      </thead>
      <tbody
        data-testid="by-project-table-body"
        className="divide-y divide-zinc-100 dark:divide-zinc-800"
      >
        {sortedRows.map((row) => (
          <tr
            key={row.id}
            data-testid="by-project-table-row"
            data-project-id={row.id}
            className={cn(ROW, onRowClick && "cursor-pointer")}
            onClick={onRowClick ? () => onRowClick(row.id) : undefined}
          >
            <td className={BODY_CELL}>
              <span
                data-testid="by-project-table-name"
                className="font-semibold truncate"
              >
                {row.name}
              </span>
            </td>
            <td
              className={cn(BODY_CELL, "text-right tabular-nums")}
              data-testid="by-project-table-tasks-completed"
            >
              {row.tasksCompleted}
            </td>
            <td
              className={cn(
                BODY_CELL,
                "text-right font-mono tabular-nums",
              )}
              data-testid="by-project-table-total-cost"
            >
              {USD_2.format(row.totalCostUsd)}
            </td>
            <td
              className={cn(
                BODY_CELL,
                "text-right font-mono tabular-nums",
              )}
              data-testid="by-project-table-tokens"
            >
              {TOKENS_COMPACT.format(row.tokens)}
            </td>
            <td
              className={cn(BODY_CELL, "text-right text-zinc-500")}
              data-testid="by-project-table-last-activity"
            >
              {timeAgo(row.lastActivity)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default ByProjectTable;
