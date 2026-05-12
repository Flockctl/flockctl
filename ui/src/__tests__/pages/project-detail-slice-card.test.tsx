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
 * Unit tests for the redesigned {@link SliceCard}.
 *
 * The card is a `<FlatCard interactive onClick>` that renders, in order:
 *   1. milestone-prefix line (zinc-500 / 11px)
 *   2. slice title (font-medium / 13.5px, 2-line clamp)
 *   3. StatusPill + done/total counter
 *   4. 1.5px gradient progress bar (indigo-500 → purple-500)
 *
 * These tests pin:
 *   - the FlatCard wrapper (rounded-xl, border, divider-y, bg-card,
 *     interactive hover)
 *   - the typography the spec calls out (text-[11px], text-[13.5px],
 *     font-medium, zinc-500)
 *   - the status → tone mapping (pending → neutral, in_progress → info,
 *     completed → success, blocked → warning)
 *   - the progress bar's container + fill classnames + clamping behaviour
 *   - click + keyboard activation invoking `onSelect(slug)`
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

describe("SliceCard / FlatCard wrapper", () => {
  it("renders the milestone prefix, title, status pill and progress bar", () => {
    render(
      <SliceCard
        slice={makeSlice({ title: "Ship the board", status: "active" })}
        milestoneTitle="Milestone 09 — Mission control"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId("slice-card-breadcrumb").textContent).toBe(
      "Milestone 09 — Mission control",
    );
    expect(screen.getByTestId("slice-card-title").textContent).toBe(
      "Ship the board",
    );
    expect(screen.getByTestId("slice-card-status")).toBeTruthy();
    expect(screen.getByTestId("slice-card-progress")).toBeTruthy();
  });

  it("wraps content in a FlatCard interactive surface", () => {
    const { container } = render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    // FlatCard root is the first DOM child of the test container.
    const root = container.firstElementChild as HTMLElement;
    const cls = root.className;
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("border");
    expect(cls).toContain("divider-y");
    expect(cls).toContain("bg-card");
    expect(cls).toContain("card-hover");
    expect(cls).toContain("cursor-pointer");
    expect(root.getAttribute("role")).toBe("button");
    expect(root.getAttribute("tabindex")).toBe("0");
  });
});

describe("SliceCard / typography", () => {
  it("breadcrumb is rendered at zinc-500 / 11px", () => {
    render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    const crumb = screen.getByTestId("slice-card-breadcrumb");
    expect(crumb.className).toContain("text-[11px]");
    expect(crumb.className).toContain("text-zinc-500");
  });

  it("title is rendered at font-medium / 13.5px with a 2-line clamp", () => {
    render(
      <SliceCard
        slice={makeSlice({ title: "x".repeat(500) })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const title = screen.getByTestId("slice-card-title");
    expect(title.className).toContain("font-medium");
    expect(title.className).toContain("text-[13.5px]");
    expect(title.className).toContain("line-clamp-2");
  });

  it("task count is rendered at zinc-500 / 11px with tabular-nums", () => {
    render(
      <SliceCard
        slice={makeSlice({
          tasks: [makeTask("a", "completed"), makeTask("b", "pending")],
        })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const count = screen.getByTestId("slice-card-task-count");
    expect(count.textContent).toBe("1/2");
    expect(count.className).toContain("text-[11px]");
    expect(count.className).toContain("text-zinc-500");
    expect(count.className).toContain("tabular-nums");
  });
});

describe("SliceCard / status → tone mapping", () => {
  const cases: Array<[SliceStatus, string]> = [
    // pending → neutral
    ["pending", "neutral"],
    ["planning", "neutral"],
    ["skipped", "neutral"],
    // in progress → info
    ["active", "info"],
    ["verifying", "info"],
    ["merging", "info"],
    // completed → success
    ["completed", "success"],
    // blocked → warning
    ["failed", "warning"],
  ];

  for (const [status, expectedTone] of cases) {
    it(`maps slice status=${status} → StatusPill tone=${expectedTone}`, () => {
      render(
        <SliceCard
          slice={makeSlice({ status })}
          milestoneTitle="ms"
          onSelect={() => {}}
        />,
      );
      const pill = screen.getByTestId("slice-card-status");
      expect(pill.getAttribute("data-tone")).toBe(expectedTone);
    });
  }
});

describe("SliceCard / progress bar", () => {
  it("uses the spec'd track classes (h-1.5, zinc-100, dark:zinc-800, rounded-full)", () => {
    render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    const bar = screen.getByTestId("slice-card-progress");
    expect(bar.className).toContain("h-1.5");
    expect(bar.className).toContain("bg-zinc-100");
    expect(bar.className).toContain("dark:bg-zinc-800");
    expect(bar.className).toContain("rounded-full");
    expect(bar.className).toContain("overflow-hidden");
    expect(bar.getAttribute("role")).toBe("progressbar");
  });

  it("uses the spec'd indigo→purple gradient fill", () => {
    render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    const fill = screen.getByTestId("slice-card-progress-fill");
    expect(fill.className).toContain("bg-gradient-to-r");
    expect(fill.className).toContain("from-indigo-500");
    expect(fill.className).toContain("to-purple-500");
  });

  it("renders 0% width when the slice has no tasks", () => {
    render(
      <SliceCard
        slice={makeSlice({ tasks: [] })}
        milestoneTitle="ms"
        onSelect={() => {}}
      />,
    );
    const fill = screen.getByTestId("slice-card-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
    expect(
      screen.getByTestId("slice-card-progress").getAttribute("aria-valuenow"),
    ).toBe("0");
  });

  it("clamps to exactly 100% when every one of 50 tasks is completed", () => {
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
    const fill = screen.getByTestId("slice-card-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
    expect(
      screen.getByTestId("slice-card-progress").getAttribute("aria-valuenow"),
    ).toBe("100");
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe(
      "50/50",
    );
  });

  it("computes a partial width for mixed task statuses", () => {
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
    const fill = screen.getByTestId("slice-card-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("50%");
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe("2/4");
  });
});

describe("SliceCard / activation", () => {
  it("calls onSelect with the slice id (slug) on click", () => {
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

  it("calls onSelect when Enter is pressed on the focused card", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SliceCard
        slice={makeSlice({ id: "slice-99" })}
        milestoneTitle="ms"
        onSelect={onSelect}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    root.focus();
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("slice-99");
  });

  it("calls onSelect when Space is pressed on the focused card", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SliceCard
        slice={makeSlice({ id: "slice-77" })}
        milestoneTitle="ms"
        onSelect={onSelect}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    root.focus();
    fireEvent.keyDown(root, { key: " " });
    expect(onSelect).toHaveBeenCalledWith("slice-77");
  });
});

describe("SliceCard / selected ring", () => {
  it("does not paint the ring when selected is absent/false", () => {
    const { container } = render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain("ring-2");
    expect(screen.getByTestId("slice-card").getAttribute("data-selected")).toBe(
      "false",
    );
  });

  it("paints a ring-2 outline when selected=true and flips data-selected", () => {
    const { container } = render(
      <SliceCard
        slice={makeSlice()}
        milestoneTitle="ms"
        selected
        onSelect={() => {}}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("ring-2");
    expect(screen.getByTestId("slice-card").getAttribute("data-selected")).toBe(
      "true",
    );
  });
});

describe("SliceCard / priority chip", () => {
  it("omits the priority pill when no priority prop is supplied", () => {
    render(
      <SliceCard slice={makeSlice()} milestoneTitle="ms" onSelect={() => {}} />,
    );
    expect(screen.queryByTestId("slice-card-priority")).toBeNull();
  });

  const cases: Array<[NonNullable<Parameters<typeof SliceCard>[0]["priority"]>, string]> = [
    ["high", "danger"],
    ["medium", "warning"],
    ["low", "neutral"],
  ];

  for (const [priority, expectedTone] of cases) {
    it(`renders priority=${priority} as a StatusPill with tone=${expectedTone}`, () => {
      render(
        <SliceCard
          slice={makeSlice()}
          milestoneTitle="ms"
          priority={priority}
          onSelect={() => {}}
        />,
      );
      const pill = screen.getByTestId("slice-card-priority");
      expect(pill.getAttribute("data-tone")).toBe(expectedTone);
      expect(pill.getAttribute("data-priority")).toBe(priority);
      expect(pill.textContent).toBe(priority);
    });
  }
});
