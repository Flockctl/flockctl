import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ProjectTreePanel } from "@/pages/project-detail-components/ProjectTreePanel";
import type { ProjectTree } from "@/lib/types";

// --- Mock the data hook ------------------------------------------------------
//
// `ProjectTreePanel` must reuse `useProjectTree` (no new network call). We
// stub the hook directly so each test drives the panel by handing it a
// canned response — no fetch mocking needed.
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

// --- Fixture builders --------------------------------------------------------

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

function mockQuery<T>(data: T | undefined, opts: { isLoading?: boolean; error?: unknown } = {}) {
  return {
    data,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    isSuccess: opts.error == null && !opts.isLoading,
    isError: !!opts.error,
  };
}

beforeEach(() => {
  asMock(useProjectTree).mockReset();
});

// --- Tests -------------------------------------------------------------------

describe("ProjectTreePanel — aria semantics", () => {
  it("renders the container with role=tree and milestone treeitems with aria-level=1", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Foundations"),
          makeMilestone("m2", "Polish"),
        ]),
      ),
    );

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const tree_ = screen.getByRole("tree");
    expect(tree_).toBeInTheDocument();

    const items = within(tree_).getAllByRole("treeitem");
    // Two milestones, no slices visible (collapsed by default).
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.getAttribute("aria-level")).toBe("1");
    }
  });

  it("exposes aria-expanded on milestones that have slices and toggles it on click", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Has slices", [
            { id: "s1", title: "Slice one" },
            { id: "s2", title: "Slice two" },
          ]),
        ]),
      ),
    );

    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("tree-slice-s1")).toBeNull();

    await user.click(within(milestone).getByLabelText("Expand milestone"));

    expect(milestone.getAttribute("aria-expanded")).toBe("true");
    const slice = screen.getByTestId("tree-slice-s1");
    expect(slice.getAttribute("aria-level")).toBe("2");
  });

  it("omits aria-expanded on milestones that have no slices", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "Empty")])),
    );

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const milestone = screen.getByTestId("tree-milestone-m1");
    expect(milestone.hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("ProjectTreePanel — selection highlighting", () => {
  it("marks the selected milestone with aria-selected=true", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(tree([makeMilestone("m1", "A"), makeMilestone("m2", "B")])),
    );

    render(
      wrap(<ProjectTreePanel projectId="p1" selectedMilestoneId="m2" />),
    );

    expect(screen.getByTestId("tree-milestone-m1").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("tree-milestone-m2").getAttribute("aria-selected")).toBe("true");
  });

  it("auto-expands the parent milestone of a selected slice and highlights the slice", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "First", [{ id: "s1", title: "Slice one" }]),
          makeMilestone("m2", "Second", [{ id: "s2", title: "Slice two" }]),
        ]),
      ),
    );

    render(
      wrap(<ProjectTreePanel projectId="p1" selectedSliceId="s2" />),
    );

    // m2 must be expanded so the highlighted slice is actually visible.
    expect(screen.getByTestId("tree-milestone-m2").getAttribute("aria-expanded")).toBe("true");
    const slice = screen.getByTestId("tree-slice-s2");
    expect(slice.getAttribute("aria-selected")).toBe("true");

    // m1 stays collapsed — its slice is not in the DOM.
    expect(screen.queryByTestId("tree-slice-s1")).toBeNull();
  });

  it("forwards milestone and slice clicks to the provided handlers", async () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([makeMilestone("m1", "First", [{ id: "s1", title: "Slice one" }])]),
      ),
    );

    const onSelectMilestone = vi.fn();
    const onSelectSlice = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          selectedSliceId="s1"
          onSelectMilestone={onSelectMilestone}
          onSelectSlice={onSelectSlice}
        />,
      ),
    );

    await user.click(screen.getByTestId("tree-slice-s1"));
    expect(onSelectSlice).toHaveBeenCalledWith("m1", "s1");

    // Click the row inside the milestone treeitem — the click handler is on
    // the inner row div, not on the <li>, so events fired on a child are
    // what users actually trigger when clicking the title.
    await user.click(within(screen.getByTestId("tree-milestone-m1")).getByText("First"));
    expect(onSelectMilestone).toHaveBeenCalledWith("m1");
  });
});

describe("ProjectTreePanel — empty / loading / error", () => {
  it("renders the empty-state CTA when the project has no milestones and a handler is provided", async () => {
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([])));
    const onGeneratePlan = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(<ProjectTreePanel projectId="p1" onGeneratePlan={onGeneratePlan} />),
    );

    expect(screen.getByTestId("project-tree-panel-empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate plan/i }));
    expect(onGeneratePlan).toHaveBeenCalledTimes(1);
  });

  it("renders the empty-state without a CTA when no handler is provided", () => {
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([])));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    expect(screen.getByTestId("project-tree-panel-empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate plan/i })).toBeNull();
  });

  it("renders the loading skeleton while the query is in flight", () => {
    asMock(useProjectTree).mockReturnValue(mockQuery(undefined, { isLoading: true }));
    render(wrap(<ProjectTreePanel projectId="p1" />));
    expect(screen.getByTestId("project-tree-panel-loading")).toBeInTheDocument();
  });

  it("renders an error fallback when the query errors", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(undefined, { error: new Error("boom") }),
    );
    render(wrap(<ProjectTreePanel projectId="p1" />));
    expect(screen.getByTestId("project-tree-panel-error")).toBeInTheDocument();
  });
});

describe("ProjectTreePanel — scale", () => {
  it("renders 30 milestones inside a scrollable container", () => {
    const milestones = Array.from({ length: 30 }, (_, i) =>
      makeMilestone(`m${i}`, `Milestone ${i}`),
    );
    asMock(useProjectTree).mockReturnValue(mockQuery(tree(milestones)));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const container = screen.getByTestId("project-tree-panel");
    expect(container.className).toMatch(/overflow-y-auto/);
    expect(within(container).getAllByRole("treeitem")).toHaveLength(30);
  });
});

describe("ProjectTreePanel — data sourcing", () => {
  it("calls useProjectTree with the supplied projectId (no extra fetches)", () => {
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([])));
    render(wrap(<ProjectTreePanel projectId="proj-xyz" />));
    expect(useProjectTree).toHaveBeenCalledWith("proj-xyz");
  });
});
