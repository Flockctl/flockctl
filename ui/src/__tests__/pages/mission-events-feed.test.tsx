import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { render, screen } from "@testing-library/react";

import {
  MissionEventsFeed,
  groupEventsByDay,
  VIRTUALIZE_THRESHOLD,
} from "@/pages/mission-detail-components/MissionEventsFeed";
import {
  MissionEventRow,
  KIND_RENDERERS,
  __resetWarnedKindsForTest,
} from "@/pages/mission-detail-components/MissionEventRow";
import {
  FIXTURE_NOW_MS,
  missionEventFixtures,
  allMissionEventFixtures,
  missionStartedFixture,
  taskObservedFixture,
  proposalFiledFixture,
  proposalAcceptedFixture,
  proposalRejectedFixture,
  budgetWarningFixture,
  budgetExceededFixture,
  depthWarningFixture,
  missionCompletedFixture,
  unknownKindFixture,
} from "@/__tests__/fixtures/mission-events";
import type { MissionEvent } from "@/lib/hooks/missions";

/**
 * Slice 24-01 / T02 — MissionEventsFeed + MissionEventRow tests.
 *
 * Negative-tests checklist (slice 02-events-feed-and-row-renderer.md):
 *   - all 9 variants render with non-empty title + body (table-driven)
 *   - unknown kind renders fallback + console.warn
 *   - events spanning 3 days render 3 day-headers
 *
 * The render path is presentational — no react-query, no router — so
 * we render the components directly and assert on data-testid hooks.
 *
 * Time is frozen at `FIXTURE_NOW_MS` so relative-time strings are
 * deterministic across runs.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW_MS);
  __resetWarnedKindsForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Table-driven: all 9 first-class variants ───────────────────────────────

describe("MissionEventRow / per-kind renderer table", () => {
  // Tone + icon expectations come straight from the slice goal-block
  // (`02-events-feed-and-row-renderer.md` lines 39–47).
  const cases: ReadonlyArray<{
    name: string;
    fixture: MissionEvent;
    expectedTone: string;
    expectedIcon: string;
    /** A substring that must appear in the rendered title text. */
    titleIncludes: string;
  }> = [
    {
      name: "mission_started",
      fixture: missionStartedFixture,
      expectedTone: "indigo",
      expectedIcon: "target",
      titleIncludes: "Mission started",
    },
    {
      name: "task_observed",
      fixture: taskObservedFixture,
      expectedTone: "indigo",
      expectedIcon: "zap",
      titleIncludes: "Task observed",
    },
    {
      name: "proposal_filed",
      fixture: proposalFiledFixture,
      expectedTone: "amber",
      expectedIcon: "alert",
      titleIncludes: "Supervisor proposed",
    },
    {
      name: "proposal_accepted",
      fixture: proposalAcceptedFixture,
      expectedTone: "emerald",
      expectedIcon: "check",
      titleIncludes: "Proposal accepted",
    },
    {
      name: "proposal_rejected",
      fixture: proposalRejectedFixture,
      expectedTone: "zinc",
      expectedIcon: "x",
      titleIncludes: "Proposal rejected",
    },
    {
      name: "budget_warning",
      fixture: budgetWarningFixture,
      expectedTone: "amber",
      expectedIcon: "alert",
      titleIncludes: "Budget warning",
    },
    {
      name: "budget_exceeded",
      fixture: budgetExceededFixture,
      expectedTone: "red",
      expectedIcon: "coins",
      titleIncludes: "Budget exceeded",
    },
    {
      name: "depth_warning",
      fixture: depthWarningFixture,
      expectedTone: "amber",
      expectedIcon: "layers",
      titleIncludes: "Depth warning",
    },
    {
      name: "mission_completed",
      fixture: missionCompletedFixture,
      expectedTone: "emerald",
      expectedIcon: "trophy",
      titleIncludes: "Mission completed",
    },
  ];

  it("KIND_RENDERERS table covers all 9 first-class kinds", () => {
    expect(Object.keys(KIND_RENDERERS).sort()).toEqual(
      cases.map((c) => c.name).sort(),
    );
  });

  it.each(cases)(
    "$name → tone=$expectedTone, icon=$expectedIcon, title contains '$titleIncludes', non-empty body",
    ({ fixture, expectedTone, expectedIcon, titleIncludes }) => {
      render(
        <ul>
          <MissionEventRow event={fixture} nowMs={FIXTURE_NOW_MS} />
        </ul>,
      );

      const row = screen.getByTestId(`mission-event-row-${fixture.id}`);
      expect(row.getAttribute("data-kind")).toBe(fixture.kind);
      expect(row.getAttribute("data-tone")).toBe(expectedTone);

      const icon = screen.getByTestId(`mission-event-icon-${fixture.id}`);
      expect(icon.getAttribute("data-icon")).toBe(expectedIcon);

      const title = screen.getByTestId(`mission-event-title-${fixture.id}`);
      expect(title.textContent).toContain(titleIncludes);
      expect(title.textContent?.length ?? 0).toBeGreaterThan(0);

      // Every first-class renderer ships a non-empty body.
      const body = screen.getByTestId(`mission-event-body-${fixture.id}`);
      expect(body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    },
  );
});

// ─── Footer link on proposal_filed only ─────────────────────────────────────

describe("MissionEventRow / proposal_filed footer link", () => {
  it("renders 'View proposal →' anchor pointing at #proposals-queue", () => {
    render(
      <ul>
        <MissionEventRow event={proposalFiledFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );
    const link = screen.getByTestId("mission-event-footer-link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#proposals-queue");
    expect(link.textContent).toContain("View proposal");
  });

  it("does NOT render a footer link for kinds that lack one", () => {
    render(
      <ul>
        <MissionEventRow event={missionStartedFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );
    expect(screen.queryByTestId("mission-event-footer-link")).toBeNull();
  });
});

// ─── Unknown kind: fallback + console.warn ──────────────────────────────────

describe("MissionEventRow / unknown kind fallback", () => {
  it("renders the neutral fallback row and warns to the console", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ul>
        <MissionEventRow event={unknownKindFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );

    const row = screen.getByTestId(`mission-event-row-${unknownKindFixture.id}`);
    // Fallback paints the zinc tone + help icon.
    expect(row.getAttribute("data-tone")).toBe("zinc");
    const icon = screen.getByTestId(`mission-event-icon-${unknownKindFixture.id}`);
    expect(icon.getAttribute("data-icon")).toBe("help");

    // Title shows the raw kind so an operator can grep.
    const title = screen.getByTestId(`mission-event-title-${unknownKindFixture.id}`);
    expect(title.textContent).toContain(unknownKindFixture.kind);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("unknown event kind");
    expect(warnSpy.mock.calls[0]?.[0]).toContain(unknownKindFixture.kind);

    warnSpy.mockRestore();
  });

  it("memoises the warning so a re-render of the same kind only logs once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { rerender } = render(
      <ul>
        <MissionEventRow event={unknownKindFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );
    rerender(
      <ul>
        <MissionEventRow event={unknownKindFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// ─── data-fresh attribute (SSE animation hook) ──────────────────────────────

describe("MissionEventRow / SSE animation hook", () => {
  it("sets data-fresh='true' when isFresh is passed", () => {
    render(
      <ul>
        <MissionEventRow
          event={missionStartedFixture}
          nowMs={FIXTURE_NOW_MS}
          isFresh
        />
      </ul>,
    );
    const row = screen.getByTestId(
      `mission-event-row-${missionStartedFixture.id}`,
    );
    expect(row.getAttribute("data-fresh")).toBe("true");
    expect(row.className).toContain("mission-event-row");
  });

  it("omits data-fresh when isFresh is undefined / false", () => {
    render(
      <ul>
        <MissionEventRow event={missionStartedFixture} nowMs={FIXTURE_NOW_MS} />
      </ul>,
    );
    const row = screen.getByTestId(
      `mission-event-row-${missionStartedFixture.id}`,
    );
    expect(row.getAttribute("data-fresh")).toBeNull();
  });
});

// ─── Day-grouping: events spanning 3 days render 3 day-headers ──────────────

describe("MissionEventsFeed / day grouping", () => {
  it("groups events by calendar day and renders one sticky header per group", () => {
    // Fixtures span 3 calendar days by construction (see fixture file).
    render(
      <MissionEventsFeed
        events={[...missionEventFixtures]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );

    // Confirm we have a "Today" header (the most-recent group).
    expect(screen.getByText("Today")).toBeTruthy();

    // Every day-header carries a `mission-events-day-header-<key>` testid.
    const headers = document.querySelectorAll(
      '[data-testid^="mission-events-day-header-"]',
    );
    expect(headers.length).toBeGreaterThanOrEqual(3);
    expect(headers.length).toBe(
      groupEventsByDay([...missionEventFixtures], FIXTURE_NOW_MS).length,
    );
  });

  it("groupEventsByDay returns groups in newest-first order with stable per-day buckets", () => {
    const groups = groupEventsByDay(
      [...missionEventFixtures],
      FIXTURE_NOW_MS,
    );
    // Newest-first input ⇒ first group covers "today".
    expect(groups[0]?.label).toBe("Today");
    // Each event appears in exactly one group.
    const seen = new Set<string>();
    for (const g of groups) {
      for (const ev of g.events) {
        expect(seen.has(ev.id)).toBe(false);
        seen.add(ev.id);
      }
    }
    expect(seen.size).toBe(missionEventFixtures.length);
  });

  it("returns an empty group list for an empty events array", () => {
    expect(groupEventsByDay([], FIXTURE_NOW_MS)).toEqual([]);
  });
});

// ─── Empty + loading states ─────────────────────────────────────────────────

describe("MissionEventsFeed / empty + loading", () => {
  it("renders the skeleton placeholder when isLoading and events is empty", () => {
    render(<MissionEventsFeed events={[]} isLoading nowMs={FIXTURE_NOW_MS} />);
    expect(screen.getByTestId("mission-events-feed-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("mission-events-feed-empty")).toBeNull();
  });

  it("renders the EmptyState when events is empty and not loading", () => {
    render(<MissionEventsFeed events={[]} nowMs={FIXTURE_NOW_MS} />);
    expect(screen.getByTestId("mission-events-feed-empty")).toBeTruthy();
    expect(screen.queryByTestId("mission-events-feed-skeleton")).toBeNull();
  });
});

// ─── Virtualization threshold ───────────────────────────────────────────────

describe("MissionEventsFeed / virtualization threshold", () => {
  it("renders the grouped (non-virtualised) path at or below the threshold", () => {
    render(
      <MissionEventsFeed
        events={[...missionEventFixtures]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    expect(screen.getByTestId("mission-events-feed-grouped")).toBeTruthy();
    expect(screen.queryByTestId("mission-events-feed-virtualised")).toBeNull();
  });

  it("switches to the virtualised path above the threshold", () => {
    // Build > 100 events by repeating fixtures with unique ids.
    const many: MissionEvent[] = [];
    for (let i = 0; i <= VIRTUALIZE_THRESHOLD + 5; i++) {
      const base = missionEventFixtures[i % missionEventFixtures.length]!;
      many.push({
        ...base,
        id: `dup-${i}`,
        // Spread across different timestamps so day-grouping still works.
        created_at: base.created_at - i * 60,
      });
    }
    render(<MissionEventsFeed events={many} nowMs={FIXTURE_NOW_MS} />);
    expect(screen.getByTestId("mission-events-feed-virtualised")).toBeTruthy();
    expect(screen.queryByTestId("mission-events-feed-grouped")).toBeNull();
  });
});

// ─── Fresh-event ids feed-through ───────────────────────────────────────────

describe("MissionEventsFeed / freshEventIds passthrough", () => {
  it("forwards data-fresh='true' to rows whose id is in freshEventIds", () => {
    const fresh = new Set([proposalFiledFixture.id]);
    render(
      <MissionEventsFeed
        events={[...missionEventFixtures]}
        freshEventIds={fresh}
        nowMs={FIXTURE_NOW_MS}
      />,
    );
    const freshRow = screen.getByTestId(
      `mission-event-row-${proposalFiledFixture.id}`,
    );
    expect(freshRow.getAttribute("data-fresh")).toBe("true");

    // A non-listed row stays unmarked.
    const staleRow = screen.getByTestId(
      `mission-event-row-${missionStartedFixture.id}`,
    );
    expect(staleRow.getAttribute("data-fresh")).toBeNull();
  });
});

// ─── allMissionEventFixtures sanity (drives the unknown-kind path too) ─────

describe("MissionEventsFeed / mixed first-class + unknown kinds", () => {
  it("renders every fixture (including the unknown kind) without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <MissionEventsFeed
        events={[...allMissionEventFixtures]}
        nowMs={FIXTURE_NOW_MS}
      />,
    );

    for (const ev of allMissionEventFixtures) {
      expect(screen.getByTestId(`mission-event-row-${ev.id}`)).toBeTruthy();
    }

    // The unknown-kind warning fires exactly once.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
