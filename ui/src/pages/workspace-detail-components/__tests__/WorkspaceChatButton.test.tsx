import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// The workspace-detail shell wires in the KPI bar, every tab body, the
// dependency-graph card, the projects accordion, and the workspace-level
// TODO dialog. None of those matter for exercising the header Chat
// button — stub them with marker divs so the suite can focus on the
// button's chat-creation / navigation contract.
vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBarView: () => <div data-testid="kpi-bar-view" />,
}));
vi.mock("@/pages/workspace-detail-components/AddProjectDialog", () => ({
  AddProjectDialog: () => <div data-testid="add-project-dialog" />,
}));
vi.mock("@/pages/workspace-detail-components/DependencyGraphCard", () => ({
  DependencyGraphCard: () => <div data-testid="dep-graph" />,
}));
vi.mock("@/pages/workspace-detail-components/WorkspaceTemplatesSection", () => ({
  WorkspaceTemplatesSection: () => <div data-testid="templates-section" />,
}));
vi.mock("@/components/todo-md-dialog", () => ({
  TodoMdDialog: () => null,
}));
vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({
    open: false,
    targetId: null,
    onOpenChange: vi.fn(),
    requestConfirm: vi.fn(),
    reset: vi.fn(),
  }),
}));
// Recharts pulls in a DOM layout engine that jsdom doesn't fully back.
// The Chat button doesn't depend on chart rendering, so stub out every
// Recharts primitive used by the page.
vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    BarChart: Passthrough,
    Bar: () => null,
    PieChart: Passthrough,
    Pie: () => null,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    ResponsiveContainer: Passthrough,
    CartesianGrid: () => null,
    Legend: () => null,
  };
});

// The page header hooks into `useWorkspace`, `useWorkspaceDashboard`,
// `useWorkspaceDependencyGraph`, `useAttention`, `useChats`, and
// `useCreateChat`. We stub all of them so no network call leaks and we
// can control the chat-list / mutation state from each test.
const createChatMock = vi.fn<(args: unknown) => Promise<{ id: string }>>();
const useCreateChatState: { isPending: boolean } = { isPending: false };
const chatsFixture: { data: Array<{ id: string; updated_at: string }> } = {
  data: [],
};

vi.mock("@/lib/hooks", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/hooks")>("@/lib/hooks");
  return {
    ...actual,
    useWorkspace: () => ({
      data: {
        id: "ws-abc",
        name: "WS Abc",
        description: null,
        path: "/tmp/ws",
        allowed_key_ids: null,
        gitignore_flockctl: false,
        gitignore_todo: false,
        gitignore_agents_md: false,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
        projects: [],
      },
      isLoading: false,
      error: null,
    }),
    useRemoveProjectFromWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    useWorkspaceDashboard: () => ({ data: null, isLoading: false }),
    useWorkspaceDependencyGraph: () => ({ data: null }),
    useAttention: () => ({ items: [], total: 0, isLoading: false }),
    useChats: () => chatsFixture,
    useCreateChat: () => ({
      isPending: useCreateChatState.isPending,
      mutateAsync: createChatMock,
    }),
  };
});

// Import AFTER the mocks so the page picks up the mocked modules.
import WorkspaceDetailPage from "@/pages/workspace-detail";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/workspaces/:workspaceId"
          element={<WorkspaceDetailPage />}
        />
        <Route path="/chats/:chatId" element={<div data-testid="chat-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  createChatMock.mockReset();
  useCreateChatState.isPending = false;
  chatsFixture.data = [];
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
});

describe("WorkspaceDetailPage — header Chat button", () => {
  it("renders a Chat button in the header matching the Projects shape", () => {
    renderAt("/workspaces/123");
    const btn = screen.getByTestId("workspace-detail-page-chat");
    // The Projects button markup uses the "Chat" label (and swaps in
    // "Creating…" while the mutation is in flight). A regression to the
    // previous "AI Chat" copy should fail here.
    expect(btn).toHaveTextContent("Chat");
    expect(btn).not.toHaveTextContent("AI Chat");
  });

  it("creates a workspace-scoped chat and navigates to it when none exist", async () => {
    chatsFixture.data = [];
    createChatMock.mockResolvedValue({ id: "new-chat-1" });

    renderAt("/workspaces/123");
    fireEvent.click(screen.getByTestId("workspace-detail-page-chat"));

    expect(createChatMock).toHaveBeenCalledTimes(1);
    expect(createChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 123 }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-page")).toBeInTheDocument(),
    );
  });

  it("routes to the most recent existing chat instead of creating a new one", async () => {
    chatsFixture.data = [
      { id: "older", updated_at: "2025-01-01T00:00:00Z" },
      { id: "newer", updated_at: "2025-06-01T00:00:00Z" },
    ];

    renderAt("/workspaces/123");
    fireEvent.click(screen.getByTestId("workspace-detail-page-chat"));

    expect(createChatMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("chat-page")).toBeInTheDocument(),
    );
  });

  it("debounces rapid clicks by disabling the button while creating", () => {
    useCreateChatState.isPending = true;

    renderAt("/workspaces/123");
    const btn = screen.getByTestId("workspace-detail-page-chat");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Creating…");
  });

  it("drops the two-column flex layout that reserved space for the chat panel", () => {
    renderAt("/workspaces/123");
    const page = screen.getByTestId("workspace-detail-page");
    // The retired layout wrapped the page in `flex gap-6` to reserve
    // space for the side panel. The page root is now the single column
    // itself, so `flex gap-6` must not appear on it OR on its parent.
    expect(page.className).not.toContain("gap-6");
    expect(page.parentElement?.className ?? "").not.toContain("gap-6");
  });
});
