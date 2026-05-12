import type { LiveDotState, StatusPillTone } from "@/components/design";

/**
 * Canonical mapping `task.status` → `<StatusPill>` tone. Replaces the two
 * drifted local copies (`statusPillTone` in `RunsTab.tsx`, `toneFor` in
 * `TasksTable.tsx`). The locked-in semantics (per the slice 24-00 audit
 * captured in `tasks-table.test.tsx`):
 *
 *   running              → success  (work IS happening — green)
 *   done / completed     → success
 *   queued               → info     (waiting in line, not blocked)
 *   failed / timed_out   → danger
 *   waiting_for_input    → warning  (operator-blocking)
 *   pending_approval     → warning
 *   rate_limited         → warning
 *   cancelled / unknown  → neutral
 *
 * Unknown statuses fall through to `neutral` so a future enum addition does
 * not crash the row.
 */
export function statusPillTone(status: string | null | undefined): StatusPillTone {
  switch (status) {
    case "running":
    case "done":
    case "completed":
      return "success";
    case "queued":
      return "info";
    case "failed":
    case "timed_out":
      return "danger";
    case "waiting_for_input":
    case "pending_approval":
    case "rate_limited":
      return "warning";
    case "cancelled":
    default:
      return "neutral";
  }
}

/**
 * Pretty-print a snake_case status enum for an UPPERCASE pill label —
 * `pending_approval` reads worse with underscores once the CSS uppercases it.
 */
export function statusPillLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * Whether the row should render a leading `<LiveDot>` and which state it
 * should be in. Returns `null` for terminal/quiescent statuses where a dot
 * would imply ongoing motion the row no longer has.
 */
export function liveDotFor(status: string | null | undefined): LiveDotState | null {
  switch (status) {
    case "running":
      return "live";
    case "queued":
    case "waiting_for_input":
    case "pending_approval":
    case "rate_limited":
      return "idle";
    default:
      return null;
  }
}
