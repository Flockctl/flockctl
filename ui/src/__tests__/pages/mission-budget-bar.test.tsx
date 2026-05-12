import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  MissionBudgetBar,
  pickMissionBudgetTone,
} from "@/pages/mission-detail-components/MissionBudgetBar";

/**
 * Unit tests for {@link MissionBudgetBar} (slice 24/01 T01).
 *
 * The bar is purely presentational: tone-by-threshold + clamped
 * fill width. The bulk of the surface area is the three-tone
 * threshold contract (`<70% indigo / 70-90% amber / >90% red`),
 * which we exercise via both the pure picker and the rendered
 * component for redundancy.
 */

describe("pickMissionBudgetTone", () => {
  it("returns indigo below 70%", () => {
    expect(pickMissionBudgetTone(0, 100)).toBe("indigo");
    expect(pickMissionBudgetTone(50, 100)).toBe("indigo");
    expect(pickMissionBudgetTone(69.99, 100)).toBe("indigo");
  });

  it("returns amber at the 70% boundary (inclusive)", () => {
    expect(pickMissionBudgetTone(70, 100)).toBe("amber");
  });

  it("returns amber across the 70%-90% band", () => {
    expect(pickMissionBudgetTone(75, 100)).toBe("amber");
    expect(pickMissionBudgetTone(85, 100)).toBe("amber");
    expect(pickMissionBudgetTone(90, 100)).toBe("amber");
  });

  it("returns red above 90%", () => {
    expect(pickMissionBudgetTone(90.01, 100)).toBe("red");
    expect(pickMissionBudgetTone(95, 100)).toBe("red");
    expect(pickMissionBudgetTone(100, 100)).toBe("red");
    expect(pickMissionBudgetTone(150, 100)).toBe("red");
  });

  it("returns indigo when budget is 0 / negative / non-finite", () => {
    expect(pickMissionBudgetTone(50, 0)).toBe("indigo");
    expect(pickMissionBudgetTone(50, -10)).toBe("indigo");
    expect(pickMissionBudgetTone(NaN, 100)).toBe("indigo");
    expect(pickMissionBudgetTone(50, Infinity)).toBe("indigo");
  });
});

describe("MissionBudgetBar / rendering", () => {
  it("renders a track with role=progressbar", () => {
    render(<MissionBudgetBar used={50} budget={100} ariaLabel="USD" />);
    const bar = screen.getByTestId("mission-budget-bar");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-label", "USD");
  });

  it("paints indigo below 70%", () => {
    render(<MissionBudgetBar used={50} budget={100} />);
    const bar = screen.getByTestId("mission-budget-bar");
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(bar.getAttribute("data-tone")).toBe("indigo");
    expect(fill.className).toContain("bg-indigo-500");
  });

  it("paints amber at 75% (mid-band)", () => {
    render(<MissionBudgetBar used={75} budget={100} />);
    const bar = screen.getByTestId("mission-budget-bar");
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(bar.getAttribute("data-tone")).toBe("amber");
    expect(fill.className).toContain("bg-amber-500");
  });

  it("paints red above 90%", () => {
    render(<MissionBudgetBar used={95} budget={100} />);
    const bar = screen.getByTestId("mission-budget-bar");
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(bar.getAttribute("data-tone")).toBe("red");
    expect(fill.className).toContain("bg-red-500");
  });

  it("clamps fill width to 100% even when over-budget", () => {
    render(<MissionBudgetBar used={500} budget={100} />);
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(fill.style.width).toBe("100%");
  });

  it("renders an empty fill when budget <= 0", () => {
    render(<MissionBudgetBar used={50} budget={0} />);
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(fill.style.width).toBe("0%");
    // Default tone for "no budget configured" is indigo.
    expect(screen.getByTestId("mission-budget-bar").getAttribute("data-tone")).toBe(
      "indigo",
    );
  });

  it("scales fill linearly across the indigo band", () => {
    render(<MissionBudgetBar used={30} budget={100} />);
    const fill = screen.getByTestId("mission-budget-bar-fill");
    expect(fill.style.width).toBe("30%");
  });

  it("uses zinc-100 / dark:zinc-800 for the track background", () => {
    render(<MissionBudgetBar used={10} budget={100} />);
    const bar = screen.getByTestId("mission-budget-bar");
    expect(bar.className).toContain("bg-zinc-100");
    expect(bar.className).toContain("dark:bg-zinc-800");
    // Track is exactly 1.5 * 4px tall per slice spec.
    expect(bar.className).toContain("h-1.5");
    expect(bar.className).toContain("rounded-full");
    expect(bar.className).toContain("overflow-hidden");
  });
});
