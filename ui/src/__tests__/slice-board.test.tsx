import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { SliceBoard } from "@/pages/project-detail-components/SliceBoard";
import { DEFAULT_SLICE_COLUMNS } from "@/pages/project-detail-components/slice-board-types";
import type {
  PlanSliceTree,
  SliceStatus,
} from "@/lib/types/plan";

/**
 * Contract tests for the board-view `SliceBoard`.
 *
 * The verification gate is `npm run test -- --run 'slice-board'` — every
 * `describe` in this file therefore starts with `slice-board` so the name
 * filter catches it.
 */

function makeSlice(
  id: string,
  status: SliceStatus,
  overrides: Partial<PlanSliceTree> = {},
): PlanSliceTree {
  return {
    id,
    milestone_id: "ms-1",
    title: `Slice ${id}`,
    description: null,
    status,
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

function getColumnByTitle(title: string): HTMLElement {
  const header = screen.getAllByTestId("slice-board-column-header").find((h) =>
    h.textContent?.includes(title),
  );
  if (!header) {
    throw new Error(`column with title "${title}" not found`);
  }
  // Walk up to the column root.
  const col = header.closest("[data-testid='slice-board-column']");
  if (!(col instanceof HTMLElement)) {
    throw new Error(`column root for "${title}" not found`);
  }
  return col;
}

describe("slice-board groups slices into columns by matchStatuses", () => {
  it("puts each slice into the column whose matchStatuses list contains its status", () => {
    // `verifying` + `merging` are deliberately omitted from this fixture
    // because the default layout no longer renders a Verifying column
    // (see the JSDoc on `DEFAULT_SLICE_COLUMNS`). The "unknown status
    // fallback" describe-block below covers the Other-column path that
    // such slices hit today.
    const slices: PlanSliceTree[] = [
      makeSlice("a", "pending"),
      makeSlice("b", "planning"),
      makeSlice("c", "active"),
      makeSlice("f", "completed"),
    ];

    render(
      <SliceBoard
        slices={slices}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    const pending = getColumnByTitle("Pending");
    expect(
      within(pending).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["a", "b"]);

    const active = getColumnByTitle("Active");
    expect(
      within(active).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["c"]);

    const completed = getColumnByTitle("Completed");
    expect(
      within(completed).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["f"]);
  });

  it("renders exactly as many columns as the columns prop has when no status falls through", () => {
    const slices = [makeSlice("a", "active")];
    render(
      <SliceBoard
        slices={slices}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const cols = screen.getAllByTestId("slice-board-column");
    expect(cols).toHaveLength(DEFAULT_SLICE_COLUMNS.length);
  });

  it("accepts a custom columns array and renders that instead of the default", () => {
    const slices = [makeSlice("a", "active"), makeSlice("b", "completed")];
    render(
      <SliceBoard
        slices={slices}
        columns={[
          { id: "active", title: "Doing", matchStatuses: ["active"] },
          { id: "completed", title: "Done", matchStatuses: ["completed"] },
        ]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const cols = screen.getAllByTestId("slice-board-column");
    expect(cols).toHaveLength(2);
    expect(cols.map((c) => c.getAttribute("data-column-id"))).toEqual([
      "active",
      "completed",
    ]);
  });
});

describe("slice-board column count chip", () => {
  it("shows the number of slices in each column", () => {
    const slices = [
      makeSlice("a", "pending"),
      makeSlice("b", "pending"),
      makeSlice("c", "pending"),
      makeSlice("d", "active"),
    ];
    render(
      <SliceBoard
        slices={slices}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    const pending = getColumnByTitle("Pending");
    expect(
      within(pending).getByTestId("slice-board-column-count").textContent,
    ).toBe("3");

    const active = getColumnByTitle("Active");
    expect(
      within(active).getByTestId("slice-board-column-count").textContent,
    ).toBe("1");

    const completed = getColumnByTitle("Completed");
    expect(
      within(completed).getByTestId("slice-board-column-count").textContent,
    ).toBe("0");
  });
});

describe("slice-board empty column placeholder", () => {
  it("renders a 'No slices' placeholder when a column has zero slices", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active")]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const completed = getColumnByTitle("Completed");
    expect(
      within(completed).getByTestId("slice-board-column-empty").textContent,
    ).toBe("No slices");
    expect(within(completed).queryAllByTestId("slice-card")).toHaveLength(0);
  });

  it("does not render the placeholder when the column is populated", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active")]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const active = getColumnByTitle("Active");
    expect(
      within(active).queryByTestId("slice-board-column-empty"),
    ).toBeNull();
  });
});

describe("slice-board unknown status fallback Other column", () => {
  it("does NOT render the Other column when every slice maps to a known column", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active"), makeSlice("b", "completed")]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    expect(
      screen
        .getAllByTestId("slice-board-column")
        .map((c) => c.getAttribute("data-column-id")),
    ).not.toContain("other");
  });

  it("renders the Other column when a slice has a status not covered by any column", () => {
    // `skipped` and `failed` are not in DEFAULT_SLICE_COLUMNS.
    render(
      <SliceBoard
        slices={[
          makeSlice("a", "active"),
          makeSlice("b", "skipped"),
          makeSlice("c", "failed"),
        ]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const other = getColumnByTitle("Other");
    expect(other).toBeTruthy();
    expect(
      within(other).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["b", "c"]);
    expect(
      within(other).getByTestId("slice-board-column-count").textContent,
    ).toBe("2");
  });

  it("routes verifying and merging slices into the Other fallback column (Verifying column is hidden by default)", () => {
    // Regression guard for the "hide Verifying column until backend emits
    // the status" decision documented on DEFAULT_SLICE_COLUMNS. If someone
    // re-adds the Verifying column without updating the default layout
    // here, this assertion pins the current behaviour.
    render(
      <SliceBoard
        slices={[
          makeSlice("a", "active"),
          makeSlice("b", "verifying"),
          makeSlice("c", "merging"),
        ]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    expect(
      screen
        .getAllByTestId("slice-board-column")
        .map((c) => c.getAttribute("data-column-id")),
    ).not.toContain("verifying");

    const other = getColumnByTitle("Other");
    expect(
      within(other).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["b", "c"]);
  });

  it("renders only one Other column even if many slices have unknown statuses", () => {
    render(
      <SliceBoard
        slices={[
          makeSlice("a", "skipped"),
          makeSlice("b", "skipped"),
          makeSlice("c", "failed"),
        ]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    const otherCols = screen
      .getAllByTestId("slice-board-column")
      .filter((c) => c.getAttribute("data-column-id") === "other");
    expect(otherCols).toHaveLength(1);
  });
});

describe("slice-board selection ring propagation", () => {
  it("applies the selected ring to the matching slice card only", () => {
    render(
      <SliceBoard
        slices={[
          makeSlice("a", "active"),
          makeSlice("b", "active"),
          makeSlice("c", "completed"),
        ]}
        milestoneTitleFor={() => "ms"}
        selectedSliceId="b"
        onSelectSlice={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("slice-card");
    const selected = cards.filter(
      (c) => c.getAttribute("data-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("data-slice-id")).toBe("b");
  });

  it("applies no selection ring when selectedSliceId is null/undefined", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active"), makeSlice("b", "completed")]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );
    expect(
      screen
        .getAllByTestId("slice-card")
        .every((c) => c.getAttribute("data-selected") === "false"),
    ).toBe(true);
  });
});

describe("slice-board onSelectSlice is wired through to SliceCard clicks", () => {
  it("calls onSelectSlice with the slice id when a card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <SliceBoard
        slices={[makeSlice("a", "active"), makeSlice("b", "pending")]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={onSelect}
      />,
    );
    const cards = screen.getAllByTestId("slice-card");
    const bCard = cards.find((c) => c.getAttribute("data-slice-id") === "b");
    expect(bCard).toBeTruthy();
    fireEvent.click(bCard!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});

describe("slice-board milestoneTitleFor and priorityFor are forwarded to SliceCard", () => {
  it("renders the breadcrumb returned by milestoneTitleFor for each slice", () => {
    const slices = [
      makeSlice("a", "active", { milestone_id: "ms-alpha" }),
      makeSlice("b", "pending", { milestone_id: "ms-beta" }),
    ];
    render(
      <SliceBoard
        slices={slices}
        milestoneTitleFor={(s) =>
          s.id === "a" ? "Milestone Alpha" : "Milestone Beta"
        }
        onSelectSlice={() => {}}
      />,
    );
    const crumbs = screen
      .getAllByTestId("slice-card-breadcrumb")
      .map((el) => el.textContent);
    expect(crumbs).toContain("Milestone Alpha");
    expect(crumbs).toContain("Milestone Beta");
  });

  it("omits the priority chip when priorityFor returns undefined", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active")]}
        milestoneTitleFor={() => "ms"}
        priorityFor={() => undefined}
        onSelectSlice={() => {}}
      />,
    );
    expect(screen.queryByText("high")).toBeNull();
    expect(screen.queryByText("medium")).toBeNull();
    expect(screen.queryByText("low")).toBeNull();
  });

  it("passes priorityFor output into SliceCard's priority chip", () => {
    render(
      <SliceBoard
        slices={[makeSlice("a", "active")]}
        milestoneTitleFor={() => "ms"}
        priorityFor={() => "high"}
        onSelectSlice={() => {}}
      />,
    );
    expect(screen.getByText("high")).toBeTruthy();
  });
});
