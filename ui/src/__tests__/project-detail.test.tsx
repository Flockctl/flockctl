import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The KPI bar, every child tab, and the embedded board all rely on
// react-query hooks. This suite only cares about the dispatch logic
// (which tab renders for a given `?tab=` param), so we stub the heavy
// children with marker divs that surface their projectId. A dedicated
// integration suite per tab covers the actual content.
//
// Mock targets follow the page's actual import graph. The page imports
// `ProjectKpiRow` (KPI strip), `MilestoneRail` + `MilestoneKanban` for
// the plan tab, `RunsTab`, `ProjectCodeMode`, `ConfigTab`, and
// `ProjectTreePanel` for the tree tab.
vi.mock("@/pages/project-detail-components/ProjectKpiRow", () => ({
  ProjectKpiRow: () => <div data-testid="project-kpi-row">kpi</div>,
}));
vi.mock("@/pages/project-detail-components/MilestoneRail", () => ({
  MilestoneRail: () => <div data-testid="milestone-rail">rail</div>,
}));
vi.mock("@/pages/project-detail-components/MilestoneKanban", () => ({
  MilestoneKanban: () => <div data-testid="milestone-kanban">kanban</div>,
}));
vi.mock("@/pages/project-detail-components/RunsTab", () => ({
  RunsTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="runs-tab">runs:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/ConfigTab", () => ({
  ConfigTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="config-tab">config:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/CodeMode", () => ({
  ProjectCodeMode: ({ projectId }: { projectId: string }) => (
    <div data-testid="code-mode">code:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/ProjectTreePanel", () => ({
  ProjectTreePanel: () => <div data-testid="project-tree-panel">tree</div>,
}));
vi.mock("@/components/todo-md-dialog", () => ({
  TodoMdDialog: () => null,
}));

// The page header hooks into `useProject` / `useProjectConfig` /
// `useAttention` / `useCreateChat` and the page body calls
// `useKpiData(projectId)` / `useProjectTree(projectId)`. Stub them so
// we never hit the network — react-query still wraps the page (a few
// hooks remain un-stubbed and need the provider).
vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useProject: () => ({
      data: {
        id: "proj-123",
        name: "Proj 123",
        description: null,
        repo_url: "git@example.com:proj.git",
        path: null,
        workspace_id: null,
        provider_fallback_chain: null,
        allowed_key_ids: null,
        gitignore_flockctl: false,
        gitignore_todo: false,
        gitignore_agents_md: false,
        use_project_claude_skills: false,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      isLoading: false,
      error: null,
    }),
    useProjectConfig: () => ({ data: { baseBranch: "main" } }),
    useProjectTree: () => ({ data: { milestones: [] }, isLoading: false }),
    useAttention: () => ({ items: [], total: 0 }),
    useCreateChat: () => ({ isPending: false, mutateAsync: vi.fn() }),
    // The Git dropdown on the page header calls `useGitPullProject()`
    // AND `useGitPullWorkspace()` unconditionally (rules-of-hooks;
    // dispatch on `target.kind` picks the active branch). Stub both so
    // the dispatch suite doesn't need a real react-query provider.
    useGitPullProject: () => ({ isPending: false, mutate: vi.fn() }),
    useGitPullWorkspace: () => ({ isPending: false, mutate: vi.fn() }),
  };
});

// `useKpiData` lives in its own module (not under `@/lib/hooks`).
vi.mock("@/lib/use-kpi-data", () => ({
  useKpiData: () => ({
    activeTasks: 0,
    pendingApproval: 0,
    failed24h: 0,
    costCents24h: 0,
    costBudgetCents: null,
    isLoading: { activeTasks: false, pendingApproval: false, failed24h: false, cost: false },
  }),
}));

// Import AFTER the mocks so the page picks up the mocked modules.
import ProjectDetailPage from "@/pages/project-detail";

function renderAt(path: string) {
  // A few hooks (`useProjectTree` is mocked, but the page also calls
  // `useTrackRecent`/`useSelection` which subscribe transitively) still
  // expect a `QueryClientProvider` somewhere up the tree. A retry-less
  // client keeps the suite deterministic.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore — private mode / stubbed storage */
  }
});

describe("ProjectDetailPage tab dispatch", () => {
  it("renders the Plan pane by default when no ?tab= is set", () => {
    renderAt("/projects/proj-123");

    // The Plan tab renders the milestone rail + the empty-state placeholder
    // (no milestones in the stub) inside `project-detail-plan-pane`.
    expect(screen.getByTestId("project-detail-plan-pane")).toBeInTheDocument();
    expect(screen.getByTestId("project-detail-tabs")).toBeInTheDocument();
  });

  it("switches to the Runs tab when ?tab=runs is set", async () => {
    renderAt("/projects/proj-123?tab=runs");
    // RunsTab is now lazy-loaded behind a `<Suspense>` boundary (audit-
    // round-7 bundle fix). The mock module resolves in a microtask, so
    // we wait for the testid to appear rather than asserting
    // synchronously.
    expect(await screen.findByTestId("runs-tab")).toHaveTextContent("runs:proj-123");
  });

  it("switches to the Config tab when ?tab=config is set", () => {
    renderAt("/projects/proj-123?tab=config");
    expect(screen.getByTestId("config-tab")).toHaveTextContent(
      "config:proj-123",
    );
  });

  it("switches to the Tree tab when ?tab=tree is set", () => {
    renderAt("/projects/proj-123?tab=tree");
    expect(screen.getByTestId("project-detail-tree-pane")).toBeInTheDocument();
  });

  it("falls back to Plan when ?tab= is garbage", () => {
    renderAt("/projects/proj-123?tab=not-a-tab");
    expect(screen.getByTestId("project-detail-plan-pane")).toBeInTheDocument();
  });

  it("always mounts the KPI row regardless of the active tab", () => {
    renderAt("/projects/proj-123?tab=runs");
    expect(screen.getByTestId("project-kpi-row")).toBeInTheDocument();
  });
});
