import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  ActiveMissionCard,
  type ActiveMissionSummary,
} from "@/pages/dashboard-components/ActiveMissionCard";

/**
 * Unit tests for ActiveMissionCard (slice 23-01 T03).
 *
 * The component is presentational — `mission` prop in, JSX out — so the
 * tests cover the prop contract directly:
 *   - empty state renders the `Start a mission` CTA + invokes the
 *     `onStartMission` callback (mission-create dialog wired by parent);
 *   - active state renders objective + `X of Y slices done · N proposals
 *     waiting` + a gradient progress bar + a `Review proposals →`
 *     button that navigates to `/missions/{id}`;
 *   - progress bar fill ratio matches `slicesDone / slicesTotal` and
 *     clamps to `[0, 100]` (and 0/0 renders 0 % with no NaN).
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

const SAMPLE_MISSION: ActiveMissionSummary = {
  id: "mis_42",
  objective: "Ship the M22 dashboard redesign with parity baselines.",
  slicesDone: 4,
  slicesTotal: 9,
  pendingProposals: 3,
};

describe("ActiveMissionCard / empty state", () => {
  it("renders the Start a mission CTA when mission is null", () => {
    renderInRouter(<ActiveMissionCard mission={null} />);
    expect(screen.getByTestId("active-mission-card").getAttribute("data-state")).toBe(
      "empty",
    );
    expect(screen.getByTestId("active-mission-start-button").textContent).toContain(
      "Start a mission",
    );
    // Active-state slots must NOT render in the empty state.
    expect(screen.queryByTestId("active-mission-progress")).toBeNull();
    expect(screen.queryByTestId("active-mission-review-button")).toBeNull();
  });

  it("renders the empty state when mission is undefined", () => {
    renderInRouter(<ActiveMissionCard />);
    expect(screen.getByTestId("active-mission-card").getAttribute("data-state")).toBe(
      "empty",
    );
  });

  it("clicking Start a mission invokes onStartMission", () => {
    const onStart = vi.fn();
    renderInRouter(<ActiveMissionCard mission={null} onStartMission={onStart} />);
    fireEvent.click(screen.getByTestId("active-mission-start-button"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("clicking Start a mission without a handler is inert (no error)", () => {
    renderInRouter(<ActiveMissionCard mission={null} />);
    expect(() =>
      fireEvent.click(screen.getByTestId("active-mission-start-button")),
    ).not.toThrow();
  });
});

describe("ActiveMissionCard / active state", () => {
  it("renders objective + progress label + gradient bar + review button", () => {
    renderInRouter(<ActiveMissionCard mission={SAMPLE_MISSION} />);

    expect(screen.getByTestId("active-mission-card").getAttribute("data-state")).toBe(
      "active",
    );
    expect(screen.getByTestId("active-mission-objective").textContent).toBe(
      SAMPLE_MISSION.objective,
    );
    expect(screen.getByTestId("active-mission-progress-label").textContent).toBe(
      "4 of 9 slices done · 3 proposals waiting",
    );

    const bar = screen.getByTestId("active-mission-progress");
    expect(bar.getAttribute("data-tone")).toBe("gradient");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuemax")).toBe("9");

    // Inner fill width matches slicesDone / slicesTotal × 100.
    const fill = bar.firstElementChild as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe(`${(4 / 9) * 100}%`);
    expect(fill!.className).toContain("from-indigo-400");
    expect(fill!.className).toContain("to-indigo-600");

    // Review button copy.
    expect(screen.getByTestId("active-mission-review-button").textContent).toContain(
      "Review proposals",
    );
  });

  it("pluralises proposals: 1 proposal waiting (singular)", () => {
    renderInRouter(
      <ActiveMissionCard
        mission={{ ...SAMPLE_MISSION, pendingProposals: 1 }}
      />,
    );
    expect(screen.getByTestId("active-mission-progress-label").textContent).toBe(
      "4 of 9 slices done · 1 proposal waiting",
    );
  });

  it("renders 0 of 0 with 0% width when no slices yet (no NaN)", () => {
    renderInRouter(
      <ActiveMissionCard
        mission={{
          ...SAMPLE_MISSION,
          slicesDone: 0,
          slicesTotal: 0,
          pendingProposals: 0,
        }}
      />,
    );
    expect(screen.getByTestId("active-mission-progress-label").textContent).toBe(
      "0 of 0 slices done · 0 proposals waiting",
    );
    const fill = screen
      .getByTestId("active-mission-progress")
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("clamps over-100% progress to 100% width", () => {
    renderInRouter(
      <ActiveMissionCard
        mission={{ ...SAMPLE_MISSION, slicesDone: 12, slicesTotal: 9 }}
      />,
    );
    const fill = screen
      .getByTestId("active-mission-progress")
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("clicking Review proposals navigates to /missions/{id}", () => {
    renderInRouter(<ActiveMissionCard mission={SAMPLE_MISSION} />);
    fireEvent.click(screen.getByTestId("active-mission-review-button"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      `/missions/${SAMPLE_MISSION.id}`,
    );
  });

  it("does not render the empty-state CTA in active state", () => {
    renderInRouter(<ActiveMissionCard mission={SAMPLE_MISSION} />);
    expect(screen.queryByTestId("active-mission-start-button")).toBeNull();
    expect(screen.queryByTestId("active-mission-empty-pitch")).toBeNull();
  });
});
