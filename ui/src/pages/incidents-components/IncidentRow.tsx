import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { StatusPill, type StatusPillTone } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, timeAgo } from "@/lib/utils";

/**
 * IncidentRow — single body row for the `/incidents` table (M25 slice 04 T00).
 *
 * Layout
 * ------
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ CRIT  Long incident title…   chat   2h ago   1h ago           ⋯ │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Six columns: severity StatusPill | title | source | opened-at |
 * resolved-at | actions kebab. Ordered so the eye reads severity first,
 * then the human-readable title, then the metadata that lets the operator
 * triage at a glance.
 *
 * The row is purely presentational. The parent page (`pages/incidents.tsx`)
 * wires the data fetch, the navigation hook, and the delete-confirm flow;
 * the row only knows about a {@link IncidentRowIncident} + two callbacks
 * (`onSelect(id)` for the row body, `onDelete(id)` for the kebab).
 *
 * Severity tone map — codified in this slice's parent slice.md (M25 / 04):
 *   critical → danger
 *   high     → warning
 *   medium   → info
 *   low      → neutral
 *
 * `IncidentRowIncident` is intentionally narrower than the API's
 * `IncidentResponse`. The row owns its own prop type so:
 *   - tests can fabricate just what the row reads (no need to invent every
 *     long-text column on `IncidentResponse`),
 *   - the page can map the API row to this shape once at the boundary,
 *   - the row stays decoupled from any future API evolution that would
 *     widen `IncidentResponse`.
 */

export type IncidentSeverity = "critical" | "high" | "medium" | "low";

/** Where the incident was filed from — drives the source-column label. */
export type IncidentSource = "chat" | "task" | "mission";

const SEVERITY_TONE: Record<IncidentSeverity, StatusPillTone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

const SOURCE_LABEL: Record<IncidentSource, string> = {
  chat: "chat",
  task: "task",
  mission: "mission",
};

/**
 * Row prop subset. Kept narrow on purpose — the row should compile without
 * a dependency on any specific API type.
 */
export interface IncidentRowIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  source: IncidentSource | null;
  opened_at: string;
  resolved_at: string | null;
}

export interface IncidentRowProps {
  incident: IncidentRowIncident;
  /** Fires when the row body (anywhere outside the kebab) is activated. */
  onSelect?: (id: string) => void;
  /** Optional kebab action — when omitted the kebab is hidden. */
  onDelete?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

const BODY_CELL = "px-3 py-2 align-middle";
const ROW_BASE =
  "transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer";

/**
 * Single body row — exported standalone so unit tests can wrap it in a
 * synthetic `<table><tbody>` without dragging the whole header in.
 *
 * Wrapped in `React.memo` (audit-round-5) so a parent re-render driven
 * by a sibling state change doesn't re-render every IncidentRow in the
 * list. The parent passes `onSelect`/`onDelete` via `useCallback`,
 * keeping prop identity stable across renders.
 */
function IncidentRowImpl({
  incident,
  onSelect,
  onDelete,
  className,
  "data-testid": testId,
}: IncidentRowProps): React.JSX.Element {
  const handleSelect = React.useCallback(() => {
    onSelect?.(incident.id);
  }, [incident.id, onSelect]);

  const handleKey = React.useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect?.(incident.id);
      }
    },
    [incident.id, onSelect],
  );

  const severityTone = SEVERITY_TONE[incident.severity];
  const severityLabel = SEVERITY_LABEL[incident.severity];
  const sourceLabel = incident.source
    ? SOURCE_LABEL[incident.source]
    : null;
  const isResolved = !!incident.resolved_at;

  return (
    <tr
      data-testid={testId ?? "incidents-table-row"}
      data-incident-id={incident.id}
      data-severity={incident.severity}
      data-resolved={isResolved ? "true" : "false"}
      role="link"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKey}
      className={cn(ROW_BASE, className)}
    >
      {/* Severity */}
      <td className={cn(BODY_CELL, "w-[64px]")}>
        <StatusPill
          tone={severityTone}
          size="sm"
          data-testid="incidents-table-severity"
        >
          {severityLabel}
        </StatusPill>
      </td>

      {/* Title */}
      <td className={cn(BODY_CELL)}>
        <div
          data-testid="incidents-table-title"
          className="font-medium text-[12.5px] truncate text-zinc-900 dark:text-zinc-100"
          title={incident.title}
        >
          {incident.title}
        </div>
      </td>

      {/* Source */}
      <td
        className={cn(
          BODY_CELL,
          "hidden md:table-cell text-[12px] text-zinc-600 dark:text-zinc-400",
        )}
      >
        {sourceLabel ? (
          <span data-testid="incidents-table-source">{sourceLabel}</span>
        ) : (
          <span
            data-testid="incidents-table-source"
            className="text-zinc-400 dark:text-zinc-600"
          >
            —
          </span>
        )}
      </td>

      {/* Opened-at */}
      <td
        className={cn(
          BODY_CELL,
          "hidden sm:table-cell font-mono text-[11.5px] text-zinc-500",
        )}
      >
        <span data-testid="incidents-table-opened-at">
          {timeAgo(incident.opened_at)}
        </span>
      </td>

      {/* Resolved-at */}
      <td
        className={cn(
          BODY_CELL,
          "hidden sm:table-cell font-mono text-[11.5px] text-zinc-500",
        )}
      >
        <span data-testid="incidents-table-resolved-at">
          {timeAgo(incident.resolved_at)}
        </span>
      </td>

      {/* Actions kebab */}
      <td className={cn(BODY_CELL, "text-right w-[44px]")}>
        {onDelete ? (
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
                  data-testid="incidents-table-kebab"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onSelect={() => onDelete(incident.id)}
                  className="text-destructive focus:text-destructive"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export const IncidentRow = React.memo(IncidentRowImpl);
export default IncidentRow;
