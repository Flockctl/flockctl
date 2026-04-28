import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ProjectTreePanel } from "@/pages/project-detail-components/ProjectTreePanel";
import type {
  MilestoneTree,
  PlanSliceTree,
  ProjectTree,
} from "@/lib/types";
import type { Mission } from "@/lib/hooks";

/**
 * Slice 11/04 — ProjectTreePanel renders the new `mission` node level.
 *
 * Mocking surface:
 *   - `useProjectTree(projectId)` — drives the milestone/slice tree.
 *   - `useMissions(projectId)`    — drives the mission node row(s).
 *
 * The panel must:
 *   1. Render a mission row above its child milestones (mission_id match).
 *   2. Render orphan milestones (no/empty/dangling mission_id) at root.
 *   3. Render a no-missions project unchanged from the pre-mission layout.
 *   4. Forward mission clicks to `onSelectMission(missionId)`.
 *   5. Render 5 peer missions side-by-side at root (slice 05 edge case).
 */

vi.mock("@/lib/hooks", () => ({
  useProjectTree: vi.fn(),
  useMissions: vi.fn(),
}));
import { useProjectTree, useMissions } from "@/lib/hooks";

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

function makeSlice(id: string, milestoneId: string): PlanSliceTree {
  return {
    id,
    milestone_id: milestoneId,
    title: `Slice ${id}`,
    description: null,
    status: "pending",
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

function makeMilestone(
  id: string,
  title: string,
  slices: PlanSliceTree[] = [],
  extra: Record<string, unknown> = {},
): MilestoneTree {
  const base = {
    id,
    project_id: "p1",
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

function makeMission(id: string, objective: string): Mission {
  return {
    id,
    project_id: "1",
    objective,
    status: "active",
    autonomy: "suggest",
    budget_tokens: 1_000_000,
    budget_usd_cents: 5_000,
    spent_tokens: 0,
    spent_usd_cents: 0,
    supervisor_prompt_version: "v1",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  };
}

function tree(milestones: MilestoneTree[]): ProjectTree {
  return { milestones } as unknown as ProjectTree;
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
  asMock(useProjectTree).mockReset();
  asMock(useMissions).mockReset();
});

// ---------------------------------------------------------------------------

describe("project_tree_panel_renders_mission_node — basic rendering", () => {
  it("renders a mission row above its child milestone(s)", () => {
    const ms = makeMilestone(
      "m1",
      "Onboarding revamp",
      [makeSlice("s1", "m1")],
      { mission_id: "mission-1" },
    );
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([ms])));
    asMock(useMissions).mockReturnValue(
      mockQuery({
        items: [makeMission("mission-1", "Ship the new onboarding flow")],
      }),
    );

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const treeEl = screen.getByRole("tree");
    const mission = screen.getByTestId("tree-mission-mission-1");
    expect(mission).toBeInTheDocument();
    // Mission row sits at aria-level=1.
    expect(mission.getAttribute("aria-level")).toBe("1");

    // The milestone is a CHILD of the mission, not a sibling at root.
    const milestone = within(mission).getByTestId("tree-milestone-m1");
    expect(milestone.getAttribute("aria-level")).toBe("2");

    // The mission's objective is the visible label.
    expect(
      within(treeEl).getByText("Ship the new onboarding flow"),
    ).toBeInTheDocument();
  });

  it("renders orphan milestones (no mission_id) at root", () => {
    const orphan = makeMilestone("m-orphan", "Orphan milestone");
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([orphan])));
    asMock(useMissions).mockReturnValue(mockQuery({ items: [] }));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const milestone = screen.getByTestId("tree-milestone-m-orphan");
    // Orphan ⇒ aria-level=1 (no mission parent).
    expect(milestone.getAttribute("aria-level")).toBe("1");
    expect(screen.queryByTestId(/^tree-mission-/)).toBeNull();
  });

  it("milestone with dangling mission_id renders at root (orphan fallback)", () => {
    const dangling = makeMilestone(
      "m-ghost",
      "Dangling mission",
      [],
      { mission_id: "mission-ghost" },
    );
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([dangling])));
    // missions list does NOT contain `mission-ghost` — the milestone must
    // render at root rather than be hidden under a phantom parent.
    asMock(useMissions).mockReturnValue(mockQuery({ items: [] }));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const milestone = screen.getByTestId("tree-milestone-m-ghost");
    expect(milestone.getAttribute("aria-level")).toBe("1");
  });

  it("milestone with empty-string mission_id is treated as orphan", () => {
    const empty = makeMilestone("m-empty", "Empty mission_id", [], {
      mission_id: "",
    });
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([empty])));
    asMock(useMissions).mockReturnValue(mockQuery({ items: [] }));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    expect(
      screen.getByTestId("tree-milestone-m-empty").getAttribute("aria-level"),
    ).toBe("1");
  });

  it("a no-missions project is visually unchanged (milestones at root)", () => {
    const a = makeMilestone("m1", "Foundations");
    const b = makeMilestone("m2", "Polish");
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([a, b])));
    asMock(useMissions).mockReturnValue(mockQuery({ items: [] }));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    const treeEl = screen.getByRole("tree");
    const items = within(treeEl).getAllByRole("treeitem");
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.getAttribute("aria-level")).toBe("1");
    }
    expect(screen.queryByTestId(/^tree-mission-/)).toBeNull();
  });
});

describe("project_tree_panel_renders_mission_node — selection + clicks", () => {
  it("clicking a mission row fires onSelectMission(id)", async () => {
    const ms = makeMilestone("m1", "Onboarding", [], {
      mission_id: "mission-1",
    });
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([ms])));
    asMock(useMissions).mockReturnValue(
      mockQuery({ items: [makeMission("mission-1", "Mission One")] }),
    );

    const onSelectMission = vi.fn();
    const user = userEvent.setup();

    render(
      wrap(
        <ProjectTreePanel
          projectId="p1"
          onSelectMission={onSelectMission}
        />,
      ),
    );

    await user.click(
      within(screen.getByTestId("tree-mission-mission-1")).getByText(
        "Mission One",
      ),
    );
    expect(onSelectMission).toHaveBeenCalledWith("mission-1");
  });

  it("marks the selected mission with aria-selected=true", () => {
    const m1 = makeMilestone("m1", "M1", [], { mission_id: "mission-1" });
    const m2 = makeMilestone("m2", "M2", [], { mission_id: "mission-2" });
    asMock(useProjectTree).mockReturnValue(mockQuery(tree([m1, m2])));
    asMock(useMissions).mockReturnValue(
      mockQuery({
        items: [
          makeMission("mission-1", "First mission"),
          makeMission("mission-2", "Second mission"),
        ],
      }),
    );

    render(
      wrap(
        <ProjectTreePanel projectId="p1" selectedMissionId="mission-2" />,
      ),
    );

    expect(
      screen.getByTestId("tree-mission-mission-1").getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      screen.getByTestId("tree-mission-mission-2").getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("project_tree_panel_renders_mission_node — five peer missions (slice 05 edge case)", () => {
  it("renders 5 peer missions side-by-side at the root level", () => {
    const milestones: MilestoneTree[] = [];
    const missions: Mission[] = [];
    for (let i = 1; i <= 5; i++) {
      const mid = `mission-${i}`;
      missions.push(makeMission(mid, `Mission ${i}`));
      milestones.push(
        makeMilestone(`m${i}`, `Milestone ${i}`, [], { mission_id: mid }),
      );
    }
    asMock(useProjectTree).mockReturnValue(mockQuery(tree(milestones)));
    asMock(useMissions).mockReturnValue(mockQuery({ items: missions }));

    render(wrap(<ProjectTreePanel projectId="p1" />));

    // All five mission nodes are present at root.
    for (let i = 1; i <= 5; i++) {
      const node = screen.getByTestId(`tree-mission-mission-${i}`);
      expect(node).toBeInTheDocument();
      expect(node.getAttribute("aria-level")).toBe("1");
    }

    // Each mission has its single child milestone visible (default-expanded).
    for (let i = 1; i <= 5; i++) {
      const childMs = within(
        screen.getByTestId(`tree-mission-mission-${i}`),
      ).getByTestId(`tree-milestone-m${i}`);
      expect(childMs.getAttribute("aria-level")).toBe("2");
    }
  });
});
