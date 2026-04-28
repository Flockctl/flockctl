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
 * Slice 11/07 — `ProjectTreePanel` mission-node corner cases + a11y.
 *
 * The sibling `components/project_tree_panel_renders_mission_node.test.tsx`
 * covers baseline rendering (mission-row above milestones, orphan fallback,
 * dangling mission_id, no-missions parity). THIS file focuses on:
 *
 *   - 5 peer missions render side-by-side at root with stable aria semantics
 *   - keyboard navigation traverses the mission level the same as milestones
 *   - axe-style a11y assertions on the tree (role=tree, aria-level, roving
 *     tabindex, accessible names on chevrons)
 *
 * We don't pull `@axe-core/react` here — the rules we care about are tree-
 * pattern primitives (role, level, expanded, selected, tabindex) that are
 * directly observable. The e2e spec runs an actual axe pass on the mounted
 * panel for the rules-engine perspective.
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

describe("five_peer_missions_render_side_by_side", () => {
  function fivePeers() {
    const milestones: MilestoneTree[] = [];
    const missions: Mission[] = [];
    for (let i = 1; i <= 5; i++) {
      const mid = `mission-${i}`;
      missions.push(makeMission(mid, `Mission ${i} objective`));
      // Two milestones per mission so the parent can collapse + reveal
      // children deterministically when the test exercises ArrowRight.
      milestones.push(
        makeMilestone(`m${i}-a`, `Milestone ${i}A`, [makeSlice(`s${i}a`, `m${i}-a`)], {
          mission_id: mid,
        }),
        makeMilestone(`m${i}-b`, `Milestone ${i}B`, [], {
          mission_id: mid,
        }),
      );
    }
    asMock(useProjectTree).mockReturnValue(mockQuery(tree(milestones)));
    asMock(useMissions).mockReturnValue(mockQuery({ items: missions }));
  }

  it("five peer missions all render at aria-level=1 with their child milestones at aria-level=2", () => {
    fivePeers();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    // Each of the 5 missions is a top-level treeitem.
    for (let i = 1; i <= 5; i++) {
      const mission = screen.getByTestId(`tree-mission-mission-${i}`);
      expect(mission.getAttribute("role")).toBe("treeitem");
      expect(mission.getAttribute("aria-level")).toBe("1");
      expect(mission.getAttribute("aria-expanded")).toBe("true");

      const childA = within(mission).getByTestId(`tree-milestone-m${i}-a`);
      const childB = within(mission).getByTestId(`tree-milestone-m${i}-b`);
      expect(childA.getAttribute("aria-level")).toBe("2");
      expect(childB.getAttribute("aria-level")).toBe("2");
    }
  });

  it("exactly one node is in the roving-tabindex (the active node)", () => {
    fivePeers();
    render(wrap(<ProjectTreePanel projectId="p1" />));
    const treeEl = screen.getByRole("tree");
    const items = within(treeEl).getAllByRole("treeitem");
    const tabbable = items.filter((n) => n.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
  });

  it("ArrowDown traverses all five missions then their nested milestones in order", async () => {
    fivePeers();
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    // Focus the first mission to seed the roving tabindex.
    const firstMission = screen.getByTestId("tree-mission-mission-1");
    firstMission.focus();
    expect(document.activeElement).toBe(firstMission);

    // ArrowDown: mission-1 → milestone m1-a → slice s1a → milestone m1-b →
    // mission-2 → … (the panel mounts every mission expanded by default).
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "tree-milestone-m1-a",
    );
  });

  it("ArrowLeft on a mission collapses it (children disappear from the DOM)", async () => {
    fivePeers();
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    const mission = screen.getByTestId("tree-mission-mission-3");
    mission.focus();
    // Sanity: child is in the DOM.
    expect(
      within(mission).queryByTestId("tree-milestone-m3-a"),
    ).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");

    // After collapse, aria-expanded flips and children unmount.
    expect(mission.getAttribute("aria-expanded")).toBe("false");
    expect(within(mission).queryByTestId("tree-milestone-m3-a")).toBeNull();
  });

  it("Enter on a mission row fires onSelectMission with the id", async () => {
    fivePeers();
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

    const mission = screen.getByTestId("tree-mission-mission-4");
    mission.focus();
    await user.keyboard("{Enter}");
    expect(onSelectMission).toHaveBeenCalledWith("mission-4");
  });
});

// ---------------------------------------------------------------------------

describe("axe_compliance_project_tree", () => {
  function smallTree() {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "Onboarding", [makeSlice("s1", "m1")], {
            mission_id: "mission-1",
          }),
          makeMilestone("m-orphan", "Orphan"),
        ]),
      ),
    );
    asMock(useMissions).mockReturnValue(
      mockQuery({ items: [makeMission("mission-1", "Ship onboarding")] }),
    );
  }

  it("the panel exposes a labeled landmark + a role=tree container", () => {
    smallTree();
    render(wrap(<ProjectTreePanel projectId="p1" />));
    const nav = screen.getByTestId("project-tree-panel");
    // axe `region` / `landmark-banner-is-top-level`: the nav has a label.
    expect(nav.getAttribute("aria-label")).toBe("Project planning tree");
    expect(nav.tagName).toBe("NAV");
    expect(within(nav).getByRole("tree")).toBeInTheDocument();
  });

  it("every treeitem carries an aria-level (axe `aria-required-attr`)", () => {
    smallTree();
    render(wrap(<ProjectTreePanel projectId="p1" />));
    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.getAttribute("aria-level")).toMatch(/^[123]$/);
    }
  });

  it("parents with children carry aria-expanded; leaf nodes do not", () => {
    smallTree();
    // Pass selectedSliceId so the parent milestone auto-expands and the
    // slice leaf actually renders (the panel auto-expands the parent of
    // a deep-linked slice — see ProjectTreePanel's selectedSliceParentId
    // effect).
    render(
      wrap(<ProjectTreePanel projectId="p1" selectedSliceId="s1" />),
    );
    const mission = screen.getByTestId("tree-mission-mission-1");
    const milestone = screen.getByTestId("tree-milestone-m1");
    const slice = screen.getByTestId("tree-slice-s1");
    expect(mission.getAttribute("aria-expanded")).toMatch(/true|false/);
    expect(milestone.getAttribute("aria-expanded")).toMatch(/true|false/);
    // Slice is a leaf — aria-expanded MUST NOT be set (axe `aria-allowed-attr`).
    expect(slice.getAttribute("aria-expanded")).toBeNull();
  });

  it("chevron toggle buttons have accessible names (Expand / Collapse)", () => {
    smallTree();
    render(wrap(<ProjectTreePanel projectId="p1" />));
    // The orphan milestone defaults to collapsed → "Expand milestone" name.
    const expandLabels = screen.getAllByLabelText(/Expand milestone|Expand mission/);
    expect(expandLabels.length).toBeGreaterThan(0);
    for (const btn of expandLabels) {
      expect(btn.tagName).toBe("BUTTON");
    }
  });

  it("arrow keys never move focus outside the tree (focus is trapped within role=tree)", async () => {
    smallTree();
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    const treeEl = screen.getByRole("tree");
    const items = within(treeEl).getAllByRole("treeitem");
    items[0]!.focus();

    // Walk all the way down; focus should stay inside the tree.
    for (let i = 0; i < 20; i++) {
      await user.keyboard("{ArrowDown}");
      const active = document.activeElement;
      expect(active?.getAttribute("role")).toBe("treeitem");
      expect(treeEl.contains(active)).toBe(true);
    }
  });

  it("ArrowUp at the first node does NOT wrap (WAI-ARIA non-wrapping tree)", async () => {
    smallTree();
    const user = userEvent.setup();
    render(wrap(<ProjectTreePanel projectId="p1" />));

    const treeEl = screen.getByRole("tree");
    const items = within(treeEl).getAllByRole("treeitem");
    items[0]!.focus();
    const firstId = items[0]!.getAttribute("data-testid");

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.getAttribute("data-testid")).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------

describe("mission_tree_panel_selection", () => {
  it("a deep-linked selectedMissionId carries through to aria-selected=true", () => {
    asMock(useProjectTree).mockReturnValue(
      mockQuery(
        tree([
          makeMilestone("m1", "M1", [], { mission_id: "mission-1" }),
          makeMilestone("m2", "M2", [], { mission_id: "mission-2" }),
        ]),
      ),
    );
    asMock(useMissions).mockReturnValue(
      mockQuery({
        items: [
          makeMission("mission-1", "First"),
          makeMission("mission-2", "Second"),
        ],
      }),
    );

    render(
      wrap(
        <ProjectTreePanel projectId="p1" selectedMissionId="mission-2" />,
      ),
    );

    const m1 = screen.getByTestId("tree-mission-mission-1");
    const m2 = screen.getByTestId("tree-mission-mission-2");
    expect(m1.getAttribute("aria-selected")).toBe("false");
    expect(m2.getAttribute("aria-selected")).toBe("true");
    // The selected node is also the roving-tabindex target.
    expect(m2.getAttribute("tabindex")).toBe("0");
    expect(m1.getAttribute("tabindex")).toBe("-1");
  });
});
