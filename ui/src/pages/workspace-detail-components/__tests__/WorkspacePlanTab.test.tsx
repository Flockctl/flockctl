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
import { render, screen, fireEvent } from "@testing-library/react";
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
// `mockRemoveMutate` is captured by the factory closure below.
// Declared BEFORE `vi.mock` so it exists by the time the mock
// factory is first invoked; per-test resets happen in `beforeEach`.
const mockRemoveMutate = vi.fn();

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
  // ProjectsAccordion now embeds AddProjectDialog AND a per-row
  // Remove button gated by ConfirmDialog, so it transitively pulls
  // in three more hooks. Stub them out — these tests are not
  // exercising the add/remove mutation flows (those have their own
  // dedicated tests); we just need the components to render their
  // trigger UI without throwing.
  useProjects: () => ({ data: [], isLoading: false, error: null }),
  useAddProjectToWorkspace: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRemoveProjectFromWorkspace: () => ({
    mutate: mockRemoveMutate,
    isPending: false,
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
  mockRemoveMutate.mockReset();
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

  it("always exposes an 'Add Project' trigger on the Plan tab — both when projects exist AND when the workspace is empty", () => {
    // Regression guard. The Plan tab is the ONLY place in the UI that
    // surfaces the affordance to attach a project to a workspace. A
    // previous refactor extracted ProjectsAccordion out of the inline
    // workspace-detail card and quietly dropped the `AddProjectDialog`
    // mount — leaving the dialog component in the tree but unreachable
    // from the UI, with `flockctl workspace link` as the only escape
    // hatch. Assert the button is reachable in BOTH the populated and
    // empty cases so we catch any future split that loses one branch.

    // Case 1: workspace has projects → button still present in header.
    mockDashboard = makeDashboard([makeSummary()]);
    const populated = render(<WorkspacePlanTab workspaceId="ws-1" />);
    expect(
      screen.getAllByRole("button", { name: /add project/i }).length,
    ).toBeGreaterThan(0);
    populated.unmount();

    // Case 2: workspace has zero projects → without the button there
    // is no UI path to attach the FIRST project. This is the
    // regression we are guarding against.
    mockDashboard = makeDashboard([]);
    render(<WorkspacePlanTab workspaceId="ws-1" />);
    expect(
      screen.getAllByRole("button", { name: /add project/i }).length,
    ).toBeGreaterThan(0);
  });

  it("exposes a 'Remove' trigger on every project row", () => {
    // Regression guard, mirror of the Add Project test above. The
    // Plan tab is also the ONLY UI affordance for detaching a project
    // from a workspace. Assert every row carries its own removal
    // trigger, scoped by project_id so a future single-button
    // refactor that loses per-row scoping fails this test.
    mockDashboard = makeDashboard([
      makeSummary({ project_id: "p-1", project_name: "Project One" }),
      makeSummary({ project_id: "p-2", project_name: "Project Two" }),
    ]);

    render(<WorkspacePlanTab workspaceId="ws-1" />);

    expect(screen.getByTestId("workspace-project-remove-p-1")).toBeTruthy();
    expect(screen.getByTestId("workspace-project-remove-p-2")).toBeTruthy();
  });

  it("clicking 'Remove' opens a confirmation dialog and only fires the mutation after confirm", () => {
    // Integration-style: walks the full detach flow. The confirm
    // gate is critical because the Remove button lives inside a
    // <summary> row and a single click could plausibly be intended
    // as "expand the project". If this test passes with mutate fired
    // on the first click, we have lost the confirmation gate.
    mockDashboard = makeDashboard([
      makeSummary({ project_id: "p-1", project_name: "Project One" }),
    ]);

    render(<WorkspacePlanTab workspaceId="ws-1" />);

    // First click on the row Remove button should NOT fire the
    // mutation — it should only request confirmation.
    fireEvent.click(screen.getByTestId("workspace-project-remove-p-1"));
    expect(mockRemoveMutate).not.toHaveBeenCalled();

    // The ConfirmDialog now renders. Its body must reference the
    // project name so users know what they are detaching. We match
    // partial because the description has surrounding copy.
    expect(
      screen.getByText(/Project One.*detached from this workspace/),
    ).toBeTruthy();

    // The confirm button is the destructive-variant one labelled
    // "Remove" — distinct from the row trigger above. We pick it via
    // role+name to avoid collision with the row trigger.
    const confirmButtons = screen.getAllByRole("button", { name: /^remove$/i });
    // Two buttons share the name: the per-row trigger AND the
    // dialog confirm. Click the dialog one (the last in DOM order
    // since the dialog is appended at the end).
    const dialogConfirm = confirmButtons[confirmButtons.length - 1];
    expect(dialogConfirm).toBeDefined();
    fireEvent.click(dialogConfirm!);

    expect(mockRemoveMutate).toHaveBeenCalledTimes(1);
    const firstCall = mockRemoveMutate.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0]).toEqual({ workspaceId: "ws-1", projectId: "p-1" });
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
