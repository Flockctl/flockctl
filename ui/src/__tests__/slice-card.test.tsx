import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SliceCard } from "@/pages/project-detail-components/SliceCard";
import type {
  PlanSliceTree,
  PlanTask,
  PlanTaskStatus,
  SliceStatus,
} from "@/lib/types/plan";

/**
 * Contract tests for the board-view `SliceCard`.
 *
 * The verification gate is `npm run test -- --run 'slice-card'` — every
 * `describe` in this file therefore starts with `slice-card` so the name
 * filter catches it.
 */

function makeTask(id: string, status: PlanTaskStatus): PlanTask {
  return {
    id,
    slice_id: "slice-1",
    title: `Task ${id}`,
    description: null,
    model: null,
    status,
    estimate: null,
    files: null,
    verify: null,
    inputs: null,
    expected_output: null,
    task_id: null,
    order_index: 0,
    output: null,
    summary: null,
    verification_passed: null,
    verification_output: null,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
  };
}

function makeSlice(overrides: Partial<PlanSliceTree> = {}): PlanSliceTree {
  return {
    id: "slice-1",
    milestone_id: "ms-1",
    title: "Add SliceCard component",
    description: null,
    status: "pending" as SliceStatus,
    risk: "low",
    depends: null,
    demo: null,
    goal: null,
    success_criteria: null,
    proof_level: null,
    threat_surface: null,
    order_index: 0,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
    tasks: [],
    ...overrides,
  };
}

describe("slice-card rendering", () => {
  it("renders the slice title, milestone breadcrumb and status badge", () => {
    render(
      <SliceCard
        slice={makeSlice({ title: "Ship the board", status: "active" })}
        milestoneTitle="Milestone 09 — Mission control"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId("slice-card-title").textContent).toBe(
      "Ship the board",
    );
    expect(screen.getByTestId("slice-card-breadcrumb").textContent).toBe(
      "Milestone 09 — Mission control",
    );
    // statusBadge renders plain text for non-amber/green statuses — "active"
    // is the default variant.
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("gives the title a 2-line clamp class so long titles don't blow the layout", () => {
    render(
      <SliceCard
        slice={makeSlice({ title: "x".repeat(500) })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const title = screen.getByTestId("slice-card-title");
    expect(title.className).toContain("line-clamp-2");
  });
});

describe("slice-card click handling", () => {
  it("calls onSelect with the slice id when the card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SliceCard
        slice={makeSlice({ id: "slice-42" })}
        milestoneTitle="ms"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("slice-card"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("slice-42");
  });

  it("calls onSelect when the user presses Enter on the focused card", () => {
    const onSelect = vi.fn();
    render(
      <SliceCard
        slice={makeSlice({ id: "slice-99" })}
        milestoneTitle="ms"
        onSelect={onSelect}
      />,
    );
    const card = screen.getByTestId("slice-card");
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("slice-99");
  });
});

describe("slice-card selected prop adds a ring", () => {
  it("has no ring when selected is absent/false", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const card = screen.getByTestId("slice-card");
    expect(card.getAttribute("data-selected")).toBe("false");
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(card.className).not.toContain("ring-2");
  });

  it("adds a ring-2 class and flips data-selected when selected=true", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        selected
        onSelect={() => {}}
      />,
    );
    const card = screen.getByTestId("slice-card");
    expect(card.getAttribute("data-selected")).toBe("true");
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(card.className).toContain("ring-2");
  });
});

describe("slice-card status → left border color mapping", () => {
  const cases: Array<[SliceStatus, string]> = [
    ["pending", "border-l-muted-foreground/40"],
    ["planning", "border-l-muted-foreground/40"],
    ["active", "border-l-primary"],
    ["verifying", "border-l-amber-500"],
    ["merging", "border-l-amber-500"],
    ["completed", "border-l-green-500"],
    ["failed", "border-l-destructive"],
    ["skipped", "border-l-muted-foreground/40"],
  ];

  for (const [status, expectedClass] of cases) {
    it(`maps status=${status} → ${expectedClass}`, () => {
      render(
        <SliceCard
          slice={makeSlice({ status })}
          milestoneTitle="ms"
          onSelect={() => {}}
        />,
      );
      const card = screen.getByTestId("slice-card");
      expect(card.className).toContain(expectedClass);
      // The 3px thickness is non-negotiable — enforce it too.
      expect(card.className).toContain("border-l-[3px]");
    });
  }
});

/**
 * Helper: the project's `Progress` wrapper drives the rendered percentage
 * via `style={{ transform: "translateX(-<rest>%)" }}` on its indicator
 * child, NOT via `aria-valuenow` (Radix needs the `value` prop forwarded
 * to the root for that, which the wrapper doesn't do today — see
 * `ui/src/components/ui/progress.tsx`). So we parse the transform to assert
 * the real visual percentage the user sees.
 */
function readProgressPercent(progressEl: HTMLElement): number {
  const indicator = progressEl.querySelector<HTMLElement>(
    '[data-slot="progress-indicator"]',
  );
  expect(indicator).not.toBeNull();
  const transform = indicator!.style.transform;
  const match = /translateX\(-([\d.]+)%\)/.exec(transform);
  expect(match, `expected translateX in "${transform}"`).not.toBeNull();
  // Visible-fraction = 100 - rest.
  return 100 - parseFloat(match![1]!);
}

describe("slice-card 0 task and 50 task progress bar corner cases", () => {
  it("renders an empty progress bar and 0/0 counter when the slice has zero tasks", () => {
    render(
      <SliceCard
        slice={makeSlice({ tasks: [] })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const progress = screen.getByTestId("slice-card-progress");
    expect(readProgressPercent(progress)).toBe(0);
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe("0/0");
  });

  it("caps the progress bar at 100 when every one of 50 tasks is completed", () => {
    const fifty: PlanTask[] = Array.from({ length: 50 }, (_, i) =>
      makeTask(`t${i}`, "completed"),
    );
    render(
      <SliceCard
        slice={makeSlice({ tasks: fifty })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const progress = screen.getByTestId("slice-card-progress");
    // Clamping must land on exactly 100 — not 99.999, not 100.001.
    expect(readProgressPercent(progress)).toBe(100);
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe(
      "50/50",
    );
  });

  it("computes a partial percentage for mixed statuses", () => {
    const tasks: PlanTask[] = [
      makeTask("a", "completed"),
      makeTask("b", "completed"),
      makeTask("c", "active"),
      makeTask("d", "pending"),
    ];
    render(
      <SliceCard
        slice={makeSlice({ tasks })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const progress = screen.getByTestId("slice-card-progress");
    expect(readProgressPercent(progress)).toBe(50);
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe("2/4");
  });
});

describe("slice-card high medium low priority visual baselines", () => {
  it("omits the priority chip entirely when no priority prop is supplied", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText("high")).toBeNull();
    expect(screen.queryByText("medium")).toBeNull();
    expect(screen.queryByText("low")).toBeNull();
  });

  it("renders a destructive-variant chip for high priority", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="high"
        onSelect={() => {}}
      />,
    );
    const chip = screen.getByText("high");
    expect(chip.getAttribute("data-priority")).toBe("high");
    expect(chip.getAttribute("data-variant")).toBe("destructive");
  });

  it("renders a secondary-variant chip with amber accents for medium priority", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="medium"
        onSelect={() => {}}
      />,
    );
    const chip = screen.getByText("medium");
    expect(chip.getAttribute("data-priority")).toBe("medium");
    expect(chip.getAttribute("data-variant")).toBe("secondary");
    expect(chip.className).toMatch(/amber/);
  });

  it("renders an outline-variant chip with muted text for low priority", () => {
    render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="low"
        onSelect={() => {}}
      />,
    );
    const chip = screen.getByText("low");
    expect(chip.getAttribute("data-priority")).toBe("low");
    expect(chip.getAttribute("data-variant")).toBe("outline");
    expect(chip.className).toMatch(/muted-foreground/);
  });

  it("renders three visually distinct chips across high / medium / low", () => {
    const { rerender } = render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="high"
        onSelect={() => {}}
      />,
    );
    const high = screen
      .getByText("high")
      .getAttribute("data-variant");

    rerender(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="medium"
        onSelect={() => {}}
      />,
    );
    const medium = screen
      .getByText("medium")
      .getAttribute("data-variant");

    rerender(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        priority="low"
        onSelect={() => {}}
      />,
    );
    const low = screen.getByText("low").getAttribute("data-variant");

    // All three baselines must resolve to distinct badge variants, otherwise
    // the chips are visually identical and the "priority chip" affordance
    // collapses back into decoration.
    expect(new Set([high, medium, low]).size).toBe(3);
  });
});
