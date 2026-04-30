import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// The KPI bar, every child tab, and the embedded board all rely on
// react-query hooks. This suite only cares about the dispatch logic
// (which tab renders for a given `?tab=` param), so we stub the heavy
// children with marker divs that surface their projectId. A dedicated
// integration suite per tab covers the actual content.
vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBar: ({ projectId }: { projectId: string }) => (
    <div data-testid="mission-control-kpi-bar">kpi:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/PlanTab", () => ({
  PlanTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="plan-tab">plan:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/RunsTab", () => ({
  RunsTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="runs-tab">runs:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/TemplatesSchedulesTab", () => ({
  TemplatesSchedulesTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="templates-schedules-tab">ts:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/ConfigTab", () => ({
  ConfigTab: ({ projectId }: { projectId: string }) => (
    <div data-testid="config-tab">config:{projectId}</div>
  ),
}));
vi.mock("@/pages/project-detail-components/CreateTaskFromProjectDialog", () => ({
  CreateTaskFromProjectDialog: () => (
    <div data-testid="create-task-from-project-dialog" />
  ),
}));
vi.mock("@/components/todo-md-dialog", () => ({
  TodoMdDialog: () => null,
}));

// The page header hooks into `useProject` / `useProjectConfig` /
// `useAttention` / `useCreateChat`. Stub them so we never hit the
// network.
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
    useAttention: () => ({ items: [], total: 0 }),
    useCreateChat: () => ({ isPending: false, mutateAsync: vi.fn() }),
    // The Git Pull button on the page header calls `useGitPullProject()`
    // unconditionally — stub it so the dispatch suite doesn't need a
    // react-query provider.
    useGitPullProject: () => ({ isPending: false, mutate: vi.fn() }),
  };
});

// Import AFTER the mocks so the page picks up the mocked modules.
import ProjectDetailPage from "@/pages/project-detail";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
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
  it("renders the Plan tab by default when no ?tab= is set", () => {
    renderAt("/projects/proj-123");

    // Radix Tabs keeps all panels mounted. Assert that the Plan tab's
    // panel is the active one (data-state="active") and that the Runs
    // panel is inactive.
    const planContent = screen.getByTestId("plan-tab");
    expect(planContent).toBeInTheDocument();
    expect(planContent).toHaveTextContent("plan:proj-123");

    const tabsRoot = screen.getByTestId("project-detail-tabs");
    expect(tabsRoot).toBeInTheDocument();
  });

  it("switches to the Runs tab when ?tab=runs is set", () => {
    renderAt("/projects/proj-123?tab=runs");
    const runs = screen.getByTestId("runs-tab");
    expect(runs).toHaveTextContent("runs:proj-123");
  });

  it("switches to the Config tab when ?tab=config is set", () => {
    renderAt("/projects/proj-123?tab=config");
    expect(screen.getByTestId("config-tab")).toHaveTextContent(
      "config:proj-123",
    );
  });

  it("switches to Templates & Schedules when ?tab=templates-schedules is set", () => {
    renderAt("/projects/proj-123?tab=templates-schedules");
    expect(screen.getByTestId("templates-schedules-tab")).toHaveTextContent(
      "ts:proj-123",
    );
  });

  it("falls back to Plan when ?tab= is garbage", () => {
    renderAt("/projects/proj-123?tab=not-a-tab");
    expect(screen.getByTestId("plan-tab")).toBeInTheDocument();
  });

  it("always mounts the KPI bar regardless of the active tab", () => {
    renderAt("/projects/proj-123?tab=runs");
    expect(screen.getByTestId("mission-control-kpi-bar")).toHaveTextContent(
      "kpi:proj-123",
    );
  });
});
