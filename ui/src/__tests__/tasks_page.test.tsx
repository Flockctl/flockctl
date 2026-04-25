import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { Task, Project, TaskFilters } from "@/lib/types";
import { TaskStatus } from "@/lib/types";

/**
 * Contract tests for the /tasks page view-mode dispatcher.
 *
 * Corner cases guarded here:
 *
 *   1. Table mode is the default and renders byte-for-byte — users have
 *      saved filters + workflows tied to it, so the legacy filter bar
 *      (project / status / agent) must appear on `/tasks` with no `?view=`.
 *   2. An unknown `?view=` value falls back to the table.
 *   3. The legacy `?view=cards` value also falls back to the table — the
 *      cards view was removed; saved bookmarks must not 404 or render an
 *      empty page.
 *   4. `?view=kanban` mounts the cross-project Kanban with one swim-lane
 *      per status bucket. The status counts mirror the bucketing rule
 *      defined in `KANBAN_COLUMNS`.
 *   5. Kanban cards expose the project label, the AI key label, and the
 *      model that actually ran (preferring `actual_model_used` over the
 *      requested `model`, falling back to "Default" when both are null).
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
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<div data-testid="task-detail" />} />
      </Routes>
    </MemoryRouter>,
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

describe("tasks_page view-mode dispatch", () => {
  it("tasks_page renders the existing table view by default (baseline)", () => {
    renderAt("/tasks");

    expect(screen.getByTestId("tasks-table-view")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Created after")).toBeInTheDocument();
    expect(screen.getByText("Created before")).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-kanban-view")).toBeNull();
  });

  it("tasks_page falls back to table when ?view= is garbage (view param fallback)", () => {
    renderAt("/tasks?view=not-a-real-mode");
    expect(screen.getByTestId("tasks-table-view")).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-kanban-view")).toBeNull();
  });

  it("tasks_page treats the legacy ?view=cards as table (cards view removed)", () => {
    // The cards view was retired; we keep the URL guard so any saved
    // bookmark (or external link) continues to land on a useful page
    // instead of rendering an empty / unknown shell.
    renderAt("/tasks?view=cards");
    expect(screen.getByTestId("tasks-table-view")).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-kanban-view")).toBeNull();
  });

  it("tasks_page renders the kanban with one column per status bucket when ?view=kanban", () => {
    tasksItems = [
      makeTask({ id: "q-1", status: TaskStatus.queued }),
      makeTask({ id: "r-1", status: TaskStatus.running }),
      makeTask({ id: "p-1", status: TaskStatus.pending_approval }),
      makeTask({ id: "d-1", status: TaskStatus.done }),
      makeTask({ id: "f-1", status: TaskStatus.failed }),
      makeTask({ id: "f-2", status: TaskStatus.timed_out }),
    ];
    renderAt("/tasks?view=kanban");

    expect(screen.getByTestId("tasks-kanban-view")).toBeInTheDocument();
    // Five columns; failed + timed_out share the "Failed" lane.
    expect(screen.getByTestId("tasks-kanban-count-queued")).toHaveTextContent(
      "1",
    );
    expect(screen.getByTestId("tasks-kanban-count-running")).toHaveTextContent(
      "1",
    );
    expect(
      screen.getByTestId("tasks-kanban-count-pending_approval"),
    ).toHaveTextContent("1");
    expect(screen.getByTestId("tasks-kanban-count-done")).toHaveTextContent(
      "1",
    );
    expect(screen.getByTestId("tasks-kanban-count-failed")).toHaveTextContent(
      "2",
    );
  });

  it("tasks_page kanban card surfaces project label, AI key label and the actual model used", () => {
    tasksItems = [
      makeTask({
        id: "r-1",
        status: TaskStatus.running,
        project_id: "p-alpha",
        assigned_key_label: "Prod Anthropic",
        // task.model was the *requested* model; actual_model_used is what
        // the provider actually billed against. The kanban card must show
        // the latter.
        model: "claude-opus-4",
        actual_model_used: "claude-sonnet-4",
      }),
    ];
    renderAt("/tasks?view=kanban");

    const card = screen.getByTestId("tasks-kanban-card");
    expect(within(card).getByText("Alpha")).toBeInTheDocument();
    expect(within(card).getByTestId("tasks-kanban-card-key")).toHaveTextContent(
      "Prod Anthropic",
    );
    expect(
      within(card).getByTestId("tasks-kanban-card-model"),
    ).toHaveTextContent("claude-sonnet-4");
  });

  it("tasks_page kanban card falls back to task.model and 'Default' when usage is absent", () => {
    tasksItems = [
      makeTask({
        id: "r-1",
        status: TaskStatus.running,
        model: "claude-opus-4",
        actual_model_used: null,
        assigned_key_label: null,
      }),
      makeTask({
        id: "q-1",
        status: TaskStatus.queued,
        model: null,
        actual_model_used: null,
      }),
    ];
    renderAt("/tasks?view=kanban");

    // Cards are bucketed by status into separate columns, so we pick them
    // by `data-task-id` rather than render order. The fallback chain is:
    // actual_model_used → task.model → "Default".
    const allCards = screen.getAllByTestId("tasks-kanban-card");
    const byId = (id: string) => {
      const el = allCards.find((c) => c.getAttribute("data-task-id") === id);
      if (!el) throw new Error(`no card for ${id}`);
      return el;
    };
    expect(
      within(byId("r-1")).getByTestId("tasks-kanban-card-model"),
    ).toHaveTextContent("claude-opus-4");
    expect(
      within(byId("q-1")).getByTestId("tasks-kanban-card-model"),
    ).toHaveTextContent("Default");
  });
});
