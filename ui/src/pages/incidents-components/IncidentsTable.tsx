import * as React from "react";

import { cn } from "@/lib/utils";
import {
  IncidentRow,
  type IncidentRowIncident,
} from "./IncidentRow";

/**
 * IncidentsTable — flat divider-y restyle of the `/incidents` listing
 * (M25 slice 04 T00). Mirrors the surface tokens used by `SchedulesTable`
 * and `ProjectsTable` so the page reads as one cohesive listing.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ SEV   TITLE                  SOURCE   OPENED   RESOLVED      ⋯ │  ← header (uppercase tracking-wider zinc-500 font-semibold)
 *   │─────────────────────────────────────────────────────────────────│  ← divide-y between body rows
 *   │ CRIT  Postgres OOM crash     chat     2h ago   1h ago        AC │
 *   │ MED   Cron drift on host-2   task     3d ago   —             AC │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Presentational only — `pages/incidents.tsx` wires the data fetch,
 * navigation, and the delete-confirm dialog. Click on a row body fires
 * `onSelect(incident.id)` (parent maps that to `navigate(/incidents/:id)`);
 * the kebab fires `onDelete(incident.id)`.
 */

const HEADER_CELL =
  "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

export interface IncidentsTableProps {
  rows: ReadonlyArray<IncidentRowIncident>;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

export function IncidentsTable({
  rows,
  onSelect,
  onDelete,
  className,
  "data-testid": testId,
}: IncidentsTableProps): React.JSX.Element {
  return (
    <table
      data-testid={testId ?? "incidents-table"}
      className={cn("w-full text-[12.5px]", className)}
    >
      <thead data-testid="incidents-table-head">
        <tr>
          <th scope="col" className={cn(HEADER_CELL, "w-[64px]")}>
            Severity
          </th>
          <th scope="col" className={HEADER_CELL}>
            Title
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Source
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Opened
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Resolved
          </th>
          <th
            scope="col"
            className={cn(HEADER_CELL, "w-[44px] text-right")}
            aria-label="Actions"
          />
        </tr>
      </thead>
      <tbody
        data-testid="incidents-table-body"
        className="divide-y divide-zinc-100 dark:divide-zinc-800"
      >
        {rows.map((incident) => (
          <IncidentRow
            key={incident.id}
            incident={incident}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </tbody>
    </table>
  );
}

export default IncidentsTable;
