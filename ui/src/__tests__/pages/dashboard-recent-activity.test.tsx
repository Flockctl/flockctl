import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  RecentActivity,
  type RecentActivityItem,
} from "@/pages/dashboard-components/RecentActivity";

/**
 * Unit tests for the RecentActivity feed (slice 23-01 T02).
 *
 * The component is presentational — items in, JSX out — so the tests
 * exercise the prop contract directly:
 *   - empty state renders the "no recent activity" placeholder + still
 *     shows the header and See all button;
 *   - happy path renders one row per item with the correct title,
 *     detail, relative time, and tone-coded icon avatar;
 *   - the type → icon mapping is table-driven (one row per known type);
 *   - rows clamp to MAX_ROWS = 5 even when 7 are passed in;
 *   - clicking a row navigates to the item's href when provided;
 *   - clicking See all routes to the default `/attention` (or override).
 */

function renderInRouter(ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="*" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname + loc.search}</div>;
}

const FIXED_NOW = new Date("2026-05-07T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function isoMinutesAgo(minutes: number): string {
  return new Date(FIXED_NOW - minutes * 60 * 1000).toISOString();
}

describe("RecentActivity / empty state", () => {
  it("renders the 'no recent activity' placeholder when items is empty", () => {
    renderInRouter(<RecentActivity items={[]} />);
    expect(screen.getByTestId("recent-activity-empty").textContent).toBe(
      "No recent activity",
    );
    // Header + See all still present.
    expect(screen.getByTestId("recent-activity-header")).toBeTruthy();
    expect(screen.getByTestId("recent-activity-see-all")).toBeTruthy();
    // No list when empty.
    expect(screen.queryByTestId("recent-activity-list")).toBeNull();
  });
});

describe("RecentActivity / happy path", () => {
  it("renders title + detail + relative time for each row", () => {
    const items: RecentActivityItem[] = [
      {
        id: "task-1",
        type: "task_completed",
        title: "Add CodeEditor lazy chunk",
        detail: "flockctl · 1.2K tokens",
        timestamp: isoMinutesAgo(2),
      },
      {
        id: "chat-1",
        type: "chat_replied",
        title: "Question on retry semantics",
        detail: "Sonnet 4.6",
        timestamp: isoMinutesAgo(45),
      },
    ];

    renderInRouter(<RecentActivity items={items} />);

    expect(
      screen.getByTestId("recent-activity-title-task-1").textContent,
    ).toBe("Add CodeEditor lazy chunk");
    expect(
      screen.getByTestId("recent-activity-detail-task-1").textContent,
    ).toBe("flockctl · 1.2K tokens");
    expect(
      screen.getByTestId("recent-activity-time-task-1").textContent,
    ).toBe("2m ago");

    expect(
      screen.getByTestId("recent-activity-title-chat-1").textContent,
    ).toBe("Question on retry semantics");
    expect(
      screen.getByTestId("recent-activity-time-chat-1").textContent,
    ).toBe("45m ago");
  });

  it("omits the detail line when an item has no detail", () => {
    renderInRouter(
      <RecentActivity
        items={[
          {
            id: "task-2",
            type: "task_completed",
            title: "No detail row",
            timestamp: isoMinutesAgo(1),
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("recent-activity-detail-task-2")).toBeNull();
  });

  it("clamps to 5 rows even when more items are passed", () => {
    const items: RecentActivityItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `task-${i}`,
      type: "task_completed" as const,
      title: `Row ${i}`,
      timestamp: isoMinutesAgo(i),
    }));

    renderInRouter(<RecentActivity items={items} />);

    // First 5 are present, last two are dropped.
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`recent-activity-row-task-${i}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("recent-activity-row-task-5")).toBeNull();
    expect(screen.queryByTestId("recent-activity-row-task-6")).toBeNull();
  });
});

describe("RecentActivity / type → icon mapping", () => {
  it.each([
    ["task_completed", "check", "bg-emerald-500/10"],
    ["proposal_filed", "warn", "bg-amber-500/10"],
    ["chat_replied", "chat", "bg-indigo-500/10"],
    ["commit_pushed", "git", "bg-purple-500/10"],
    ["schedule_ran", "clock", "bg-zinc-500/10"],
  ] as const)(
    "%s → %s icon with %s background tint",
    (type, expectedIcon, expectedBg) => {
      renderInRouter(
        <RecentActivity
          items={[
            {
              id: "row",
              type: type as RecentActivityItem["type"],
              title: `${type} row`,
              timestamp: isoMinutesAgo(1),
            },
          ]}
        />,
      );

      const avatar = screen.getByTestId("recent-activity-icon-row");
      expect(avatar.getAttribute("data-icon")).toBe(expectedIcon);
      expect(avatar.className).toContain(expectedBg);
      // The avatar always carries the round / 28×28 base classes.
      expect(avatar.className).toContain("h-7");
      expect(avatar.className).toContain("w-7");
      expect(avatar.className).toContain("rounded-full");
    },
  );
});

describe("RecentActivity / navigation", () => {
  it("clicking a row navigates to the item's href when provided", () => {
    renderInRouter(
      <RecentActivity
        items={[
          {
            id: "task-42",
            type: "task_completed",
            title: "Deep link",
            timestamp: isoMinutesAgo(5),
            href: "/tasks/42",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("recent-activity-row-task-42"));
    expect(screen.getByTestId("navigated-to").textContent).toBe("/tasks/42");
  });

  it("clicking a row with no href is inert (no navigation)", () => {
    renderInRouter(
      <RecentActivity
        items={[
          {
            id: "task-43",
            type: "task_completed",
            title: "No href",
            timestamp: isoMinutesAgo(5),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("recent-activity-row-task-43"));
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });

  it("See all button defaults to /attention", () => {
    renderInRouter(<RecentActivity items={[]} />);
    fireEvent.click(screen.getByTestId("recent-activity-see-all"));
    expect(screen.getByTestId("navigated-to").textContent).toBe("/attention");
  });

  it("See all button respects a custom seeAllHref override", () => {
    renderInRouter(
      <RecentActivity items={[]} seeAllHref="/timeline?range=24h" />,
    );
    fireEvent.click(screen.getByTestId("recent-activity-see-all"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/timeline?range=24h",
    );
  });
});

describe("RecentActivity / relative time edge cases", () => {
  it("renders Ns / Nm / Nh / Nd buckets", () => {
    const items: RecentActivityItem[] = [
      {
        id: "s",
        type: "schedule_ran",
        title: "seconds",
        timestamp: new Date(FIXED_NOW - 30 * 1000).toISOString(),
      },
      {
        id: "m",
        type: "schedule_ran",
        title: "minutes",
        timestamp: new Date(FIXED_NOW - 5 * 60 * 1000).toISOString(),
      },
      {
        id: "h",
        type: "schedule_ran",
        title: "hours",
        timestamp: new Date(FIXED_NOW - 3 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "d",
        type: "schedule_ran",
        title: "days",
        timestamp: new Date(
          FIXED_NOW - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ];

    renderInRouter(<RecentActivity items={items} />);

    expect(screen.getByTestId("recent-activity-time-s").textContent).toBe(
      "30s ago",
    );
    expect(screen.getByTestId("recent-activity-time-m").textContent).toBe(
      "5m ago",
    );
    expect(screen.getByTestId("recent-activity-time-h").textContent).toBe(
      "3h ago",
    );
    expect(screen.getByTestId("recent-activity-time-d").textContent).toBe(
      "2d ago",
    );
  });
});
