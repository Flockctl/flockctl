import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Milestone 09 / slice 02 — integration test for the left tree panel.
 *
 * This suite mounts the full {@link ProjectDetailBoardView} shell with the
 * real {@link ProjectTreePanel} wired into the `left` slot and the live
 * {@link SliceBoard} in `center`. The only seam we mock is the network hook
 * {@link useProjectTree} so the tree data is deterministic — every
 * interaction assertion rides the real components.
 *
 * Coverage (slice contract):
 *   1. Clicking a milestone in the tree writes `?milestone=<id>` to the URL
 *      and narrows the center SliceBoard to that milestone only.
 *   2. Clicking a slice writes both `?milestone=<parent>` and `?slice=<id>`
 *      so the matching card gains the selection ring in the board.
 *   3. An initial URL with `?slice=<id>` mounts the panel with the parent
 *      milestone auto-expanded and the card highlighted in the board.
 *   4. An invalid (non-existent) milestone slug in the URL renders an
 *      empty filtered board (no crash, no leakage of the fallback
 *      all-slices view).
 *   5. An XSS-shaped `?slice=` value is rejected by useSelection's allow-
 *      list — the panel receives `undefined` and no card is highlighted.
 *   6. A 30-milestone tree renders without crashing; keyboard ArrowDown
 *      moves focus down the list and ArrowUp at the top does NOT wrap
 *      (WAI-ARIA non-wrapping contract).
 */

// --- Mocks -------------------------------------------------------------------

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
    // SliceDetailPanel (wired into the rail via SliceDetailTabs) pulls three
    // more hooks. Stub them with idle defaults so selecting a slice in the
    // tree does not boot real react-query queries that would crash without
    // a QueryClientProvider in this test's render tree.
    useAutoExecStatus: () => ({
      data: undefined,
      isLoading: false,
      error: null,
      isSuccess: true,
      isError: false,
    }),
    useStartAutoExecute: () => ({ mutate: () => {}, isPending: false }),
    useCreateChat: () => ({ mutateAsync: async () => ({ id: "chat" }), isPending: false }),
  };
});

// Silence the KPI bar — it pulls three more hooks we don't care about here.
vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBar: ({ projectId }: { projectId: string }) => (
    <div data-testid="mission-control-kpi-bar">kpi:{projectId}</div>
  ),
}));

// Import AFTER mocks so the component resolves the stubbed hook.
import { ProjectDetailBoardView } from "@/pages/project-detail-components/ProjectDetailBoardView";

// --- Fixture builders --------------------------------------------------------

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
    | "failed" = "pending",
) {
  return {
    id,
    milestone_id: milestoneId,
    title: `Slice ${id}`,
    description: null,
    status,
    risk: "low" as const,
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

function makeMilestone(
  id: string,
  title: string,
  slices: ReturnType<typeof makeSlice>[] = [],
) {
  return {
    id,
    project_id: "proj-1",
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

/**
 * Tiny probe component that surfaces the current URL search string into the
 * DOM so tests can assert URL-backed side effects without reaching into
 * router internals. It's rendered as a sibling of the board shell inside
 * the same `<MemoryRouter>`, which means it sees every `setSearchParams`
 * the panel + shell dispatch.
 */
function UrlProbe() {
  const loc = useLocation();
  return <div data-testid="url-probe">{loc.search}</div>;
}

function wrap(children: ReactNode, initialEntry = "/projects/proj-1") {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/projects/:projectId"
          element={
            <>
              {children}
              <UrlProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  useProjectTreeMock.mockReset();
});

// --- Tests -------------------------------------------------------------------

describe("ProjectTreePanel — board integration", () => {
  it("tree_milestone_click_filters_slice_board_and_updates_url", async () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("m-alpha", "Alpha", [
            makeSlice("s-a1", "m-alpha", "pending"),
            makeSlice("s-a2", "m-alpha", "active"),
          ]),
          makeMilestone("m-beta", "Beta", [
            makeSlice("s-b1", "m-beta", "completed"),
          ]),
        ],
      }),
    );

    const user = userEvent.setup();
    render(wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />));

    // Baseline: unfiltered board shows all three cards.
    const initialCards = screen.getAllByTestId("slice-card");
    expect(initialCards.map((c) => c.getAttribute("data-slice-id")).sort()).toEqual(
      ["s-a1", "s-a2", "s-b1"],
    );

    // Click the Alpha milestone row in the tree.
    const tree = screen.getByRole("tree");
    const alpha = within(tree).getByText("Alpha");
    await user.click(alpha);

    // URL gains the milestone param.
    expect(screen.getByTestId("url-probe").textContent).toContain(
      "milestone=m-alpha",
    );

    // Board now only shows Alpha's two slices.
    const filtered = screen
      .getAllByTestId("slice-card")
      .map((c) => c.getAttribute("data-slice-id"))
      .sort();
    expect(filtered).toEqual(["s-a1", "s-a2"]);
    // Beta's slice is gone.
    expect(filtered).not.toContain("s-b1");
  });

  it("tree_slice_click_writes_milestone_and_slice_and_highlights_card", async () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("m-alpha", "Alpha", [
            makeSlice("s-a1", "m-alpha", "pending"),
            makeSlice("s-a2", "m-alpha", "active"),
          ]),
        ],
      }),
    );

    const user = userEvent.setup();
    render(wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />));

    // Expand Alpha first so its slice rows render.
    await user.click(screen.getByLabelText("Expand milestone"));

    // Click slice s-a2 in the tree.
    await user.click(screen.getByTestId("tree-slice-s-a2"));

    const search = screen.getByTestId("url-probe").textContent ?? "";
    expect(search).toContain("milestone=m-alpha");
    expect(search).toContain("slice=s-a2");

    // The matching card in the board now carries data-selected="true".
    const selectedCard = document.querySelector(
      '[data-testid="slice-card"][data-slice-id="s-a2"]',
    );
    expect(selectedCard?.getAttribute("data-selected")).toBe("true");

    // The other card stays unselected — exactly one highlighted card.
    const allSelected = document.querySelectorAll(
      '[data-testid="slice-card"][data-selected="true"]',
    );
    expect(allSelected.length).toBe(1);
  });

  it("deep_linked_slice_id_auto_expands_parent_and_highlights_in_both_panes", () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("m-alpha", "Alpha", [makeSlice("s-a1", "m-alpha")]),
          makeMilestone("m-beta", "Beta", [makeSlice("s-b1", "m-beta", "active")]),
        ],
      }),
    );

    render(
      wrap(
        <ProjectDetailBoardView projectId="proj-1" mode="board" />,
        "/projects/proj-1?milestone=m-beta&slice=s-b1",
      ),
    );

    // Panel: Beta is expanded + its slice is visible.
    expect(
      screen.getByTestId("tree-milestone-m-beta").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("tree-slice-s-b1")).toBeInTheDocument();
    expect(
      screen.getByTestId("tree-slice-s-b1").getAttribute("aria-selected"),
    ).toBe("true");

    // Board: only Beta's slice renders (milestone filter), and it's selected.
    const cards = screen.getAllByTestId("slice-card");
    expect(cards.map((c) => c.getAttribute("data-slice-id"))).toEqual(["s-b1"]);
    expect(cards[0]!.getAttribute("data-selected")).toBe("true");
  });

  it("nonexistent_milestone_slug_renders_empty_filtered_board_without_crashing", () => {
    // Corner case from the slice spec: a well-formed slug that does NOT
    // match any milestone in the current tree. The board filter yields an
    // empty array, each column shows its empty-state placeholder, and the
    // page does not crash.
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("m-alpha", "Alpha", [makeSlice("s-a1", "m-alpha")]),
        ],
      }),
    );

    render(
      wrap(
        <ProjectDetailBoardView projectId="proj-1" mode="board" />,
        "/projects/proj-1?milestone=does-not-exist",
      ),
    );

    // No cards from the single real milestone bleed through.
    expect(screen.queryAllByTestId("slice-card")).toHaveLength(0);
    // Each default column still renders — empty-state placeholders are live.
    expect(
      screen.getAllByTestId("slice-board-column-empty").length,
    ).toBeGreaterThan(0);
  });

  it("xss_shaped_slice_param_is_rejected_and_no_card_is_highlighted", () => {
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          makeMilestone("m-alpha", "Alpha", [makeSlice("s-a1", "m-alpha")]),
        ],
      }),
    );

    const payload = "<script>alert('x')</script>";
    const encoded = encodeURIComponent(payload);

    render(
      wrap(
        <ProjectDetailBoardView projectId="proj-1" mode="board" />,
        `/projects/proj-1?slice=${encoded}`,
      ),
    );

    // The panel never forwards a rejected slug onto aria-selected.
    const items = screen.getAllByRole("treeitem");
    const selected = items.filter(
      (n) => n.getAttribute("aria-selected") === "true",
    );
    // The roving-tabindex fallback still marks the first visible node as
    // selected (panel contract) — but the critical check is that NO card
    // in the center board is highlighted via the rejected value.
    expect(selected.length).toBeLessThanOrEqual(1);

    const highlightedCards = document.querySelectorAll(
      '[data-testid="slice-card"][data-selected="true"]',
    );
    expect(highlightedCards.length).toBe(0);

    // And the raw payload is nowhere in the rendered DOM.
    expect(document.body.innerHTML).not.toContain(payload);
  });

  it("thirty_milestone_tree_mounts_scrollable_and_arrow_keys_do_not_wrap", async () => {
    // WAI-ARIA tree pattern: non-wrapping. We render 30 milestones, focus
    // the first one via ArrowDown, confirm focus advances, then ArrowUp
    // from the first row stays on the first row (does NOT jump to 30th).
    const milestones = Array.from({ length: 30 }, (_, i) =>
      makeMilestone(`m-${i}`, `Milestone ${i}`),
    );
    useProjectTreeMock.mockReturnValue(mockQuery({ milestones }));

    const user = userEvent.setup();
    render(wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />));

    const panel = screen.getByTestId("project-tree-panel");
    // The panel's outer container is scrollable — this is how a 30-row
    // list stays usable inside a 260px-wide rail.
    expect(panel.className).toMatch(/overflow-y-auto/);

    const items = within(panel).getAllByRole("treeitem");
    expect(items).toHaveLength(30);

    // Focus the first row to prime the roving tabindex, then navigate.
    items[0]!.focus();

    await user.keyboard("{ArrowDown}");
    // After one ArrowDown, focus advances to the second milestone.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "tree-milestone-m-1",
    );

    // ArrowUp from first row (m-0) must NOT wrap to last (m-29).
    items[0]!.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "tree-milestone-m-0",
    );
  });
});
