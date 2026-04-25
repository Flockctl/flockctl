/**
 * Keyboard navigation tests for `ProjectTreePanel`.
 *
 * These cover the Arrow-key half of the WAI-ARIA tree pattern:
 *   - ArrowDown / ArrowUp walk visible nodes (no wrap).
 *   - ArrowRight expands a collapsed parent, then descends into children.
 *   - ArrowLeft collapses an open parent, and jumps a slice to its parent.
 *   - An ArrowKey with no prior focus falls to the first visible node.
 *   - A 30-milestone tree walks the full list without getting stuck.
 *   - Roving tabindex: exactly one node is tabIndex=0.
 *
 * The sibling file `keyboard_enter.test.tsx` covers Enter / selection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ProjectTreePanel } from "@/pages/project-detail-components/ProjectTreePanel";
import type { ProjectTree } from "@/lib/types";

vi.mock("@/lib/hooks", () => ({
  useProjectTree: vi.fn(),
}));
import { useProjectTree } from "@/lib/hooks";

const asMock = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

function wrap(children: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeMilestone(
  id: string,
  title: string,
  slices: { id: string; title: string }[] = [],
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    slices: slices.map((s, i) => ({
      id: s.id,
      milestone_id: id,
      title: s.title,
      description: null,
      status: "pending",
      risk: "low",
      depends: null,
      demo: null,
      goal: null,
      success_criteria: null,
      order_index: i,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      tasks: [],
    })),
  };
}

function tree(milestones: ReturnType<typeof makeMilestone>[]): ProjectTree {
  return { milestones } as unknown as ProjectTree;
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
  asMock(useProjectTree).mockReset();
});

// --- Helpers ---------------------------------------------------------------

/** Focus the tree by focusing the roving-tabindex node (tabIndex=0). */
async function focusTree() {
  const tree_ = screen.getByRole("tree");
  const roving = within(tree_)
    .getAllByRole("treeitem")
    .find((el) => el.getAttribute("tabindex") === "0");
  if (!roving) throw new Error("no roving-tabindex treeitem found");
  act(() => roving.focus());
}

function activeNodeId(): string | null {
  const el = document.activeElement as HTMLElement | null;
  return el?.getAttribute("data-testid") ?? null;
}

// --- Tests -----------------------------------------------------------------

describe("ProjectTreePanel — keyboard_arrow_down (down/up navigation)", () => {
  it("ArrowDown moves focus to the next visible milestone", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "A"),
          makeMilestone("m2", "B"),
          makeMilestone("m3", "C"),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    await focusTree();
    expect(activeNodeId()).toBe("tree-milestone-m1");

    await user.keyboard("{ArrowDown}");
    expect(activeNodeId()).toBe("tree-milestone-m2");

    await user.keyboard("{ArrowDown}");
    expect(activeNodeId()).toBe("tree-milestone-m3");
  });

  it("ArrowDown does NOT wrap at the last node", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "A"), makeMilestone("m2", "B")])),
    );
    const user = userEvent.setup();
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedMilestoneId="m2" />),
    );

    await focusTree();
    expect(activeNodeId()).toBe("tree-milestone-m2");

    await user.keyboard("{ArrowDown}");
    // Still on m2 — no wrap.
    expect(activeNodeId()).toBe("tree-milestone-m2");
  });

  it("ArrowUp walks back through visible nodes (no wrap at top)", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "A"),
          makeMilestone("m2", "B"),
          makeMilestone("m3", "C"),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedMilestoneId="m3" />),
    );

    await focusTree();
    expect(activeNodeId()).toBe("tree-milestone-m3");

    await user.keyboard("{ArrowUp}");
    expect(activeNodeId()).toBe("tree-milestone-m2");

    await user.keyboard("{ArrowUp}");
    expect(activeNodeId()).toBe("tree-milestone-m1");

    await user.keyboard("{ArrowUp}");
    // Already at the top — no wrap.
    expect(activeNodeId()).toBe("tree-milestone-m1");
  });

  it("ArrowRight on a collapsed parent expands it, second press descends into children", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Parent", [
            { id: "s1", title: "First" },
            { id: "s2", title: "Second" },
          ]),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    await focusTree();
    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("false");

    // First ArrowRight expands the milestone but keeps focus on it.
    await user.keyboard("{ArrowRight}");
    expect(milestone.getAttribute("aria-expanded")).toBe("true");
    expect(activeNodeId()).toBe("tree-milestone-m1");

    // Second ArrowRight moves focus into the first slice.
    await user.keyboard("{ArrowRight}");
    expect(activeNodeId()).toBe("tree-slice-s1");

    // ArrowDown from a slice goes to the next slice.
    await user.keyboard("{ArrowDown}");
    expect(activeNodeId()).toBe("tree-slice-s2");
  });

  it("ArrowLeft collapses an expanded parent, and jumps a slice to its parent milestone", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Parent", [{ id: "s1", title: "Slice one" }]),
        ]),
      ),
    );
    const user = userEvent.setup();
    // selectedSliceId auto-expands m1 and lands the roving tabindex on s1.
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedSliceId="s1" />),
    );

    await focusTree();
    expect(activeNodeId()).toBe("tree-slice-s1");

    // Slice → ArrowLeft jumps to the parent milestone.
    await user.keyboard("{ArrowLeft}");
    expect(activeNodeId()).toBe("tree-milestone-m1");

    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("true");

    // Milestone (expanded) → ArrowLeft collapses it. Focus stays.
    await user.keyboard("{ArrowLeft}");
    expect(milestone.getAttribute("aria-expanded")).toBe("false");
    expect(activeNodeId()).toBe("tree-milestone-m1");
    expect(screen.queryByTestId("tree-slice-s1")).toBeNull();
  });

  it("ArrowDown with no focused node falls to the first visible node", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "A"), makeMilestone("m2", "B")])),
    );
    render(wrap(<ProjectTreePanel projectId="p1" />));

    // Fire the keydown directly on the tree element without first focusing
    // any particular node — simulates the edge case where the component's
    // focusedId state is undefined (no `onFocus` has run yet) but a key
    // event reaches the handler anyway. The handler must defensively fall
    // to the first visible node rather than throwing or no-oping.
    const tree_ = screen.getByRole("tree");
    fireEvent.keyDown(tree_, { key: "ArrowDown" });

    expect(activeNodeId()).toBe("tree-milestone-m1");
  });

  it("uses a roving tabindex: exactly one node is tabIndex=0", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "A", [{ id: "s1", title: "One" }]),
          makeMilestone("m2", "B"),
        ]),
      ),
    );
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedMilestoneId="m2" />),
    );

    const tree_ = screen.getByRole("tree");
    const items = within(tree_).getAllByRole("treeitem");
    const zeroes = items.filter((it) => it.getAttribute("tabindex") === "0");
    const negOnes = items.filter((it) => it.getAttribute("tabindex") === "-1");

    expect(zeroes).toHaveLength(1);
    expect(zeroes[0]!.getAttribute("data-testid")).toBe("tree-milestone-m2");
    expect(negOnes.length).toBe(items.length - 1);
  });

  it("aria-selected follows the active node as the user navigates", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "A"), makeMilestone("m2", "B")])),
    );
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    await focusTree();
    expect(screen.getByTestId("tree-milestone-m1").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId("tree-milestone-m2").getAttribute("aria-selected")).toBe(
      "false",
    );

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("tree-milestone-m1").getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByTestId("tree-milestone-m2").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("walks a 30-milestone tree end-to-end without getting stuck", async () => {
    const milestones = Array.from({ length: 30 }, (_, i) =>
      makeMilestone(`m${i}`, `Milestone ${i}`),
    );
    asMock(useProjectTree).mockReturnValue(mockQuery(tree(milestones)));
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    await focusTree();
    expect(activeNodeId()).toBe("tree-milestone-m0");

    for (let i = 1; i < 30; i++) {
      await user.keyboard("{ArrowDown}");
      expect(activeNodeId()).toBe(`tree-milestone-m${i}`);
    }

    // One extra ArrowDown at the end MUST NOT wrap and MUST NOT throw.
    await user.keyboard("{ArrowDown}");
    expect(activeNodeId()).toBe("tree-milestone-m29");
  });
});
