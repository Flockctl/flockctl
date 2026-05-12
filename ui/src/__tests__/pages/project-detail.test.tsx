import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * Integration / page-assembly tests for the redesigned project-detail
 * page (M23 / 00-project-detail / T09).
 *
 * These tests pin the **assembly contract** of `project-detail.tsx`:
 *
 *   1. The page renders the page chrome — header → ProjectKpiRow →
 *      ProjectTabs — in order, regardless of which tab is active.
 *   2. The Plan branch (default tab) renders `MilestoneRail` +
 *      `MilestoneKanban` directly inside a 260px / 1fr grid.
 *   3. Every other tab renders its dedicated tab component
 *      (`RunsTab`, `ProjectCodeMode`, `TemplatesAndSchedulesTab`,
 *      `ConfigTab`).
 *   4. Switching tabs swaps **only** the inner pane: the header /
 *      KPI / tab strip remain mounted (we assert by node identity).
 *
 * Heavy children (each tab component, the Git dropdown, the TodoMd
 * dialog) are stubbed so the test stays focused on the page-level
 * assembly. The KPI row and tab strip are NOT stubbed — they're part
 * of the assembly contract under test.
 */

// --- Hook stubs --------------------------------------------------------------

const PROJECT_FIXTURE = {
  id: "p-1",
  name: "Project One",
  description: "A short description",
  repo_url: "git@github.com:org/repo.git",
  path: "/Users/me/work/project-one",
  workspace_id: 1,
  provider_fallback_chain: null,
  allowed_key_ids: null,
  gitignore_flockctl: false,
  gitignore_todo: false,
  gitignore_agents_md: false,
  use_project_claude_skills: false,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

const MILESTONE_FIXTURE = {
  id: "m-1",
  project_id: "p-1",
  title: "Milestone One",
  description: null,
  status: "active",
  order_index: 0,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
  slices: [
    {
      id: "s-1",
      milestone_id: "m-1",
      title: "Slice One",
      description: null,
      status: "active",
      order_index: 0,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      tasks: [],
    },
  ],
};

const TREE_FIXTURE = { milestones: [MILESTONE_FIXTURE] };

vi.mock("@/lib/hooks", () => ({
  useProject: () => ({
    data: PROJECT_FIXTURE,
    isLoading: false,
    error: null,
  }),
  useProjectConfig: () => ({
    data: { baseBranch: "main" },
    isLoading: false,
    error: null,
  }),
  useProjectTree: () => ({
    data: TREE_FIXTURE,
    isLoading: false,
    error: null,
  }),
  useMissions: () => ({
    // ProjectTreePanel reads `data.items` defensively (`?? []`), so an
    // empty list keeps the panel rendering missions-less. The Tree pane
    // test only needs the panel to mount without crashing.
    data: { items: [] },
    isLoading: false,
    error: null,
  }),
  useAttention: () => ({ items: [], isLoading: false, error: null }),
  useCreateChat: () => ({
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ id: "chat-1" }),
  }),
}));

vi.mock("@/lib/use-kpi-data", () => ({
  useKpiData: () => ({
    slicesDone: 1,
    slicesTotal: 4,
    activeTasks: 2,
    pendingApproval: 0,
    failed24h: 0,
    tokens24h: 1234,
    costCents24h: 500, // $5.00
    isLoading: {
      slicesDone: false,
      slicesTotal: false,
      activeTasks: false,
      pendingApproval: false,
      failed24h: false,
      tokens24h: false,
      costCents24h: false,
    },
    error: {
      slicesDone: null,
      slicesTotal: null,
      activeTasks: null,
      pendingApproval: null,
      failed24h: null,
      tokens24h: null,
      costCents24h: null,
    },
  }),
}));

vi.mock("@/lib/recent-store", () => ({
  useTrackRecent: () => undefined,
}));

// Stub heavy children so the assembly test doesn't pay for their data
// fetching or DOM weight. Each stub renders a marker `<div>` carrying a
// stable test-id so the test can pin which branch was rendered.
vi.mock("@/pages/project-detail-components/RunsTab", () => ({
  RunsTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="runs-tab-stub" data-project-id={projectId} />
  ),
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="runs-tab-stub" data-project-id={projectId} />
  ),
}));

vi.mock("@/pages/project-detail-components/CodeMode", () => ({
  ProjectCodeMode: ({ projectId }: { projectId: string }) => (
    <div data-testid="code-mode-stub" data-project-id={projectId} />
  ),
}));

vi.mock("@/pages/project-detail-components/TemplatesAndSchedulesTab", () => ({
  TemplatesAndSchedulesTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="templates-tab-stub" data-project-id={projectId} />
  ),
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="templates-tab-stub" data-project-id={projectId} />
  ),
}));

vi.mock("@/pages/project-detail-components/ConfigTab", () => ({
  ConfigTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="config-tab-stub" data-project-id={projectId} />
  ),
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="config-tab-stub" data-project-id={projectId} />
  ),
}));

// Header chrome — Git dropdown + TODO dialog are not part of the
// assembly contract under test and pull in additional API hooks.
vi.mock("@/components/git/git-dropdown-button", () => ({
  GitDropdownButton: () => (
    <div data-testid="git-dropdown-stub">git-dropdown</div>
  ),
}));
vi.mock("@/components/todo-md-dialog", () => ({
  TodoMdDialog: () => null,
}));

// MilestoneKanban → SliceCard pulls in design-system imports we don't
// want to stub at random. Render a thin marker so the test can verify
// the kanban was instantiated for the active milestone.
vi.mock("@/pages/project-detail-components/MilestoneKanban", () => ({
  MilestoneKanban: ({
    milestoneTitle,
  }: {
    milestoneTitle: string;
    slices: unknown[];
  }) => (
    <div data-testid="milestone-kanban-stub" data-milestone-title={milestoneTitle}>
      kanban for {milestoneTitle}
    </div>
  ),
  default: ({ milestoneTitle }: { milestoneTitle: string }) => (
    <div data-testid="milestone-kanban-stub" data-milestone-title={milestoneTitle}>
      kanban for {milestoneTitle}
    </div>
  ),
}));

// Imported AFTER all mocks above so it picks up the stubbed deps.
import ProjectDetailPage from "@/pages/project-detail";

// --- helpers -----------------------------------------------------------------

function renderPage(initialUrl = "/projects/p-1") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
});

// --- tests -------------------------------------------------------------------

describe("project-detail page — assembly", () => {
  it("renders header (with embedded ProjectTabs) → ProjectKpiRow in DOM order", () => {
    renderPage();
    const header = screen.getByTestId("project-detail-header");
    const kpi = screen.getByTestId("project-kpi-row");
    const tabs = screen.getByTestId("project-detail-tabs");

    // All three pieces of chrome are present.
    expect(header).toBeInTheDocument();
    expect(kpi).toBeInTheDocument();
    expect(tabs).toBeInTheDocument();

    // The tab strip lives INSIDE the header (per the prototype layout
    // — same row as the project title, right side).
    expect(header.contains(tabs)).toBe(true);

    // And the header still appears before the KPI row in document
    // order. compareDocumentPosition returns DOCUMENT_POSITION_FOLLOWING
    // (4) when `other` follows `node`.
    expect(
      header.compareDocumentPosition(kpi) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the project title and repo / base-branch badges in the header", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Project One",
    );
    expect(
      screen.getByText("git@github.com:org/repo.git"),
    ).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });

  it("ProjectKpiRow renders all 5 tiles with the wired stat values", () => {
    renderPage();
    const row = screen.getByTestId("project-kpi-row");
    // "1 / 4" — slicesDone / slicesTotal from the stubbed kpi.
    expect(within(row).getByText("1 / 4")).toBeInTheDocument();
    // "$5.00" — costCents24h=500 → costUsd=5 → "$5.00".
    expect(within(row).getByText("$5.00")).toBeInTheDocument();
  });
});

describe("project-detail page — Plan tab (default)", () => {
  it("renders MilestoneRail + MilestoneKanban inside a 260px / 1fr grid", () => {
    renderPage();
    const pane = screen.getByTestId("project-detail-plan-pane");
    expect(pane).toBeInTheDocument();
    expect(pane.className).toContain("grid-cols-[260px_1fr]");

    // Both the rail and the kanban (stub) live inside the plan pane.
    expect(within(pane).getByTestId("milestone-rail")).toBeInTheDocument();
    expect(
      within(pane).getByTestId("milestone-kanban-stub"),
    ).toBeInTheDocument();
  });

  it("MilestoneKanban receives the active milestone title", () => {
    renderPage();
    expect(
      screen.getByTestId("milestone-kanban-stub").getAttribute(
        "data-milestone-title",
      ),
    ).toBe("Milestone One");
  });

  it("does NOT render any other tab's content while Plan is active", () => {
    renderPage();
    expect(screen.queryByTestId("runs-tab-stub")).toBeNull();
    expect(screen.queryByTestId("code-mode-stub")).toBeNull();
    expect(screen.queryByTestId("config-tab-stub")).toBeNull();
    expect(screen.queryByTestId("project-detail-board-pane")).toBeNull();
    expect(screen.queryByTestId("project-detail-tree-pane")).toBeNull();
  });

  it("the active pane records the current tab via data-active-tab", () => {
    renderPage();
    expect(
      screen.getByTestId("project-detail-pane").getAttribute(
        "data-active-tab",
      ),
    ).toBe("plan");
  });
});

describe("project-detail page — tab switching swaps only the inner pane", () => {
  it("?tab=runs renders the RunsTab component", async () => {
    renderPage("/projects/p-1?tab=runs");
    // RunsTab is lazy-loaded behind `<Suspense>` (audit-round-7 fix).
    const stub = await screen.findByTestId("runs-tab-stub");
    expect(stub).toBeInTheDocument();
    expect(stub.getAttribute("data-project-id")).toBe("p-1");
    // Plan branch is not rendered.
    expect(screen.queryByTestId("project-detail-plan-pane")).toBeNull();
  });

  it("?tab=code renders ProjectCodeMode", async () => {
    renderPage("/projects/p-1?tab=code");
    // ProjectCodeMode is lazy-loaded (React.lazy → import()) so the stub
    // appears asynchronously inside the Suspense boundary. findByTestId
    // wraps the resolution in act() and waits for the suspended chunk.
    const stub = await screen.findByTestId("code-mode-stub");
    expect(stub).toBeInTheDocument();
    expect(stub.getAttribute("data-project-id")).toBe("p-1");
  });

  it("?tab=board falls back to Plan (board tab was removed)", () => {
    renderPage("/projects/p-1?tab=board");
    // `board` is no longer a known tab id, so the route normaliser falls
    // back to the default Plan pane.
    expect(screen.getByTestId("project-detail-plan-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("project-detail-board-pane")).toBeNull();
    expect(
      screen.getByTestId("project-detail-pane").getAttribute(
        "data-active-tab",
      ),
    ).toBe("plan");
  });

  it("?tab=tree renders the hierarchical tree pane", () => {
    renderPage("/projects/p-1?tab=tree");
    expect(screen.getByTestId("project-detail-tree-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("project-detail-plan-pane")).toBeNull();
  });

  it("?tab=config renders ConfigTab", () => {
    renderPage("/projects/p-1?tab=config");
    const stub = screen.getByTestId("config-tab-stub");
    expect(stub).toBeInTheDocument();
    expect(stub.getAttribute("data-project-id")).toBe("p-1");
  });

  it("an unknown ?tab= value falls back to the Plan branch", () => {
    renderPage("/projects/p-1?tab=mystery");
    expect(screen.getByTestId("project-detail-plan-pane")).toBeInTheDocument();
    expect(
      screen.getByTestId("project-detail-pane").getAttribute(
        "data-active-tab",
      ),
    ).toBe("plan");
  });

  it("clicking a tab swaps the inner pane WITHOUT remounting the chrome", async () => {
    const user = userEvent.setup();
    renderPage();

    // Snapshot the chrome elements BEFORE the click. Because the page
    // mounts the header / KPI / tabs unconditionally, the very same DOM
    // nodes must still be present after a tab change.
    const headerBefore = screen.getByTestId("project-detail-header");
    const kpiBefore = screen.getByTestId("project-kpi-row");
    const tabsBefore = screen.getByTestId("project-detail-tabs");
    const planPaneBefore = screen.getByTestId("project-detail-plan-pane");

    // Click the Runs tab.
    await user.click(screen.getByRole("tab", { name: "Runs" }));

    // Inner pane swapped: Plan gone, Runs stub mounted.
    expect(screen.queryByTestId("project-detail-plan-pane")).toBeNull();
    expect(screen.getByTestId("runs-tab-stub")).toBeInTheDocument();
    expect(planPaneBefore.isConnected).toBe(false);

    // Chrome survived. Same node references — no remount.
    expect(screen.getByTestId("project-detail-header")).toBe(headerBefore);
    expect(screen.getByTestId("project-kpi-row")).toBe(kpiBefore);
    expect(screen.getByTestId("project-detail-tabs")).toBe(tabsBefore);

    // The active-tab marker on the pane wrapper updates.
    expect(
      screen.getByTestId("project-detail-pane").getAttribute(
        "data-active-tab",
      ),
    ).toBe("runs");
  });

  it("flipping back from Runs → Plan keeps the chrome stable too", async () => {
    const user = userEvent.setup();
    renderPage("/projects/p-1?tab=runs");
    const headerBefore = screen.getByTestId("project-detail-header");
    const kpiBefore = screen.getByTestId("project-kpi-row");

    await user.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByTestId("project-detail-plan-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("runs-tab-stub")).toBeNull();
    expect(screen.getByTestId("project-detail-header")).toBe(headerBefore);
    expect(screen.getByTestId("project-kpi-row")).toBe(kpiBefore);
  });
});
