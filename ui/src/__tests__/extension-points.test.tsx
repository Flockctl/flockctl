import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Milestone 09 / slice 06 — extension-point runtime contracts.
 *
 * This file is the proof obligation called out in slice.md 06:
 *
 *   "Prove each extension point with a real test, not just inspection."
 *
 * The slice ships no UI consumer — the test IS the shipped artifact. It
 * asserts the core LOC-level contract for two pluggable surfaces that
 * downstream milestones (especially milestone 10 "Supervisor + missions")
 * will extend without touching their component files:
 *
 *   1. <SliceBoard columns={...}>        — board accepts an N-entry column
 *                                           array and renders exactly N
 *                                           columns. Verified with N=5.
 *   2. <SliceDetailTabs tabs={...}>      — tabs registry accepts an N-entry
 *                                           tab array and both renders AND
 *                                           switches between them. Verified
 *                                           with N=2 (default + extra).
 *
 * Additionally covers the dangling-mission tolerance edge case: a milestone
 * row that carries a `mission_id` pointing at a mission that does not exist
 * in the current plan tree must still render without crashing the panel.
 * Enforcement (validation + a visual broken-link badge) is deferred to
 * milestone 10 — today we only guarantee *tolerance* so an in-flight data
 * shape does not blow the whole board up.
 *
 * Verification filter (from slice.md):
 *   npm run test -- --run 'extension-points|slice_board_accepts_5|slice_detail_tabs_accepts_2'
 *
 * The describe/it names below include both `slice_board_accepts_5` and
 * `slice_detail_tabs_accepts_2` so the filter hits regardless of whether
 * vitest interprets it as a file-name pattern or a test-name pattern.
 */

// --- Mocks for the tree-integration test -----------------------------------
//
// `ProjectTreePanel` fetches via `useProjectTree(projectId)`. We stub the
// hook so the dangling-mission fixture is fully deterministic and no real
// network/query-client machinery is needed.

const { useProjectTreeMock } = vi.hoisted(() => ({
  useProjectTreeMock: vi.fn(),
}));

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useProjectTree: (...args: unknown[]) => useProjectTreeMock(...args),
  };
});

// Imports AFTER the mock so the component resolves the stubbed hook.
import { SliceBoard } from "@/pages/project-detail-components/SliceBoard";
import type { ColumnDef } from "@/pages/project-detail-components/slice-board-types";
import {
  SliceDetailTabs,
  DEFAULT_SLICE_TABS,
  type TabDef,
} from "@/pages/project-detail-components/SliceDetailTabs";
import { ProjectTreePanel } from "@/pages/project-detail-components/ProjectTreePanel";
import type {
  MilestoneTree,
  PlanSliceTree,
  SliceStatus,
} from "@/lib/types/plan";

// --- Fixture builders -------------------------------------------------------

function makeSlice(
  id: string,
  status: SliceStatus,
  milestoneId = "ms-1",
): PlanSliceTree {
  return {
    id,
    milestone_id: milestoneId,
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
  };
}

/** Loose helper — allows injecting forward-compatible extra fields like
 *  `mission_id` before the type declaration ships in milestone 10. */
function makeMilestone(
  id: string,
  title: string,
  slices: PlanSliceTree[] = [],
  extra: Record<string, unknown> = {},
): MilestoneTree {
  const base = {
    id,
    project_id: "proj-1",
    title,
    description: null,
    status: "pending" as const,
    vision: null,
    success_criteria: null,
    depends_on: null,
    order_index: 0,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
    slices,
    ...extra,
  };
  return base as unknown as MilestoneTree;
}

function mockQuery<T>(data: T | undefined) {
  return {
    data,
    isLoading: false,
    error: null,
    isSuccess: true,
    isError: false,
  };
}

beforeEach(() => {
  useProjectTreeMock.mockReset();
});

// ---------------------------------------------------------------------------
// 1. SliceBoard — 5-column extension point
// ---------------------------------------------------------------------------

describe("extension-points: slice_board_accepts_5 entry columns array and renders five columns", () => {
  it("slice_board_accepts_5_entry_columns_array_without_component_change", () => {
    // A synthetic 5-column layout. Columns 1-4 each claim a single status so
    // grouping is deterministic; column 5 ("Cold storage") claims the two
    // terminal statuses that `DEFAULT_SLICE_COLUMNS` intentionally drops, so
    // we also prove the new column participates in the grouping logic, not
    // just in the header render.
    const fiveColumns: ColumnDef[] = [
      { id: "pending", title: "Pending", matchStatuses: ["pending"] },
      { id: "active", title: "Active", matchStatuses: ["active"] },
      { id: "verifying", title: "Verifying", matchStatuses: ["verifying"] },
      { id: "completed", title: "Completed", matchStatuses: ["completed"] },
      // `id` uses an existing SliceStatus key because ColumnDef.id is typed
      // as SliceStatus — we pick `skipped` so the id is meaningful but the
      // title reads as the new bucket.
      {
        id: "skipped",
        title: "Cold storage",
        matchStatuses: ["skipped", "failed"],
      },
    ];

    const slices: PlanSliceTree[] = [
      makeSlice("a", "pending"),
      makeSlice("b", "active"),
      makeSlice("c", "verifying"),
      makeSlice("d", "completed"),
      makeSlice("e", "skipped"),
      makeSlice("f", "failed"),
    ];

    render(
      <SliceBoard
        slices={slices}
        columns={fiveColumns}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    // Contract 1: exactly five columns render — no fallback "Other" appears
    // because every slice status is claimed by one of the five columns.
    const cols = screen.getAllByTestId("slice-board-column");
    expect(cols).toHaveLength(5);

    // Contract 2: the column ids come through in the order we passed them.
    expect(cols.map((c) => c.getAttribute("data-column-id"))).toEqual([
      "pending",
      "active",
      "verifying",
      "completed",
      "skipped",
    ]);

    // Contract 3: the NEW (5th) column participates in grouping, not just
    // rendering — both `skipped` and `failed` slices land in it.
    const coldStorage = cols[4]!;
    expect(
      within(coldStorage)
        .getAllByTestId("slice-card")
        .map((c) => c.getAttribute("data-slice-id"))
        .sort(),
    ).toEqual(["e", "f"]);

    // Contract 4: no "Other" fallback column leaked in.
    expect(
      cols.map((c) => c.getAttribute("data-column-id")),
    ).not.toContain("other");
  });

  it("slice_board_accepts_5_entry_columns_renders_empty_placeholder_per_column", () => {
    // Regression guard for the 5-column case: a column with zero matching
    // slices must still render AND still show the "No slices" placeholder.
    const fiveColumns: ColumnDef[] = [
      { id: "pending", title: "Pending", matchStatuses: ["pending"] },
      { id: "active", title: "Active", matchStatuses: ["active"] },
      { id: "verifying", title: "Verifying", matchStatuses: ["verifying"] },
      { id: "completed", title: "Completed", matchStatuses: ["completed"] },
      {
        id: "skipped",
        title: "Cold storage",
        matchStatuses: ["skipped", "failed"],
      },
    ];

    render(
      <SliceBoard
        slices={[makeSlice("a", "active")]}
        columns={fiveColumns}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    const cols = screen.getAllByTestId("slice-board-column");
    expect(cols).toHaveLength(5);

    // Four columns are empty, one is populated — the empty ones must show
    // the placeholder so the horizontal rhythm is preserved.
    const empties = screen.getAllByTestId("slice-board-column-empty");
    expect(empties).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. SliceDetailTabs — 2-entry tabs extension point
// ---------------------------------------------------------------------------

describe("extension-points: slice_detail_tabs_accepts_2 entry tabs array and switches between them", () => {
  it("slice_detail_tabs_accepts_2_entry_tabs_array_both_render_and_switch", async () => {
    // Compose a 2-entry registry: the default "Slice" tab + an extra
    // "Supervisor log" tab. Milestone 10 will ship this exact pattern.
    const extraTab: TabDef = {
      id: "supervisor-log",
      label: "Supervisor log",
      render: (ctx) => (
        <div data-testid="supervisor-log-panel">
          supervisor log for {ctx.sliceId ?? "(none)"}
        </div>
      ),
    };

    const tabs: TabDef[] = [...DEFAULT_SLICE_TABS, extraTab];
    expect(tabs).toHaveLength(2);

    const user = userEvent.setup();
    render(<SliceDetailTabs sliceId="slice-42" tabs={tabs} />);

    // Both triggers are registered as tablist items.
    const defaultTrigger = screen.getByRole("tab", { name: "Slice" });
    const extraTrigger = screen.getByRole("tab", { name: "Supervisor log" });
    expect(defaultTrigger).toBeTruthy();
    expect(extraTrigger).toBeTruthy();

    // The first tab owns activation on mount — standard registry contract.
    expect(defaultTrigger.getAttribute("data-state")).toBe("active");
    expect(extraTrigger.getAttribute("data-state")).toBe("inactive");

    // Switching: clicking the second trigger flips activation AND causes
    // the extra tab's render() output to land in the DOM. This proves the
    // registry participates end-to-end — it is not merely decoration.
    await user.click(extraTrigger);

    expect(extraTrigger.getAttribute("data-state")).toBe("active");
    expect(defaultTrigger.getAttribute("data-state")).toBe("inactive");
    expect(screen.getByTestId("supervisor-log-panel").textContent).toContain(
      "supervisor log for slice-42",
    );

    // Switching back is also supported — the default panel re-activates.
    await user.click(defaultTrigger);
    expect(defaultTrigger.getAttribute("data-state")).toBe("active");
    expect(extraTrigger.getAttribute("data-state")).toBe("inactive");
  });

  it("slice_detail_tabs_accepts_2_entry_tabs_render_without_modifying_component_file", () => {
    // Contract mirror of the SliceBoard 5-column test: the tabs registry
    // is the sole driver of how many tab triggers show up. Two registry
    // entries → two triggers, no component edit required.
    const twoTabs: TabDef[] = [
      {
        id: "one",
        label: "One",
        render: () => <div data-testid="panel-one">one</div>,
      },
      {
        id: "two",
        label: "Two",
        render: () => <div data-testid="panel-two">two</div>,
      },
    ];

    render(<SliceDetailTabs tabs={twoTabs} />);

    const triggers = screen.getAllByRole("tab");
    expect(triggers).toHaveLength(2);
    expect(triggers.map((t) => t.textContent)).toEqual(["One", "Two"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Dangling-mission tolerance (forward-compat edge case for milestone 10)
// ---------------------------------------------------------------------------

describe("extension-points: dangling mission_id on a milestone row is tolerated without crash", () => {
  it("milestone_with_unresolved_mission_id_still_renders_in_tree", () => {
    // A milestone that claims `mission_id = "mission-ghost"` even though no
    // mission row with that id exists in the current plan (missions arrive
    // in milestone 10). The panel today has no mission awareness at all, so
    // the "tolerance" contract is simply: don't crash, render the milestone
    // row the same as any other, and keep any child slices intact.
    const ghostMilestone = makeMilestone(
      "m-ghost",
      "Milestone with dangling mission",
      [makeSlice("s-ghost-1", "pending", "m-ghost")],
      { mission_id: "mission-ghost" },
    );
    const plainMilestone = makeMilestone("m-plain", "Plain milestone", [
      makeSlice("s-plain-1", "active", "m-plain"),
    ]);

    useProjectTreeMock.mockReturnValue(
      mockQuery({ milestones: [ghostMilestone, plainMilestone] }),
    );

    // The act of rendering must not throw — that is the whole edge case.
    expect(() =>
      render(<ProjectTreePanel projectId="proj-1" />),
    ).not.toThrow();

    // Both milestone rows land in the DOM with the expected test ids.
    expect(screen.getByTestId("tree-milestone-m-ghost")).toBeInTheDocument();
    expect(screen.getByTestId("tree-milestone-m-plain")).toBeInTheDocument();

    // Titles are intact (no accidental transformation of the ghost label).
    const tree = screen.getByRole("tree");
    expect(
      within(tree).getByText("Milestone with dangling mission"),
    ).toBeInTheDocument();
    expect(within(tree).getByText("Plain milestone")).toBeInTheDocument();

    // Tolerance ≠ enforcement. Milestone 10 will add a broken-link visual
    // cue on the ghost row; today we just guarantee nothing surfaces it,
    // so there is no data-testid leak for a future marker.
    expect(
      document.querySelector('[data-testid="tree-mission-broken-link"]'),
    ).toBeNull();
  });

  it("empty_mission_id_string_is_also_tolerated", () => {
    // Sibling edge case: an empty-string mission_id (e.g. a partially filled
    // form saving through the API) must be treated the same as "no mission"
    // — silent render, no crash. Locking this in now prevents milestone 10
    // from having to retrofit the tolerance contract.
    const milestone = makeMilestone(
      "m-empty-mission",
      "Milestone with empty mission_id",
      [],
      { mission_id: "" },
    );

    useProjectTreeMock.mockReturnValue(
      mockQuery({ milestones: [milestone] }),
    );

    expect(() =>
      render(<ProjectTreePanel projectId="proj-1" />),
    ).not.toThrow();

    expect(
      screen.getByTestId("tree-milestone-m-empty-mission"),
    ).toBeInTheDocument();
  });
});
