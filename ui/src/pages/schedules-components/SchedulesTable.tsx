import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { StatusPill, type StatusPillTone } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, timeAgo } from "@/lib/utils";
import { ScheduleStatus, type Schedule, type TemplateScope } from "@/lib/types";

/**
 * SchedulesTable — flat divider-y restyle of the /schedules table under the
 * M22 token system (slice "Schedules table restyle"). Replaces the shadcn
 * `<Table>` defaults with the same surface tokens as `ProjectsTable` so the
 * page reads as one cohesive listing instead of a card-bordered grid.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ NAME       CRON         PROJECT   TEMPLATE   NEXT RUN  LAST RUN  ⋯ │  ← header (uppercase tracking-wider zinc-500 font-semibold)
 *   │────────────────────────────────────────────────────────────────────│  ← divide-y between body rows
 *   │ nightly    0 0 0 0 0    [proj]    deploy     in 4h     3m ago  AC  │  ← active row, scope-tinted pill, status pill (success)
 *   │ pulse-old  /15 0 0 0 0  [—]       healthcheck —        12d ago PA  │  ← paused row → opacity-60, neutral pill
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - Presentational: the parent (`pages/schedules.tsx`) wires data fetching,
 *     pagination, filter state, and the delete-confirm dialog. The kebab
 *     callbacks just receive the schedule id.
 *   - The "project" column shows the schedule's `template_scope` as a
 *     {@link StatusPill} tinted by scope (`global` → neutral, `workspace` →
 *     info, `project` → success). When the schedule is disabled (status !==
 *     `active`) the pill collapses to neutral and the row gains
 *     `opacity-60` — matches the "neutral pill + dimmed row" contract.
 *   - The "last run" column pairs a mono relative-time stamp with a
 *     {@link StatusPill} of `schedule.status` (active → success, paused →
 *     warning, expired → neutral) so the row reads at-a-glance.
 *   - Long template names truncate; the timestamp helpers (`timeAgo`) handle
 *     null/undefined → `—` already.
 */

const HEADER_CELL =
  "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

const BODY_CELL = "px-3 py-2 align-middle";

const ROW_BASE =
  "transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40";

const SCOPE_TONE: Record<TemplateScope, StatusPillTone> = {
  global: "neutral",
  workspace: "info",
  project: "success",
};

const SCOPE_LABEL: Record<TemplateScope, string> = {
  global: "Global",
  workspace: "Workspace",
  project: "Project",
};

const STATUS_TONE: Record<ScheduleStatus, StatusPillTone> = {
  [ScheduleStatus.active]: "success",
  [ScheduleStatus.paused]: "warning",
  [ScheduleStatus.expired]: "neutral",
};

/**
 * Map a handful of canonical cron expressions back to the human label the
 * create-schedule dialog uses. Falls back to the raw cron when the user
 * picked "Custom cron…" in the dialog.
 */
const CRON_PRESET_LABEL: Record<string, string> = {
  "*/5 * * * *": "Every 5 minutes",
  "*/15 * * * *": "Every 15 minutes",
  "*/30 * * * *": "Every 30 minutes",
  "0 * * * *": "Every hour",
  "0 0 * * *": "Daily at midnight",
  "0 6 * * *": "Daily at 6 AM",
  "0 12 * * *": "Daily at noon",
  "0 18 * * *": "Daily at 6 PM",
  "0 0 * * 1": "Weekly on Monday",
  "0 0 * * 5": "Weekly on Friday",
};

function scheduleDisplayName(s: Schedule): string {
  if (s.cron_expression) {
    const preset = CRON_PRESET_LABEL[s.cron_expression];
    if (preset) return preset;
  }
  return s.template_name;
}

export interface SchedulesRowProps {
  schedule: Schedule;
  onRunNow?: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onDelete?: (id: string) => void;
}

/**
 * Single body row — exported so unit tests can mount it under a synthetic
 * `<table><tbody>` wrapper without dragging the whole header in.
 *
 * Wrapped in `React.memo` (audit-round-5) — schedules table polls and
 * WS-pushes status changes; memoising the per-row component avoids
 * re-rendering rows whose data hasn't changed.
 */
function SchedulesRowImpl({
  schedule,
  onRunNow,
  onPause,
  onResume,
  onDelete,
}: SchedulesRowProps): React.JSX.Element {
  const disabled = schedule.status !== ScheduleStatus.active;
  const scopeTone: StatusPillTone = disabled
    ? "neutral"
    : SCOPE_TONE[schedule.template_scope] ?? "neutral";
  const statusTone: StatusPillTone =
    STATUS_TONE[schedule.status] ?? "neutral";

  const hasKebab = Boolean(
    onRunNow ||
      onDelete ||
      (schedule.status === ScheduleStatus.active && onPause) ||
      (schedule.status === ScheduleStatus.paused && onResume),
  );

  return (
    <tr
      data-testid="schedules-table-row"
      data-schedule-id={schedule.id}
      data-disabled={disabled ? "true" : undefined}
      className={cn(ROW_BASE, disabled && "opacity-60")}
    >
      {/* Name */}
      <td className={cn(BODY_CELL)}>
        <div
          data-testid="schedules-table-name"
          className="font-semibold text-[12.5px] truncate"
          title={schedule.template_name}
        >
          {scheduleDisplayName(schedule)}
        </div>
      </td>

      {/* Cron — monospace */}
      <td className={cn(BODY_CELL, "font-mono text-[11.5px] text-zinc-500")}>
        <span data-testid="schedules-table-cron">
          {schedule.cron_expression ?? "—"}
        </span>
      </td>

      {/* Project — StatusPill (scope-tinted; collapses to neutral when disabled) */}
      <td className={cn(BODY_CELL, "hidden md:table-cell")}>
        <StatusPill
          tone={scopeTone}
          data-testid="schedules-table-project-pill"
        >
          {SCOPE_LABEL[schedule.template_scope] ?? schedule.template_scope}
        </StatusPill>
      </td>

      {/* Template */}
      <td
        className={cn(
          BODY_CELL,
          "hidden md:table-cell text-[12px] text-zinc-600 dark:text-zinc-400",
        )}
      >
        <span
          data-testid="schedules-table-template"
          className="block truncate"
          title={schedule.template_name}
        >
          {schedule.template_name}
        </span>
      </td>

      {/* Next run — mono relative time */}
      <td
        className={cn(
          BODY_CELL,
          "hidden sm:table-cell font-mono text-[11.5px] text-zinc-500",
        )}
      >
        <span data-testid="schedules-table-next-run">
          {timeAgo(schedule.next_fire_time)}
        </span>
      </td>

      {/* Last run — mono relative time + status pill */}
      <td className={cn(BODY_CELL, "hidden sm:table-cell")}>
        <div className="flex items-center gap-2">
          <span
            data-testid="schedules-table-last-run"
            className="font-mono text-[11.5px] text-zinc-500"
          >
            {timeAgo(schedule.last_fire_time)}
          </span>
          <StatusPill
            tone={statusTone}
            size="sm"
            data-testid="schedules-table-status-pill"
          >
            {schedule.status}
          </StatusPill>
        </div>
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
                  data-testid="schedules-table-kebab"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {onRunNow && (
                  <DropdownMenuItem onSelect={() => onRunNow(schedule.id)}>
                    Run now
                  </DropdownMenuItem>
                )}
                {schedule.status === ScheduleStatus.active && onPause && (
                  <DropdownMenuItem onSelect={() => onPause(schedule.id)}>
                    Pause
                  </DropdownMenuItem>
                )}
                {schedule.status === ScheduleStatus.paused && onResume && (
                  <DropdownMenuItem onSelect={() => onResume(schedule.id)}>
                    Resume
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    {(onRunNow ||
                      (schedule.status === ScheduleStatus.active && onPause) ||
                      (schedule.status === ScheduleStatus.paused &&
                        onResume)) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onSelect={() => onDelete(schedule.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      Delete
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
}

export interface SchedulesTableProps {
  rows: ReadonlyArray<Schedule>;
  onRunNow?: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onDelete?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

export function SchedulesTable({
  rows,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  className,
  "data-testid": testId,
}: SchedulesTableProps): React.JSX.Element {
  return (
    <table
      data-testid={testId ?? "schedules-table"}
      className={cn("w-full text-[12.5px]", className)}
    >
      <thead data-testid="schedules-table-head">
        <tr>
          <th scope="col" className={HEADER_CELL}>
            Name
          </th>
          <th scope="col" className={HEADER_CELL}>
            Cron
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Project
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Template
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Next run
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Last run
          </th>
          <th
            scope="col"
            className={cn(HEADER_CELL, "w-[44px] text-right")}
            aria-label="Actions"
          />
        </tr>
      </thead>
      <tbody
        data-testid="schedules-table-body"
        className="divide-y divide-zinc-100 dark:divide-zinc-800"
      >
        {rows.map((s) => (
          <SchedulesRow
            key={s.id}
            schedule={s}
            onRunNow={onRunNow}
            onPause={onPause}
            onResume={onResume}
            onDelete={onDelete}
          />
        ))}
      </tbody>
    </table>
  );
}

export const SchedulesRow = React.memo(SchedulesRowImpl);

export default SchedulesTable;
