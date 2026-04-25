/**
 * Contract tests for {@link WorkspacePlanTab}.
 *
 * The tab's job is narrow: compose {@link ProjectsAccordion} and
 * {@link DependencyGraphCard} in that order, driven by
 * `useWorkspaceDashboard` and `useWorkspaceDependencyGraph`. The KPI
 * bar, StatCard grid, and Recharts `BarChart` / `PieChart` that used
 * to sit next to the accordion are intentionally NOT part of the tab
 * body — the page-level KPI bar (slice 00) replaced them.
 *
 * The corner cases we guard:
 *
 *   1. Happy path — dashboard has project summaries AND the graph
 *      has nodes+waves → ProjectsAccordion renders before
 *      DependencyGraphCard, and both are in the document.
 *   2. No graph — graph has no nodes/waves → accordion renders but
 *      DependencyGraphCard does NOT render (prevents an empty-card
 *      artifact on fresh workspaces).
 *   3. Loading — dashboard hasn't resolved yet → skeleton renders
 *      instead of either component, so consumers don't flash an
 *      empty accordion on first paint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
  WorkspaceProjectSummary,
} from "@/lib/types";

// Mock shape is driven by per-test variables so each case can swap
// payloads without remounting the `vi.mock` factory.
let mockDashboard: WorkspaceDashboard | undefined;
let mockDashboardLoading = false;
let mockGraph: WorkspaceDependencyGraph | undefined;

vi.mock("@/lib/hooks", () => ({
  useWorkspaceDashboard: () => ({
    data: mockDashboard,
    isLoading: mockDashboardLoading,
    error: null,
  }),
  useWorkspaceDependencyGraph: () => ({
    data: mockGraph,
    isLoading: false,
    error: null,
  }),
}));

// Import after the mock so the component resolves the stubbed hooks.
import { WorkspacePlanTab } from "@/pages/workspace-detail-components/WorkspacePlanTab";

function makeSummary(
  overrides: Partial<WorkspaceProjectSummary> = {},
): WorkspaceProjectSummary {
  return {
    project_id: "p-1",
    project_name: "Project One",
    milestone_count: 2,
    active_milestone_count: 1,
    completed_milestone_count: 0,
    total_slices: 0,
    active_slices: 0,
    completed_slices: 0,
    failed_slices: 0,
    running_tasks: 0,
    queued_tasks: 0,
    tree: {
      id: "p-1",
      name: "Project One",
      description: null,
      path: null,
      workspace_id: null,
      repo_url: null,
      provider_fallback_chain: null,
      allowed_key_ids: null,
      gitignore_flockctl: false,
      gitignore_todo: false,
      gitignore_agents_md: false,
      created_at: "2026-04-23T00:00:00.000Z",
      updated_at: "2026-04-23T00:00:00.000Z",
      milestones: [],
    } as WorkspaceProjectSummary["tree"],
    ...overrides,
  };
}

function makeDashboard(
  summaries: WorkspaceProjectSummary[],
): WorkspaceDashboard {
  return {
    workspace_id: "ws-1",
    workspace_name: "Alpha",
    project_summaries: summaries,
    total_projects: summaries.length,
    total_milestones: 0,
    active_milestones: 0,
    total_slices: 0,
    active_slices: 0,
    completed_slices: 0,
    running_tasks: 0,
    queued_tasks: 0,
    project_count: summaries.length,
    active_tasks: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    pending_milestones: 0,
    active_milestones_count: 0,
    completed_milestones: 0,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    cost_by_project: [],
    recent_activity: [],
  };
}

beforeEach(() => {
  mockDashboard = undefined;
  mockDashboardLoading = false;
  mockGraph = undefined;
  document.body.innerHTML = "";
});

describe("WorkspacePlanTab", () => {
  it("renders ProjectsAccordion BEFORE DependencyGraphCard when both have data", () => {
    mockDashboard = makeDashboard([makeSummary()]);
    mockGraph = {
      workspace_id: "ws-1",
      nodes: [
        {
          milestone_id: "m-1",
          title: "M One",
          project_id: "p-1",
          project_name: "Project One",
          status: "active",
          depends_on: [],
        },
      ],
      waves: [["m-1"]],
      errors: [],
    };

    render(<WorkspacePlanTab workspaceId="ws-1" />);

    // Both sections present.
    const accordion = screen.getByTestId("workspace-projects-accordion");
    const graph = screen.getByText("Dependency Graph");
    expect(accordion).toBeTruthy();
    expect(graph).toBeTruthy();

    // Order contract: ProjectsAccordion first, DependencyGraphCard
    // second. `compareDocumentPosition` returns FOLLOWING (4) when
    // `accordion` appears earlier in the DOM than `graph`.
    const graphCard = graph.closest("[data-slot='card']") ?? graph;
     
    const accordionBeforeGraph =
      accordion.compareDocumentPosition(graphCard) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    expect(accordionBeforeGraph).toBeTruthy();
  });

  it("does not render DependencyGraphCard when the graph has no nodes+waves", () => {
    mockDashboard = makeDashboard([makeSummary()]);
    mockGraph = {
      workspace_id: "ws-1",
      nodes: [],
      waves: [],
      errors: [],
    };

    render(<WorkspacePlanTab workspaceId="ws-1" />);

    expect(screen.getByTestId("workspace-projects-accordion")).toBeTruthy();
    // "Dependency Graph" is the card title — absent when graph is empty.
    expect(screen.queryByText("Dependency Graph")).toBeNull();
  });

  it("renders a skeleton while the dashboard is loading and no data is cached", () => {
    mockDashboard = undefined;
    mockDashboardLoading = true;

    const { container } = render(<WorkspacePlanTab workspaceId="ws-1" />);

    // Neither the accordion nor the graph has rendered yet.
    expect(
      screen.queryByTestId("workspace-projects-accordion"),
    ).toBeNull();
    expect(screen.queryByText("Dependency Graph")).toBeNull();

    // The tab's root is the skeleton wrapper — it should still carry
    // the tab's testid so page-level tests can still find it.
    const root = screen.getByTestId("workspace-plan-tab");
    expect(root).toBeTruthy();
    // At least one `Skeleton` (shadcn uses `data-slot='skeleton'` or a
    // `.animate-pulse` class); we just assert the root has children.
    expect(container.querySelectorAll("*").length).toBeGreaterThan(1);
  });
});
