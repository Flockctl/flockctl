import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  TasksFilters,
  filterTasksByQuery,
  useTasksStatusFilter,
  useTasksProjectFilter,
  useTasksRangeFilter,
  type TasksFiltersProjectOption,
  type TasksStatusFilter,
  type TasksRangeFilter,
} from "@/pages/tasks-components/TasksFilters";

/**
 * Contract tests for TasksFilters (slice 24/00 T01).
 *
 * Each spec covers exactly one promise from the slice:
 *
 *   - Status SegmentToggle (All/Running/Pending/Completed/Failed) drives ?status=.
 *   - Project <select> drives ?project_id=.
 *   - Range <select> (24h/7d/30d/all) drives ?range=.
 *   - Search input is debounced 200 ms before committing to ?q=.
 *   - URL pre-population works when landing with the params already set.
 *   - filterTasksByQuery matches id + title, case-insensitive.
 *   - Default-equivalent picks (status=all, range=all, project=all) wipe
 *     the param outright instead of leaving an explicit `?status=all`
 *     in the URL — keeps shareable links tidy.
 */

// ─── Router probe ───────────────────────────────────────────────────────────
type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

function renderWithRouter(initial: string, ui: ReactNode) {
  const probe: { current: Probe } = {
    current: { pathname: "", search: "" },
  };
  render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <LocationProbe onLocation={(p) => (probe.current = p)} />
    </MemoryRouter>,
  );
  return probe;
}

// ─── Read-hook probe ────────────────────────────────────────────────────────
// Helper for asserting the URL → hook return-value contract from a single
// test. Render a tiny component that calls the hook and exposes its return
// value via a textContent attribute.

function StatusProbe() {
  const status = useTasksStatusFilter();
  return <span data-testid="status-probe">{status}</span>;
}
function ProjectProbe() {
  const projectId = useTasksProjectFilter();
  return (
    <span data-testid="project-probe">{projectId ?? "__none__"}</span>
  );
}
function RangeProbe() {
  const range = useTasksRangeFilter();
  return <span data-testid="range-probe">{range}</span>;
}

const SAMPLE_PROJECTS: TasksFiltersProjectOption[] = [
  { id: "p1", name: "Flockctl" },
  { id: "p2", name: "Marketing site" },
  { id: "p3", name: "Docs" },
];

describe("TasksFilters", () => {
  beforeEach(() => {
    // Real timers by default; specific tests opt into fake timers when
    // they need to inspect the debounce window.
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders status segment, project select, range select, and search input", () => {
    renderWithRouter(
      "/tasks",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );

    expect(screen.getByTestId("tasks-status-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-project-select")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-range-select")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /search tasks/i }),
    ).toBeInTheDocument();

    // Status segments — every option from the spec.
    for (const label of ["All", "Running", "Pending", "Completed", "Failed"]) {
      expect(
        screen.getByRole("radio", { name: label }),
      ).toBeInTheDocument();
    }

    // Project select includes "All projects" plus every passed-in project.
    const projectSelect = screen.getByTestId(
      "tasks-project-select",
    ) as HTMLSelectElement;
    const projectValues = Array.from(projectSelect.options).map((o) => o.value);
    expect(projectValues).toEqual(["__all__", "p1", "p2", "p3"]);

    // Range select includes every option from the spec (24h/7d/30d/all).
    const rangeSelect = screen.getByTestId(
      "tasks-range-select",
    ) as HTMLSelectElement;
    const rangeValues = Array.from(rangeSelect.options).map((o) => o.value);
    expect(rangeValues).toEqual(["24h", "7d", "30d", "all"]);
  });

  // ─── Status segment ─────────────────────────────────────────────────────

  it("status segment drives ?status= and emits onStatusChange", () => {
    const onStatusChange = vi.fn();
    const probe = renderWithRouter(
      "/tasks",
      <TasksFilters
        projects={SAMPLE_PROJECTS}
        onStatusChange={onStatusChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Running" }));
    expect(probe.current.search).toContain("status=running");
    expect(onStatusChange).toHaveBeenLastCalledWith("running");

    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
    expect(probe.current.search).toContain("status=failed");
    expect(onStatusChange).toHaveBeenLastCalledWith("failed");
  });

  it("picking 'All' on the status segment removes ?status= entirely", () => {
    const probe = renderWithRouter(
      "/tasks?status=running",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );

    // Pre-populated state: the running segment is already selected.
    expect(
      screen.getByRole("radio", { name: "Running" }),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(probe.current.search).not.toContain("status=");
  });

  it("URL ?status=running pre-selects the Running segment", () => {
    renderWithRouter(
      "/tasks?status=running",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    expect(
      screen.getByRole("radio", { name: "Running" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "All" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  // ─── Project select ─────────────────────────────────────────────────────

  it("project select drives ?project_id= and emits onProjectChange", () => {
    const onProjectChange = vi.fn();
    const probe = renderWithRouter(
      "/tasks",
      <TasksFilters
        projects={SAMPLE_PROJECTS}
        onProjectChange={onProjectChange}
      />,
    );
    const select = screen.getByTestId(
      "tasks-project-select",
    ) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "p2" } });
    expect(probe.current.search).toContain("project_id=p2");
    expect(onProjectChange).toHaveBeenLastCalledWith("p2");

    fireEvent.change(select, { target: { value: "__all__" } });
    expect(probe.current.search).not.toContain("project_id=");
    expect(onProjectChange).toHaveBeenLastCalledWith(undefined);
  });

  it("URL ?project_id=p3 pre-selects the matching option", () => {
    renderWithRouter(
      "/tasks?project_id=p3",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    const select = screen.getByTestId(
      "tasks-project-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("p3");
  });

  // ─── Range select ───────────────────────────────────────────────────────

  it("range select drives ?range= for 24h / 7d / 30d", () => {
    const onRangeChange = vi.fn();
    const probe = renderWithRouter(
      "/tasks",
      <TasksFilters
        projects={SAMPLE_PROJECTS}
        onRangeChange={onRangeChange}
      />,
    );
    const select = screen.getByTestId(
      "tasks-range-select",
    ) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "24h" } });
    expect(probe.current.search).toContain("range=24h");
    expect(onRangeChange).toHaveBeenLastCalledWith("24h" as TasksRangeFilter);

    fireEvent.change(select, { target: { value: "7d" } });
    expect(probe.current.search).toContain("range=7d");

    fireEvent.change(select, { target: { value: "30d" } });
    expect(probe.current.search).toContain("range=30d");
  });

  it("picking 'All time' on range removes ?range= entirely", () => {
    const probe = renderWithRouter(
      "/tasks?range=7d",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    const select = screen.getByTestId(
      "tasks-range-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("7d");

    fireEvent.change(select, { target: { value: "all" } });
    expect(probe.current.search).not.toContain("range=");
  });

  // ─── Search input ───────────────────────────────────────────────────────

  it("search input debounces URL commits by 200 ms", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/tasks",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search tasks/i,
    }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "abc" } });

    // Mid-burst: input reflects typing, URL unchanged.
    expect(input.value).toBe("abc");
    expect(probe.current.search).toBe("");

    // Just under the debounce window — still no commit.
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(probe.current.search).toBe("");

    // Cross the threshold.
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(probe.current.search).toContain("q=abc");
  });

  it("search input commits to ?q= and emits onSearchChange (preserves other params)", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const probe = renderWithRouter(
      "/tasks?status=running",
      <TasksFilters
        projects={SAMPLE_PROJECTS}
        onSearchChange={onSearchChange}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search tasks/i,
    });

    fireEvent.change(input, { target: { value: "deploy" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(probe.current.pathname).toBe("/tasks");
    expect(probe.current.search).toContain("q=deploy");
    // Unrelated param survives the commit.
    expect(probe.current.search).toContain("status=running");
    expect(onSearchChange).toHaveBeenCalledWith("deploy");
  });

  it("clearing the search input wipes the ?q= param entirely", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/tasks?q=foo",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search tasks/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("foo");

    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(probe.current.search).not.toContain("q=");
  });

  it("URL ?q=foo pre-populates the search input", () => {
    renderWithRouter(
      "/tasks?q=foo",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search tasks/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("foo");
  });

  // ─── Read hooks ─────────────────────────────────────────────────────────

  it("useTasksStatusFilter returns the URL value, falling back to 'all'", () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/tasks?status=failed"]}>
        <StatusProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("status-probe")).toHaveTextContent("failed");
    unmount();

    render(
      <MemoryRouter initialEntries={["/tasks?status=garbage"]}>
        <StatusProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("status-probe")).toHaveTextContent("all");
  });

  it("useTasksProjectFilter returns the project id or undefined", () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/tasks?project_id=p7"]}>
        <ProjectProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("project-probe")).toHaveTextContent("p7");
    unmount();

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <ProjectProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("project-probe")).toHaveTextContent("__none__");
  });

  it("useTasksRangeFilter returns the URL value, falling back to 'all'", () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/tasks?range=7d"]}>
        <RangeProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("range-probe")).toHaveTextContent("7d");
    unmount();

    render(
      <MemoryRouter initialEntries={["/tasks?range=oops"]}>
        <RangeProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("range-probe")).toHaveTextContent("all");
  });

  // ─── filterTasksByQuery ─────────────────────────────────────────────────

  it("filterTasksByQuery matches id OR title, case-insensitively", () => {
    const rows = [
      { id: "task-abc-123", title: "Run deploy script" },
      { id: "task-def-456", title: "Refactor user auth" },
      { id: "task-ghi-789", title: "Update changelog" },
    ];

    expect(filterTasksByQuery(rows, "ABC").map((r) => r.id)).toEqual([
      "task-abc-123",
    ]);
    expect(filterTasksByQuery(rows, "deploy").map((r) => r.id)).toEqual([
      "task-abc-123",
    ]);
    expect(filterTasksByQuery(rows, "auth").map((r) => r.id)).toEqual([
      "task-def-456",
    ]);
    // Empty / whitespace-only returns all rows in original order.
    expect(filterTasksByQuery(rows, "").map((r) => r.id)).toEqual([
      "task-abc-123",
      "task-def-456",
      "task-ghi-789",
    ]);
    expect(filterTasksByQuery(rows, "   ").map((r) => r.id)).toEqual([
      "task-abc-123",
      "task-def-456",
      "task-ghi-789",
    ]);
  });

  it("filterTasksByQuery tolerates rows missing id or title", () => {
    const rows = [
      { id: "task-1", title: null },
      { id: null, title: "lonely-title" },
      { id: "task-3", title: "matched here" },
    ];
    expect(filterTasksByQuery(rows, "lonely").map((r) => r.id)).toEqual([
      null,
    ]);
    expect(filterTasksByQuery(rows, "matched").map((r) => r.id)).toEqual([
      "task-3",
    ]);
    // Substring on id.
    expect(filterTasksByQuery(rows, "task-1").map((r) => r.id)).toEqual([
      "task-1",
    ]);
  });

  // ─── End-to-end keyboard interaction ────────────────────────────────────

  it("activating segments via keyboard also drives ?status=", async () => {
    const probe = renderWithRouter(
      "/tasks",
      <TasksFilters projects={SAMPLE_PROJECTS} />,
    );

    const user = userEvent.setup();
    const allRadio = screen.getByRole("radio", {
      name: "All",
    }) as HTMLButtonElement;
    allRadio.focus();
    // Arrow right should advance focus; Enter activates.
    await user.keyboard("{ArrowRight}{Enter}");
    expect(probe.current.search).toContain("status=running");

    // The status filter literal should match a TasksStatusFilter union value.
    const statusFromUrl = new URLSearchParams(
      probe.current.search,
    ).get("status") as TasksStatusFilter | null;
    expect(statusFromUrl).toBe("running");
  });
});
