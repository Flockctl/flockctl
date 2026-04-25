/**
 * Enter-key + selection-handler tests for `ProjectTreePanel`.
 *
 * Enter's contract:
 *   - On a slice: fires onSelectSlice(milestoneId, sliceId) — opens the
 *     slice in the right rail.
 *   - On an expanded milestone: fires onSelectMilestone(milestoneId) only.
 *   - On a collapsed milestone with children: expands it AND fires
 *     onSelectMilestone.
 *   - On a leaf milestone (no children): fires onSelectMilestone.
 *
 * The sibling file `keyboard_arrow_down.test.tsx` covers Arrow navigation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
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

async function focusTree() {
  const tree_ = screen.getByRole("tree");
  const roving = within(tree_)
    .getAllByRole("treeitem")
    .find((el) => el.getAttribute("tabindex") === "0");
  if (!roving) throw new Error("no roving-tabindex treeitem found");
  act(() => roving.focus());
}

// --- Tests -----------------------------------------------------------------

describe("ProjectTreePanel — keyboard_enter (open / select)", () => {
  it("Enter on a slice fires onSelectSlice with (milestoneId, sliceId)", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Parent", [{ id: "s1", title: "Slice one" }]),
        ]),
      ),
    );
    const onSelectSlice = vi.fn();
    const onSelectMilestone = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          selectedSliceId="s1"
          onSelectSlice={onSelectSlice}
          onSelectMilestone={onSelectMilestone}
        />,
      ),
    );

    await focusTree();
    await user.keyboard("{Enter}");

    expect(onSelectSlice).toHaveBeenCalledTimes(1);
    expect(onSelectSlice).toHaveBeenCalledWith("m1", "s1");
    expect(onSelectMilestone).not.toHaveBeenCalled();
  });

  it("Enter on a collapsed milestone expands it AND fires onSelectMilestone", async () => {
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
    const onSelectMilestone = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          onSelectMilestone={onSelectMilestone}
        />,
      ),
    );

    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("false");

    await focusTree();
    await user.keyboard("{Enter}");

    expect(onSelectMilestone).toHaveBeenCalledWith("m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("true");
    // Children are now in the DOM.
    expect(screen.getByTestId("tree-slice-s1")).toBeInTheDocument();
    expect(screen.getByTestId("tree-slice-s2")).toBeInTheDocument();
  });

  it("Enter on an already-expanded milestone fires onSelectMilestone and keeps it expanded", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Parent", [{ id: "s1", title: "One" }]),
        ]),
      ),
    );
    const onSelectMilestone = vi.fn();
    const user = userEvent.setup();

    // selectedSliceId auto-expands m1 without shifting the roving tabindex
    // away from m1 when we also pass selectedMilestoneId.
    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          selectedSliceId="s1"
          selectedMilestoneId="m1"
          onSelectMilestone={onSelectMilestone}
        />,
      ),
    );

    // Shift the roving tabindex to m1 explicitly via keyboard (ArrowUp from s1).
    await focusTree();
    // selectedSliceId wins the tabindex battle, so start on s1 and arrow up
    // to m1 before pressing Enter.
    await user.keyboard("{ArrowLeft}"); // slice → parent
    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{Enter}");
    expect(onSelectMilestone).toHaveBeenCalledWith("m1");
    // Still expanded — Enter on an open milestone does NOT collapse it.
    expect(milestone.getAttribute("aria-expanded")).toBe("true");
  });

  it("Enter on a leaf (no-children) milestone fires onSelectMilestone without error", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "Lonely")])),
    );
    const onSelectMilestone = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          onSelectMilestone={onSelectMilestone}
        />,
      ),
    );

    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.hasAttribute("aria-expanded")).toBe(false);

    await focusTree();
    await user.keyboard("{Enter}");

    expect(onSelectMilestone).toHaveBeenCalledWith("m1");
  });

  it("Enter after keyboard-navigating to a different node targets that node", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "First"),
          makeMilestone("m2", "Second"),
          makeMilestone("m3", "Third"),
        ]),
      ),
    );
    const onSelectMilestone = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          onSelectMilestone={onSelectMilestone}
        />,
      ),
    );

    await focusTree();
    await user.keyboard("{ArrowDown}{ArrowDown}"); // m1 → m2 → m3
    await user.keyboard("{Enter}");

    expect(onSelectMilestone).toHaveBeenCalledTimes(1);
    expect(onSelectMilestone).toHaveBeenCalledWith("m3");
  });

  it("Enter does not fire a handler that was not provided", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Parent", [{ id: "s1", title: "Slice" }]),
        ]),
      ),
    );
    const user = userEvent.setup();

    // No onSelectSlice supplied — Enter on a slice must be a silent no-op,
    // not a runtime crash.
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedSliceId="s1" />),
    );

    await focusTree();
    await expect(user.keyboard("{Enter}")).resolves.toBeUndefined();
  });
});
