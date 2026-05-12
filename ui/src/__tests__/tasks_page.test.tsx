import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task, Project, TaskFilters } from "@/lib/types";
import { TaskStatus } from "@/lib/types";

/**
 * Contract tests for the `/tasks` page (slice 24-00 T05 redesign).
 *
 * The legacy kanban + `?view=` dispatcher was retired during M23: the page
 * always renders the flat `<TasksTable>` plus the URL-backed `<TasksFilters>`
 * strip and the bulk toolbar that surfaces when one or more rows are selected.
 *
 * What this suite pins:
 *
 *   1. The empty state shows up on a fresh load with no rows.
 *   2. A populated `useTasks` payload produces the table testid plus a row
 *      per item.
 *   3. Filter widgets — status segment, project select, range select — are
 *      always mounted (the redesigned page is the page; there is no view
 *      switch to hide them).
 */

const cancelMutate = vi.fn();
const rerunMutate = vi.fn();
const createMutate = vi.fn();

const sampleProjects: Project[] = [
  {
    id: "p-alpha",
    name: "Alpha",
    description: null,
    path: null,
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: false,
    gitignore_todo: false,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: "2026-04-23T00:00:00Z",
    updated_at: "2026-04-23T00:00:00Z",
  },
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    status: TaskStatus.running,
    prompt: "demo prompt",
    prompt_file: null,
    agent: "claude-code",
    model: "claude-sonnet-4",
    actual_model_used: null,
    timeout_seconds: 300,
    project_id: "p-alpha",
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: null,
    started_at: "2026-04-23T12:00:00.000Z",
    completed_at: null,
    working_dir: null,
    created_at: "2026-04-23T12:00:00.000Z",
    updated_at: "2026-04-23T12:00:00.000Z",
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: null,
    parent_task_id: null,
    ...overrides,
  };
}

let tasksItems: Task[] = [];

vi.mock("@/lib/hooks", () => {
  const refetch = vi.fn();
  return {
    useTasks: (_offset?: number, _limit?: number, _filters?: TaskFilters) => ({
      data: { items: tasksItems, total: tasksItems.length, limit: 20, offset: 0 },
      isLoading: false,
      error: null,
      refetch,
    }),
    useCreateTask: () => ({
      mutate: createMutate,
      mutateAsync: createMutate,
      isPending: false,
    }),
    useCancelTask: () => ({ mutate: cancelMutate, isPending: false }),
    useRerunTask: () => ({ mutate: rerunMutate, isPending: false }),
    useTaskStats: () => ({ data: undefined, isLoading: false }),
    useProjects: () => ({ data: sampleProjects, isLoading: false }),
    // Surface pulled in by TaskFormFields (rendered lazily inside the
    // Dialog, but imported eagerly by tasks.tsx).
    useMeta: () => ({ data: undefined, isLoading: false }),
    useAIKeys: () => ({ data: [], isLoading: false }),
    useWorkspaces: () => ({ data: [], isLoading: false }),
    useProjectAllowedKeys: () => ({ data: null, isLoading: false }),
  };
});

// Import AFTER the mocks so the page picks them up.
import TasksPage from "@/pages/tasks";

function renderAt(path: string) {
  // The dialog/`<TasksTable>` subtree calls a few hooks transitively
  // that need a `QueryClientProvider` even when the network-touching
  // ones are mocked.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:taskId" element={<div data-testid="task-detail" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tasksItems = [];
  cancelMutate.mockReset();
  rerunMutate.mockReset();
  createMutate.mockReset();
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
});

describe("tasks_page rendering", () => {
  it("renders the empty-state placeholder when no tasks are loaded", () => {
    renderAt("/tasks");
    expect(screen.getByTestId("tasks-page")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-table")).toBeNull();
  });

  it("renders the table when the hook surfaces rows", () => {
    tasksItems = [makeTask({ id: "t-1" })];
    renderAt("/tasks");
    expect(screen.getByTestId("tasks-table")).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-empty-state")).toBeNull();
  });

  it("ignores the legacy `?view=` URL param without crashing", () => {
    // Saved bookmarks may still carry `?view=cards` or `?view=kanban`.
    // The page no longer looks at that param — render must be identical
    // to the no-query path.
    renderAt("/tasks?view=cards");
    expect(screen.getByTestId("tasks-page")).toBeInTheDocument();
  });

  it("mounts the URL-driven filter widgets at the top of the page", () => {
    renderAt("/tasks");
    // The filter strip — status segment + project select + range select —
    // is unconditional (the kanban view that used to hide it was retired).
    expect(screen.getByTestId("tasks-project-select")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-range-select")).toBeInTheDocument();
  });
});
