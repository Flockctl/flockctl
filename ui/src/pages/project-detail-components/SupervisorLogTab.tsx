import { useMissionEvents, type MissionEvent } from "@/lib/hooks/missions";

/**
 * Supervisor log tab — milestone 10 / slice 06.
 *
 * Renders the live `mission_events` timeline for a single mission. Wired
 * into `SliceDetailTabs` by composition: the parent (a slice rail mounted
 * over a slice that belongs to a milestone WITH a `mission_id`) appends
 * `supervisorLogTab(missionId)` onto `DEFAULT_SLICE_TABS` — see
 * `getSliceDetailTabs` in `SliceDetailTabs.tsx` for the helper that does
 * the conditional registration.
 *
 * Rendering contract:
 *   - The list is newest-first (matches `GET /events`'s `created_at DESC`
 *     ordering and the live overlay's `unshift` flush).
 *   - Each row shows `kind` + `depth` + relative timestamp. `payload` is
 *     intentionally collapsed to a one-line preview — the full forensics
 *     view lives behind a future "view details" affordance, not in the
 *     log tab.
 *   - Empty state is a muted hint, not a spinner. The hook handles the
 *     loading + error states explicitly.
 *
 * Performance contract (parent slice 10/05):
 *   The hook RAF-coalesces WS frames so a 100-event burst lands as one
 *   re-render. This component does NOT introspect the buffer — it just
 *   renders whatever `events` resolves to. We DON'T memoize the row
 *   components individually because (a) the row payload is trivial
 *   (kind + depth + ts) and (b) react-virtual or windowing would only
 *   matter past ~10k rows; the page cap is 200.
 */

export interface SupervisorLogTabProps {
  /** Mission whose timeline to render. */
  missionId: string;
}

/**
 * Format a unix-seconds timestamp as a short human-readable string.
 * Locale-aware (browser default) — shows hh:mm:ss for today's events
 * and a date-prefix for older ones.
 */
function formatTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString();
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/** Single row in the timeline. Kept inline because the markup is trivial. */
function SupervisorLogRow({ event }: { event: MissionEvent }) {
  return (
    <li
      data-slot="supervisor-log-row"
      data-testid="supervisor-log-row"
      data-event-id={event.id}
      data-event-kind={event.kind}
      className="flex items-baseline gap-3 border-b border-border/40 py-1 text-sm last:border-b-0"
    >
      <span
        className="shrink-0 font-mono text-xs text-muted-foreground"
        aria-label="event timestamp"
      >
        {formatTimestamp(event.created_at)}
      </span>
      <span
        className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
        aria-label="event kind"
      >
        {event.kind}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground" aria-label="event depth">
        d={event.depth}
      </span>
    </li>
  );
}

/**
 * Supervisor log tab body. See file header for the rendering + perf
 * contracts.
 */
export function SupervisorLogTab({ missionId }: SupervisorLogTabProps) {
  const { events, isLoading, error, connectionState } =
    useMissionEvents(missionId);

  if (isLoading && events.length === 0) {
    return (
      <div
        data-slot="supervisor-log-loading"
        data-testid="supervisor-log-loading"
        className="text-sm text-muted-foreground"
      >
        Loading supervisor log…
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div
        data-slot="supervisor-log-error"
        data-testid="supervisor-log-error"
        role="alert"
        className="text-sm text-destructive"
      >
        Failed to load supervisor log: {String((error as Error).message ?? error)}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div
        data-slot="supervisor-log-empty"
        data-testid="supervisor-log-empty"
        className="text-sm text-muted-foreground"
      >
        No supervisor events yet for this mission.
      </div>
    );
  }

  return (
    <div
      data-slot="supervisor-log-tab"
      data-testid="supervisor-log-tab"
      data-connection-state={connectionState}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
        <span aria-label="websocket connection state">
          ws: {connectionState}
        </span>
      </div>
      <ul
        data-slot="supervisor-log-list"
        data-testid="supervisor-log-list"
        className="flex-1 min-h-0 list-none overflow-y-auto pr-1"
      >
        {events.map((event) => (
          <SupervisorLogRow key={event.id} event={event} />
        ))}
      </ul>
    </div>
  );
}

export default SupervisorLogTab;
