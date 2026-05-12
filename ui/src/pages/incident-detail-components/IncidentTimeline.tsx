import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { cn, parseServerTimestamp } from "@/lib/utils";

/**
 * IncidentTimeline — chronological timeline for a single incident's lifecycle.
 *
 * Surfaces the three structurally-distinct event types an incident records:
 *
 *   - `cause`      — what triggered or contributed to the incident
 *   - `action`     — an operator action taken in response (mitigation, change)
 *   - `resolution` — the eventual fix that closed the incident
 *
 * Each row composes a tone-icon disc + an uppercase event-type label + the
 * free-text body + a relative-time stamp. The three types each carry a
 * distinct icon so the eye can scan the timeline at a glance and infer the
 * shape of the incident without reading every body.
 *
 * No coupling to mission types
 * ----------------------------
 * Incidents and missions both render "feed-of-events" surfaces, but the
 * union of events is fundamentally different — incident events are not a
 * subset/superset of the mission-event union. The milestone-level rule
 * for slice 25-incidents forbids importing the mission-event types or
 * row component, and forbids re-exporting from mission-detail-components.
 * We define a local `<EventFeedRow>` and `IncidentTimelineEvent` type so
 * the two timelines can evolve independently.
 *
 * The renderer is intentionally small (one component file, three event
 * types). If a fourth type lands we extend `TYPE_META` and add a fixture
 * to the test file — no shared abstraction needed.
 */

export type IncidentEventType = "cause" | "action" | "resolution";

export type IncidentEventTone = "amber" | "indigo" | "emerald";

interface ToneClasses {
  /** Tinted background for the avatar disc (10% alpha). */
  bg: string;
  /** Foreground colour for the icon SVG. */
  fg: string;
}

const TONE_CLASSES: Record<IncidentEventTone, ToneClasses> = {
  amber: {
    bg: "bg-amber-500/10",
    fg: "text-amber-600 dark:text-amber-400",
  },
  indigo: {
    bg: "bg-indigo-500/10",
    fg: "text-indigo-600 dark:text-indigo-400",
  },
  emerald: {
    bg: "bg-emerald-500/10",
    fg: "text-emerald-600 dark:text-emerald-400",
  },
};

interface TypeMeta {
  tone: IncidentEventTone;
  Icon: LucideIcon;
  /** Stable label for the icon's data-icon attribute (test hook). */
  iconLabel: string;
  /** Uppercase header label rendered to the left of the body. */
  label: string;
}

/**
 * Per-event-type tone + icon table. Adding a fourth type means appending
 * one entry here; the row component dispatches via the table without a
 * `switch` statement.
 */
const TYPE_META: Record<IncidentEventType, TypeMeta> = {
  cause: {
    tone: "amber",
    Icon: AlertTriangle,
    iconLabel: "alert",
    label: "CAUSE",
  },
  action: {
    tone: "indigo",
    Icon: Wrench,
    iconLabel: "wrench",
    label: "ACTION",
  },
  resolution: {
    tone: "emerald",
    Icon: CheckCircle2,
    iconLabel: "check",
    label: "RESOLUTION",
  },
};

/** Fallback meta for an event type the renderer doesn't recognise. */
const FALLBACK_META: TypeMeta = {
  tone: "amber",
  Icon: HelpCircle,
  iconLabel: "help",
  label: "EVENT",
};

/**
 * Wire shape consumed by the timeline. Local to this file — incidents
 * are NOT mission events and the two unions must not be coupled.
 */
export interface IncidentTimelineEvent {
  /** Stable identifier for React key + data-testid hooks. */
  id: string;
  /** Discriminator that selects tone + icon + label. */
  type: IncidentEventType;
  /** Free-text body rendered below the title row. */
  body: string;
  /** ISO-8601 timestamp; rendered as a relative-time short string. */
  at: string;
}

// ─── Time formatting ────────────────────────────────────────────────────────

/**
 * Render an ISO timestamp as a short relative-time string. Pure helper so
 * tests can pin `nowMs` and assert on exact strings without timezone flake.
 */
export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ts = parseServerTimestamp(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffMs = nowMs - ts;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Local row component ────────────────────────────────────────────────────
//
// EventFeedRow is intentionally local to this file. It carries no
// dependency on the mission-event row component — the milestone-level
// rule forbids importing those types here. If a third feed lands we
// would extract a shared "feed row chrome" primitive at that point,
// not preemptively.

interface EventFeedRowProps {
  event: IncidentTimelineEvent;
  /** Override "now" for relative-time rendering — tests inject a fixed value. */
  nowMs?: number;
}

function EventFeedRow({ event, nowMs }: EventFeedRowProps): React.JSX.Element {
  const meta = TYPE_META[event.type] ?? FALLBACK_META;
  const tones = TONE_CLASSES[meta.tone];
  const Icon = meta.Icon;

  return (
    <li
      data-testid={`incident-timeline-row-${event.id}`}
      data-event-id={event.id}
      data-type={event.type}
      data-tone={meta.tone}
      className={cn(
        "incident-timeline-row flex items-start gap-3 px-3 py-2",
        "border-b divider-y last:border-b-0",
      )}
    >
      <span
        data-testid={`incident-timeline-icon-${event.id}`}
        data-icon={meta.iconLabel}
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          tones.bg,
        )}
      >
        <Icon className={cn("h-[14px] w-[14px]", tones.fg)} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            data-testid={`incident-timeline-label-${event.id}`}
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              tones.fg,
            )}
          >
            {meta.label}
          </span>
          <span
            data-testid={`incident-timeline-time-${event.id}`}
            className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
            title={parseServerTimestamp(event.at).toLocaleString()}
          >
            {formatRelativeTime(event.at, nowMs)}
          </span>
        </div>
        <p
          data-testid={`incident-timeline-body-${event.id}`}
          className="mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground/90"
        >
          {event.body}
        </p>
      </div>
    </li>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface IncidentTimelineProps {
  /** Events newest-first. The row order is preserved as-is. */
  events: IncidentTimelineEvent[];
  /**
   * Override "now" for relative-time rendering — passed through to each
   * row. Tests inject a fixed value so the rendered strings are
   * deterministic.
   */
  nowMs?: number;
  className?: string;
}

export function IncidentTimeline({
  events,
  nowMs,
  className,
}: IncidentTimelineProps): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div
        data-testid="incident-timeline-empty"
        className={cn(
          "rounded-lg border border-dashed bg-card/40 px-4 py-6 text-center",
          className,
        )}
      >
        <p className="text-[12px] text-muted-foreground">No timeline entries yet.</p>
      </div>
    );
  }

  return (
    <ul
      data-testid="incident-timeline"
      className={cn("flex flex-col rounded-lg border bg-card", className)}
    >
      {events.map((ev) => (
        <EventFeedRow key={ev.id} event={ev} nowMs={nowMs} />
      ))}
    </ul>
  );
}

export default IncidentTimeline;
