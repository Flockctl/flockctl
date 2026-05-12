import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";

import {
  IncidentTimeline,
  formatRelativeTime,
  type IncidentTimelineEvent,
} from "@/pages/incident-detail-components/IncidentTimeline";

/**
 * IncidentTimeline tests.
 *
 * The timeline owns a LOCAL `<EventFeedRow>` and a LOCAL
 * `IncidentTimelineEvent` type. The milestone-level rule for slice
 * 25-incidents forbids importing mission types here — these tests both
 * exercise the renderer and lock in the no-coupling invariant via a
 * source-text scan that fails CI if anyone re-imports `MissionEvent`
 * or `MissionEventRow` from `mission-detail-components/`.
 *
 * Time is frozen so relative-time strings are deterministic.
 */

const FIXTURE_NOW_MS = Date.UTC(2026, 4, 7, 12, 0, 0); // 2026-05-07T12:00:00Z

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeEvent(
  overrides: Partial<IncidentTimelineEvent> = {},
): IncidentTimelineEvent {
  return {
    id: "e-1",
    type: "cause",
    body: "Disk filled up to 99% during nightly backup.",
    at: new Date(FIXTURE_NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ─── No coupling to mission types (milestone-level invariant) ──────────────

describe("IncidentTimeline / no coupling to mission types", () => {
  it("does not import MissionEvent or MissionEventRow from mission-detail-components", () => {
    const componentPath = resolve(
      __dirname,
      "../../pages/incident-detail-components/IncidentTimeline.tsx",
    );
    const src = readFileSync(componentPath, "utf8");
    // Tight: any import line that mentions mission-detail-components is a regression.
    expect(src).not.toMatch(/from\s+["'][^"']*mission-detail-components[^"']*["']/);
    // Also defensive — no MissionEvent/MissionEventRow tokens anywhere.
    expect(src).not.toMatch(/\bMissionEvent\b/);
    expect(src).not.toMatch(/\bMissionEventRow\b/);
  });

  it("ships a local EventFeedRow definition inside IncidentTimeline.tsx", () => {
    const componentPath = resolve(
      __dirname,
      "../../pages/incident-detail-components/IncidentTimeline.tsx",
    );
    const src = readFileSync(componentPath, "utf8");
    expect(src).toMatch(/function\s+EventFeedRow\b/);
  });
});

// ─── Per-type tone + icon table (cause / action / resolution) ──────────────

describe("IncidentTimeline / distinct event types", () => {
  const cases = [
    {
      type: "cause" as const,
      expectedTone: "amber",
      expectedIcon: "alert",
      expectedLabel: "CAUSE",
    },
    {
      type: "action" as const,
      expectedTone: "indigo",
      expectedIcon: "wrench",
      expectedLabel: "ACTION",
    },
    {
      type: "resolution" as const,
      expectedTone: "emerald",
      expectedIcon: "check",
      expectedLabel: "RESOLUTION",
    },
  ];

  for (const c of cases) {
    it(`renders ${c.type} with tone=${c.expectedTone}, icon=${c.expectedIcon}, label=${c.expectedLabel}`, () => {
      render(
        <IncidentTimeline
          events={[makeEvent({ id: "e-x", type: c.type })]}
          nowMs={FIXTURE_NOW_MS}
        />,
      );
      const row = screen.getByTestId("incident-timeline-row-e-x");
      expect(row.getAttribute("data-type")).toBe(c.type);
      expect(row.getAttribute("data-tone")).toBe(c.expectedTone);

      const icon = screen.getByTestId("incident-timeline-icon-e-x");
      expect(icon.getAttribute("data-icon")).toBe(c.expectedIcon);

      const label = screen.getByTestId("incident-timeline-label-e-x");
      expect(label.textContent).toBe(c.expectedLabel);
    });
  }

  it("each of the three event types yields a distinct icon (no duplicates)", () => {
    const icons = cases.map((c) => c.expectedIcon);
    const unique = new Set(icons);
    expect(unique.size).toBe(icons.length);
  });
});

// ─── Row contract: tone-icon + label + body + time ─────────────────────────

describe("IncidentTimeline / row contract", () => {
  it("renders the body text", () => {
    render(
      <IncidentTimeline
        events={[
          makeEvent({
            id: "e-body",
            body: "Operator restarted the worker pool.",
          }),
        ]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    expect(
      screen.getByTestId("incident-timeline-body-e-body").textContent,
    ).toBe("Operator restarted the worker pool.");
  });

  it("renders the relative time string", () => {
    render(
      <IncidentTimeline
        events={[
          makeEvent({
            id: "e-time",
            at: new Date(FIXTURE_NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
          }),
        ]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    expect(
      screen.getByTestId("incident-timeline-time-e-time").textContent,
    ).toBe("2h ago");
  });

  it("renders all four row slots — icon, label, body, time", () => {
    render(
      <IncidentTimeline
        events={[makeEvent({ id: "e-slots" })]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    expect(screen.getByTestId("incident-timeline-icon-e-slots")).toBeTruthy();
    expect(screen.getByTestId("incident-timeline-label-e-slots")).toBeTruthy();
    expect(screen.getByTestId("incident-timeline-body-e-slots")).toBeTruthy();
    expect(screen.getByTestId("incident-timeline-time-e-slots")).toBeTruthy();
  });

  it("preserves multi-line bodies via whitespace-pre-wrap", () => {
    render(
      <IncidentTimeline
        events={[makeEvent({ id: "e-multi", body: "line 1\nline 2" })]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    const body = screen.getByTestId("incident-timeline-body-e-multi");
    expect(body.className).toContain("whitespace-pre-wrap");
    expect(body.textContent).toBe("line 1\nline 2");
  });
});

// ─── List behaviour ────────────────────────────────────────────────────────

describe("IncidentTimeline / list rendering", () => {
  it("preserves the input ordering (newest-first contract)", () => {
    const events: IncidentTimelineEvent[] = [
      makeEvent({
        id: "e-a",
        type: "resolution",
        body: "Patched the cron config.",
        at: new Date(FIXTURE_NOW_MS - 60_000).toISOString(),
      }),
      makeEvent({
        id: "e-b",
        type: "action",
        body: "Bumped disk to 200GB.",
        at: new Date(FIXTURE_NOW_MS - 30 * 60_000).toISOString(),
      }),
      makeEvent({
        id: "e-c",
        type: "cause",
        body: "Cron filled the disk.",
        at: new Date(FIXTURE_NOW_MS - 60 * 60_000).toISOString(),
      }),
    ];
    render(<IncidentTimeline events={events} nowMs={FIXTURE_NOW_MS} />);

    const rows = screen
      .getAllByTestId(/^incident-timeline-row-/)
      .map((el) => el.getAttribute("data-event-id"));
    expect(rows).toEqual(["e-a", "e-b", "e-c"]);
  });

  it("renders an empty placeholder when there are no events", () => {
    render(<IncidentTimeline events={[]} nowMs={FIXTURE_NOW_MS} />);
    expect(screen.getByTestId("incident-timeline-empty")).toBeTruthy();
    expect(screen.queryByTestId("incident-timeline")).toBeNull();
  });
});

// ─── Helper: relative-time formatter ───────────────────────────────────────

describe("formatRelativeTime", () => {
  it("renders < 60s as Ns ago", () => {
    expect(
      formatRelativeTime(
        new Date(FIXTURE_NOW_MS - 12_000).toISOString(),
        FIXTURE_NOW_MS,
      ),
    ).toBe("12s ago");
  });

  it("renders minutes / hours / days", () => {
    expect(
      formatRelativeTime(
        new Date(FIXTURE_NOW_MS - 5 * 60_000).toISOString(),
        FIXTURE_NOW_MS,
      ),
    ).toBe("5m ago");
    expect(
      formatRelativeTime(
        new Date(FIXTURE_NOW_MS - 3 * 60 * 60_000).toISOString(),
        FIXTURE_NOW_MS,
      ),
    ).toBe("3h ago");
    expect(
      formatRelativeTime(
        new Date(FIXTURE_NOW_MS - 4 * 24 * 60 * 60_000).toISOString(),
        FIXTURE_NOW_MS,
      ),
    ).toBe("4d ago");
  });

  it("renders an em-dash for unparseable inputs", () => {
    expect(formatRelativeTime("not-a-date", FIXTURE_NOW_MS)).toBe("—");
  });
});
