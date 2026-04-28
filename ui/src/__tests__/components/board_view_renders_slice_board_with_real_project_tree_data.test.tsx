import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Integration test for the slice-01 "wire SliceBoard into BoardView center
 * slot" task.
 *
 * The corner case declared by the parent slice is
 * `board_view_renders_slice_board_with_real_project_tree_data`: hand the
 * shell a populated `useProjectTree` response and assert the center grid
 * renders a live SliceBoard whose columns hold the slices we seeded.
 *
 * We stub `useProjectTree` at the hook boundary rather than going through
 * a real fetch — the concern of this slice is the wiring, not the transport.
 * A parallel e2e spec in `ui/e2e/` already exercises the real fixture
 * pipeline end-to-end.
 */

// --- Mocks -------------------------------------------------------------------
//
// Stub `useProjectTree` so we can hand the shell a deterministic tree without
// needing a QueryClient / network. Kept hoisted so the module-level
// `vi.mock()` can refer to it (vi rewrites hoisting per its docs).
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
    // Slice 11/04: ProjectTreePanel now also calls `useMissions(projectId)`.
    // No QueryClient is wired up here, so shadow with an idle stub returning
    // an empty list. The flat-tree assertions below are unaffected.
    useMissions: () => ({
      data: { items: [] },
      isLoading: false,
      error: null,
      isSuccess: true,
      isError: false,
    }),
  };
});

// The KPI bar fans out three additional react-query calls; bypass it so
// this suite stays focused on the center slot.
vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBar: ({ projectId }: { projectId: string }) => (
    <div data-testid="mission-control-kpi-bar">kpi:{projectId}</div>
  ),
}));

// Import AFTER mocks so the component picks up the stubbed module.
import { ProjectDetailBoardView } from "@/pages/project-detail-components/ProjectDetailBoardView";

// --- Fixtures ----------------------------------------------------------------

function makeSlice(
  id: string,
  milestoneId: string,
  status:
    | "pending"
    | "planning"
    | "active"
    | "verifying"
    | "merging"
    | "completed"
    | "skipped"
    | "failed",
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

function makeMilestone(
  id: string,
  title: string,
  slices: ReturnType<typeof makeSlice>[],
) {
  return {
    id,
    project_id: "p1",
    title,
    description: null,
    status: "pending",
    vision: null,
    success_criteria: null,
    depends_on: null,
    order_index: 0,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
    slices,
  };
}

function wrap(children: ReactNode) {
  return <MemoryRouter initialEntries={["/projects/proj-1"]}>{children}</MemoryRouter>;
}

function mockQuery<T>(
  data: T | undefined,
  opts: { isLoading?: boolean; error?: unknown } = {},
) {
  return {
    data,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    isSuccess: opts.error == null && !opts.isLoading,
    isError: !!opts.error,
  };
}

beforeEach(() => {
  useProjectTreeMock.mockReset();
});

// --- Tests -------------------------------------------------------------------

describe("board_view_renders_slice_board_with_real_project_tree_data", () => {
  it("flattens milestones → slices from useProjectTree into the center SliceBoard columns", () => {
    // The default layout renders Pending / Active / Completed — see the
    // JSDoc on `DEFAULT_SLICE_COLUMNS`. `verifying` is deliberately absent
    // from this fixture because the default layout no longer surfaces it;
    // coverage for the "Verifying falls through to Other" case lives in
    // `slice-board.test.tsx`.
    const tree = {
      milestones: [
        makeMilestone("ms-alpha", "Milestone Alpha", [
          makeSlice("s-a1", "ms-alpha", "pending"),
          makeSlice("s-a2", "ms-alpha", "active"),
        ]),
        makeMilestone("ms-beta", "Milestone Beta", [
          makeSlice("s-b1", "ms-beta", "completed"),
        ]),
      ],
    };
    useProjectTreeMock.mockReturnValue(mockQuery(tree));

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    // The center slot now hosts a live SliceBoard — not the stub.
    expect(screen.queryByTestId("board-center-stub")).toBeNull();
    const board = screen.getByTestId("slice-board");
    expect(board).toBeInTheDocument();

    // Each known status lands in its matching column.
    const columns = within(board).getAllByTestId("slice-board-column");
    const byId = new Map(
      columns.map((c) => [c.getAttribute("data-column-id"), c] as const),
    );

    const pending = byId.get("pending");
    expect(pending).toBeDefined();
    expect(
      within(pending!).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["s-a1"]);

    const active = byId.get("active");
    expect(
      within(active!).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["s-a2"]);

    // Verifying column is hidden by default; assert it isn't rendered.
    expect(byId.has("verifying")).toBe(false);

    const completed = byId.get("completed");
    expect(
      within(completed!).getAllByTestId("slice-card").map((c) =>
        c.getAttribute("data-slice-id"),
      ),
    ).toEqual(["s-b1"]);
  });

  it("resolves the milestone title for each card's breadcrumb from the flattened tree", () => {
    const tree = {
      milestones: [
        makeMilestone("ms-alpha", "Milestone Alpha", [
          makeSlice("s-a1", "ms-alpha", "active"),
        ]),
        makeMilestone("ms-beta", "Milestone Beta", [
          makeSlice("s-b1", "ms-beta", "active"),
        ]),
      ],
    };
    useProjectTreeMock.mockReturnValue(mockQuery(tree));

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    const crumbs = screen
      .getAllByTestId("slice-card-breadcrumb")
      .map((c) => c.textContent);
    expect(crumbs).toContain("Milestone Alpha");
    expect(crumbs).toContain("Milestone Beta");
  });

  it("shows a loading skeleton while the project tree is still in flight", () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery(undefined, { isLoading: true }),
    );

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    expect(screen.getByTestId("board-center-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("slice-board")).toBeNull();
  });

  it("falls back to an error message when the tree fetch fails", () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery(undefined, { error: new Error("boom") }),
    );

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    expect(screen.getByTestId("board-center-error")).toBeInTheDocument();
    expect(screen.queryByTestId("slice-board")).toBeNull();
  });

  it("still renders the SliceBoard (with every column empty) when the project has no milestones", () => {
    useProjectTreeMock.mockReturnValue(mockQuery({ milestones: [] }));

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    const board = screen.getByTestId("slice-board");
    expect(board).toBeInTheDocument();
    // Every default column renders an empty-state placeholder. The default
    // layout is now 3 columns (Pending / Active / Completed) — see the
    // JSDoc on DEFAULT_SLICE_COLUMNS for why Verifying is hidden.
    expect(
      within(board).getAllByTestId("slice-board-column-empty"),
    ).toHaveLength(3);
  });

  it("keeps the swimlane 'coming soon' stub — SliceBoard is board-mode only", () => {
    // Return a populated tree to prove we are not just falling back because
    // of missing data.
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("ms-alpha", "Milestone Alpha", [
            makeSlice("s-a1", "ms-alpha", "active"),
          ]),
        ],
      }),
    );

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="swimlane" />),
    );

    expect(screen.getByTestId("board-center-stub")).toHaveTextContent(
      /coming soon/i,
    );
    expect(screen.queryByTestId("slice-board")).toBeNull();
  });

  it("wires the tree panel into the left slot (slice 02) and the SliceDetailTabs rail into the right slot (slice 03)", () => {
    // An empty-milestones tree still mounts the panel — it just renders the
    // panel's own empty-state inside the left slot. Asserting on
    // `project-tree-panel-empty` proves the panel is in the DOM (not the
    // pre-slice-02 stub) without caring about slice 02's selection wiring.
    //
    // With no `?slice=` param on the URL the right rail is idle — it renders
    // the friendly empty-state hint, not the old "wired in slice 04" stub
    // and not a spinner.
    useProjectTreeMock.mockReturnValue(mockQuery({ milestones: [] }));

    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    expect(screen.queryByTestId("board-left-stub")).toBeNull();
    expect(screen.getByTestId("project-tree-panel-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("board-right-stub")).toBeNull();
    expect(screen.getByTestId("board-right-empty")).toBeInTheDocument();
  });
});
