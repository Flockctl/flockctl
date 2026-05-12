import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { FlatCard } from "@/components/design";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import type { MissionEvent } from "@/lib/hooks/missions";

import { MissionEventRow } from "./MissionEventRow";

/**
 * MissionEventsFeed — supervisor timeline (slice 24-01 / T02).
 *
 * Renders a newest-first list of `MissionEvent` rows grouped by calendar
 * day in the user's local timezone, with a sticky day-header per group.
 * The header itself is a 2-line stub (`TODAY` / `MAY 6` / `MAY 5` etc.)
 * so a multi-day mission feels chronological at a glance.
 *
 * Live-overlay animation
 * ----------------------
 * The parent page passes the freshly-arrived event ids via
 * {@link MissionEventsFeedProps.freshEventIds}. Rows whose id is in that
 * set carry `data-fresh="true"` which triggers the slide+fade keyframe
 * defined in `index.css`. The set is computed by the parent (the feed
 * itself stays presentational); a typical implementation diffs the
 * current event list against the previous one inside `useMissionEvents`
 * and stores newly-prepended ids in a short-lived ref.
 *
 * Virtualization
 * --------------
 * For missions with > {@link VIRTUALIZE_THRESHOLD} events we mount the
 * `@tanstack/react-virtual` row virtualizer to keep the visible-row
 * cost flat. Below the threshold we render the rows directly — sticky
 * day-headers compose more naturally with vanilla DOM and the cost is
 * negligible. The threshold is exported for the test suite.
 */

/** Row count above which we engage `@tanstack/react-virtual`. */
export const VIRTUALIZE_THRESHOLD = 100;

/** Estimated row height in px — used by the virtualizer's `estimateSize`. */
const ESTIMATED_ROW_HEIGHT = 84;

export interface MissionEventsFeedProps {
  /**
   * Events newest-first. Same ordering invariant as the wire shape from
   * `useMissionEvents`.
   */
  events: MissionEvent[];
  /**
   * Set of event ids that arrived via the live WS overlay (vs. the
   * canonical GET). Each row in the set animates in once via the
   * `data-fresh` keyframe; subsequent renders no-op. Pass an empty set
   * (or omit) when SSE is unavailable.
   */
  freshEventIds?: ReadonlySet<string>;
  /** Render skeleton placeholders when the initial fetch hasn't returned. */
  isLoading?: boolean;
  /**
   * Override "now" for relative-time rendering — passed through to
   * {@link MissionEventRow}. Tests inject a fixed value so the rendered
   * row strings are deterministic.
   */
  nowMs?: number;
  /** Extra classes merged onto the outer card. */
  className?: string;
}

interface DayGroup {
  /** ISO date key like `"2026-05-07"`; used for the sticky header label. */
  dayKey: string;
  /** Display label for the day. `Today` / `Yesterday` / `Mon May 5`. */
  label: string;
  events: MissionEvent[];
}

/**
 * Group an already-newest-first events array into per-day buckets.
 * Each bucket's events stay in the original (newest-first) order so a
 * day with many heartbeats reads top-down chronologically inside the
 * group, matching the global ordering.
 *
 * Returns an array of groups in the same newest-first order as the input
 * so the first group displayed is "Today" / the most-recent day.
 */
export function groupEventsByDay(
  events: MissionEvent[],
  nowMs = Date.now(),
): DayGroup[] {
  if (events.length === 0) return [];
  const groups: DayGroup[] = [];
  const indexByKey = new Map<string, number>();
  const todayKey = toDayKey(nowMs);
  const yesterdayKey = toDayKey(nowMs - 24 * 60 * 60 * 1000);
  for (const ev of events) {
    const key = toDayKey(ev.created_at * 1000);
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      groups[existing]!.events.push(ev);
    } else {
      indexByKey.set(key, groups.length);
      groups.push({
        dayKey: key,
        label: dayLabel(key, todayKey, yesterdayKey),
        events: [ev],
      });
    }
  }
  return groups;
}

function toDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function dayLabel(
  dayKey: string,
  todayKey: string,
  yesterdayKey: string,
): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === yesterdayKey) return "Yesterday";
  // dayKey is `YYYY-MM-DD` — parse without timezone shifts.
  const [yStr, mStr, dStr] = dayKey.split("-");
  const y = Number(yStr ?? 0);
  const m = Number(mStr ?? 1) - 1;
  const d = Number(dStr ?? 1);
  return new Date(y, m, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MissionEventsFeed({
  events,
  freshEventIds,
  isLoading,
  nowMs,
  className,
}: MissionEventsFeedProps): React.JSX.Element {
  if (isLoading && events.length === 0) {
    return (
      <div data-testid="mission-events-feed">
        <FlatCard className={cn("flex flex-col", className)}>
          <ul data-testid="mission-events-feed-skeleton" className="px-3 py-2">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="py-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted/60" />
                <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted/40" />
              </li>
            ))}
          </ul>
        </FlatCard>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div data-testid="mission-events-feed">
        <FlatCard className={cn("flex flex-col", className)}>
          <div data-testid="mission-events-feed-empty" className="py-10">
            <EmptyState
              title="No events yet"
              description="Events appear here as the supervisor proposes, approves, or executes work."
            />
          </div>
        </FlatCard>
      </div>
    );
  }

  const useVirtual = events.length > VIRTUALIZE_THRESHOLD;

  return (
    <div data-testid="mission-events-feed">
      <FlatCard className={cn("flex flex-col", className)}>
        {useVirtual ? (
          <VirtualisedFeed
            events={events}
            freshEventIds={freshEventIds}
            nowMs={nowMs}
          />
        ) : (
          <GroupedFeed
            events={events}
            freshEventIds={freshEventIds}
            nowMs={nowMs}
          />
        )}
      </FlatCard>
    </div>
  );
}

// ─── Non-virtualised path: day-grouped list with sticky headers ─────────────

function GroupedFeed({
  events,
  freshEventIds,
  nowMs,
}: {
  events: MissionEvent[];
  freshEventIds?: ReadonlySet<string>;
  nowMs?: number;
}): React.JSX.Element {
  const groups = React.useMemo(
    () => groupEventsByDay(events, nowMs),
    [events, nowMs],
  );
  return (
    <div
      data-testid="mission-events-feed-grouped"
      data-virtualised="false"
      className="flex flex-col"
    >
      {groups.map((group) => (
        <section key={group.dayKey} data-testid={`mission-events-day-${group.dayKey}`}>
          <header
            data-testid={`mission-events-day-header-${group.dayKey}`}
            className={cn(
              "sticky top-0 z-10 px-4 py-1.5",
              "bg-card/90 backdrop-blur",
              "text-[11px] uppercase tracking-wider text-muted-foreground",
              "border-b divider-y",
            )}
          >
            {group.label}
          </header>
          <ul>
            {group.events.map((ev) => (
              <MissionEventRow
                key={ev.id}
                event={ev}
                isFresh={freshEventIds?.has(ev.id)}
                nowMs={nowMs}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Virtualised path: flattened, day-headers inlined as virtual rows ───────
//
// For >100 events we flatten the grouped list into a single mixed array
// of `header` and `event` items, then virtualise that. Sticky headers
// stop being native CSS-sticky in this mode (the virtualizer's absolute
// positioning would hide them); we settle for non-sticky headers in
// that range, which still reads as day-grouped because the visible
// window is small. The trade-off is documented in the slice 24-01 audit.

interface FlatItem {
  type: "header" | "event";
  /** Stable key for React. */
  key: string;
  group?: DayGroup;
  event?: MissionEvent;
}

function VirtualisedFeed({
  events,
  freshEventIds,
  nowMs,
}: {
  events: MissionEvent[];
  freshEventIds?: ReadonlySet<string>;
  nowMs?: number;
}): React.JSX.Element {
  const flat = React.useMemo<FlatItem[]>(() => {
    const groups = groupEventsByDay(events, nowMs);
    const out: FlatItem[] = [];
    for (const g of groups) {
      out.push({ type: "header", key: `h-${g.dayKey}`, group: g });
      for (const ev of g.events) {
        out.push({ type: "event", key: ev.id, event: ev });
      }
    }
    return out;
  }, [events, nowMs]);

  const parentRef = React.useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: flat.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      flat[index]?.type === "header" ? 28 : ESTIMATED_ROW_HEIGHT,
    overscan: 6,
  });

  return (
    <div
      ref={parentRef}
      data-testid="mission-events-feed-virtualised"
      data-virtualised="true"
      className="max-h-[640px] overflow-y-auto"
    >
      <div
        style={{
          height: virt.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virt.getVirtualItems().map((vrow) => {
          const item = flat[vrow.index];
          if (!item) return null;
          return (
            <div
              key={item.key}
              data-virtual-index={vrow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vrow.start}px)`,
              }}
            >
              {item.type === "header" && item.group ? (
                <header
                  data-testid={`mission-events-day-header-${item.group.dayKey}`}
                  className={cn(
                    "px-4 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground",
                    "border-b divider-y bg-card",
                  )}
                >
                  {item.group.label}
                </header>
              ) : item.event ? (
                <ul>
                  <MissionEventRow
                    event={item.event}
                    isFresh={freshEventIds?.has(item.event.id)}
                    nowMs={nowMs}
                  />
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MissionEventsFeed;
