import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TasksPage from "@/pages/tasks";

/**
 * Page-level assembly tests for `/tasks` (slice 24-00 T05).
 *
 * Lower-level pieces (table, filters, bulk toolbar, bulk-mutate) have
 * their own dedicated test files. This spec verifies that the page
 * wires the existing primitives together correctly:
 *
 *   - SectionHeader → TasksFilters → (TasksBulkToolbar when selection > 0) → TasksTable
 *   - URL filter contract reaches the backend (`?status=` → `TaskFilters.status`)
 *   - Empty / filtered-empty / search-empty states pick the right copy
 *   - Selecting a row reveals the bulk toolbar; clearing it hides it
 *
 * The page reads from React Query, so each test mounts its own client
 * with retries disabled. The fetch stub returns the seeded payloads.
 */

// Radix Dialog (CreateTaskDialog) touches ResizeObserver during layout.
// jsdom doesn't ship one — same shim every other dialog-bearing page test uses.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

interface SeededTask {
  id: string;
  status: string;
  prompt: string | null;
  prompt_file: string | null;
  agent: string | null;
  model: string | null;
  actual_model_used: string | null;
  timeout_seconds: number;
  project_id: string | null;
  assigned_key_id: number | null;
  assigned_key_label: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  working_dir: string | null;
  created_at: string;
  updated_at: string;
  git_commit_before: string | null;
  git_commit_after: string | null;
  git_diff_summary: string | null;
  requires_approval: boolean;
  approval_status: string | null;
  approved_at: string | null;
  approval_note: string | null;
  permission_mode: null;
  parent_task_id: null;
}

function makeTask(overrides: Partial<SeededTask> = {}): SeededTask {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: "task-1",
    status: "running",
    prompt: "Refactor authentication module",
    prompt_file: null,
    agent: "claude",
    model: null,
    actual_model_used: null,
    timeout_seconds: 300,
    project_id: "p1",
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: null,
    started_at: now,
    completed_at: null,
    working_dir: null,
    created_at: now,
    updated_at: now,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchSeed {
  tasks?: SeededTask[];
  projects?: Array<{ id: string; name: string }>;
  stats?: Partial<{
    total: number;
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    done: number;
    failed: number;
    timed_out: number;
    cancelled: number;
    failed_rerun: number;
    failed_not_rerun: number;
    superseded_failures: number;
    build_after_rerun: number;
    avg_duration_seconds: number | null;
  }>;
  /** Captures every tasks-list URL we got asked for. */
  taskRequests?: string[];
}

function installFetchStub(seed: FetchSeed = {}) {
  const tasks = seed.tasks ?? [];
  const projects = seed.projects ?? [];
  const stats = {
    total: tasks.length,
    queued: tasks.filter((t) => t.status === "queued").length,
    assigned: 0,
    running: tasks.filter((t) => t.status === "running").length,
    completed: 0,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    timed_out: 0,
    cancelled: 0,
    failed_rerun: 0,
    failed_not_rerun: 0,
    superseded_failures: 0,
    build_after_rerun: 0,
    avg_duration_seconds: null,
    ...(seed.stats ?? {}),
  };
  const taskRequests = seed.taskRequests ?? [];

  (globalThis as any).fetch = vi.fn(async (rawUrl: string) => {
    const url = String(rawUrl);
    if (url.endsWith("/tasks") || url.includes("/tasks?")) {
      taskRequests.push(url);
      return jsonResponse({ items: tasks, total: tasks.length });
    }
    if (url.endsWith("/projects") || url.includes("/projects?")) {
      return jsonResponse({ items: projects, total: projects.length });
    }
    if (url.includes("/tasks/stats")) {
      return jsonResponse(stats);
    }
    if (url.includes("/keys")) {
      return jsonResponse({ items: [], total: 0 });
    }
    return jsonResponse({});
  });
}

function renderPage(initialEntry = "/tasks") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  installFetchStub();
});

describe("TasksPage / header + assembly", () => {
  it("renders the page SectionHeader with title 'Tasks'", async () => {
    installFetchStub({
      tasks: [makeTask()],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Tasks",
    });
    expect(heading).toBeInTheDocument();
  });

  it("renders the SectionHeader subtitle once stats load (N active · M completed today)", async () => {
    installFetchStub({
      tasks: [makeTask({ id: "t-r", status: "running" })],
      projects: [{ id: "p1", name: "Alpha" }],
      stats: { running: 2, queued: 1, assigned: 0, done: 0, total: 3 },
    });
    renderPage();
    // 2 running + 1 queued = 3 active. No completed_at today = 0 completed.
    await screen.findByText(/3 active\s*·\s*0 completed today/);
  });

  it("renders TasksFilters in the assembled body (status segment + project + range + search)", async () => {
    installFetchStub({
      tasks: [makeTask()],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();

    expect(await screen.findByTestId("tasks-filters")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-status-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-project-select")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-range-select")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-search-input")).toBeInTheDocument();
  });

  it("renders the TasksTable for non-empty rowsets", async () => {
    installFetchStub({
      tasks: [makeTask({ id: "task-aaa", prompt: "hello world" })],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();

    expect(await screen.findByTestId("tasks-table")).toBeInTheDocument();
    expect(await screen.findByText("hello world")).toBeInTheDocument();
  });

  it("does NOT render the bulk toolbar when nothing is selected", async () => {
    installFetchStub({
      tasks: [makeTask({ id: "t1", status: "queued" })],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();

    await screen.findByTestId("tasks-table");
    expect(screen.queryByTestId("tasks-bulk-toolbar")).not.toBeInTheDocument();
  });
});

describe("TasksPage / selection → bulk toolbar reveal", () => {
  it("shows the TasksBulkToolbar when the user selects at least one row", async () => {
    installFetchStub({
      tasks: [
        makeTask({ id: "task-a1", status: "queued", prompt: "First" }),
        makeTask({ id: "task-b2", status: "running", prompt: "Second" }),
      ],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();

    await screen.findByTestId("tasks-table");
    const checkboxes = await screen.findAllByTestId("tasks-table-row-checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);

    await userEvent.click(checkboxes[0]!);

    await waitFor(() => {
      expect(screen.getByTestId("tasks-bulk-toolbar")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("tasks-bulk-toolbar-count"),
    ).toHaveTextContent("1 selected");
  });

  it("hides the toolbar when the user clears the selection via the ✕", async () => {
    installFetchStub({
      tasks: [makeTask({ id: "t1", status: "queued" })],
      projects: [{ id: "p1", name: "Alpha" }],
    });
    renderPage();

    await screen.findByTestId("tasks-table");
    const [first] = await screen.findAllByTestId("tasks-table-row-checkbox");
    await userEvent.click(first!);
    await screen.findByTestId("tasks-bulk-toolbar");

    await userEvent.click(screen.getByTestId("tasks-bulk-toolbar-clear"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("tasks-bulk-toolbar"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("TasksPage / URL filter → backend wiring", () => {
  it("forwards `?status=running` to the backend as TaskFilters.status=running", async () => {
    const taskRequests: string[] = [];
    installFetchStub({
      tasks: [],
      projects: [{ id: "p1", name: "Alpha" }],
      taskRequests,
    });
    renderPage("/tasks?status=running");

    await waitFor(() => {
      expect(
        taskRequests.some((u) => u.includes("status=running")),
      ).toBe(true);
    });
  });

  it("forwards `?status=pending` as TaskFilters.status=queued (audit mapping)", async () => {
    const taskRequests: string[] = [];
    installFetchStub({
      tasks: [],
      projects: [{ id: "p1", name: "Alpha" }],
      taskRequests,
    });
    renderPage("/tasks?status=pending");

    await waitFor(() => {
      expect(
        taskRequests.some((u) => u.includes("status=queued")),
      ).toBe(true);
    });
  });

  it("forwards `?project_id=` to the backend", async () => {
    const taskRequests: string[] = [];
    installFetchStub({
      tasks: [],
      projects: [{ id: "p1", name: "Alpha" }],
      taskRequests,
    });
    renderPage("/tasks?project_id=p1");

    await waitFor(() => {
      expect(
        taskRequests.some((u) => u.includes("project_id=p1")),
      ).toBe(true);
    });
  });
});

describe("TasksPage / empty states", () => {
  it("shows the initial empty state when there are no tasks and no filters", async () => {
    installFetchStub({ tasks: [], projects: [] });
    renderPage();

    expect(
      await screen.findByTestId("tasks-empty-state"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("tasks-table")).not.toBeInTheDocument();
  });

  it("shows the filtered empty state when there are no tasks but filters are active", async () => {
    installFetchStub({ tasks: [], projects: [{ id: "p1", name: "Alpha" }] });
    renderPage("/tasks?status=failed");

    expect(
      await screen.findByTestId("tasks-filtered-empty-state"),
    ).toBeInTheDocument();
  });
});
