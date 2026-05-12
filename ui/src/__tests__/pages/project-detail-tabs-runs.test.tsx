import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import type { Task } from "@/lib/types";

/**
 * Contract tests for the redesigned project Runs tab.
 *
 * Pins down M23 / 00-project-detail / T05:
 *   - the tasks card is a `<FlatCard>` (rounded border + `divider-y`
 *     hairlines), not the legacy shadcn `<Card>`;
 *   - the column-header strip is a single row styled with
 *     `text-[11px] uppercase tracking-wider font-semibold text-zinc-500`;
 *   - the status filter is a `<SegmentToggle>` exposing
 *     `All / Running / Completed / Failed`;
 *   - status cells render via the design `<StatusPill>` primitive
 *     (NOT the legacy shadcn-Badge `statusBadge` helper);
 *   - clicking a row navigates to `/tasks/:id` — the existing inline
 *     "Open" link is preserved for keyboard / middle-click flows;
 *   - pagination + filter side-effects still drive `useTasks` with the
 *     same arg shape they did before the restyle (offset advances by
 *     `limit`, status filter resets the page back to 0, agent filter
 *     resets the page back to 0).
 *
 * The Vitest hook factories below let each test stub a fresh `useTasks`
 * payload + spy on call args, without spinning up a real react-query
 * client. The stat cards / charts / usage hooks are mocked with empty
 * data shapes — they're outside this slice's scope.
 */

// --- hook fixtures ----------------------------------------------------------

interface UseTasksCall {
  offset: number;
  limit: number;
  filters: Record<string, unknown> | undefined;
}

const useTasksCalls: UseTasksCall[] = [];
let useTasksResult: {
  data?: { items: Task[]; total: number; offset?: number; limit?: number };
  isLoading: boolean;
} = { data: { items: [], total: 0 }, isLoading: false };

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    status: "done",
    prompt: "do the thing",
    prompt_file: null,
    agent: "claude",
    model: "sonnet",
    actual_model_used: null,
    timeout_seconds: 1800,
    project_id: "proj-1",
    assigned_key_id: null,
    assigned_key_label: null,
    exit_code: 0,
    started_at: "2026-05-01T10:00:00.000Z",
    completed_at: "2026-05-01T10:05:00.000Z",
    working_dir: null,
    created_at: "2026-05-01T09:59:00.000Z",
    updated_at: "2026-05-01T10:05:00.000Z",
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: null,
    parent_task_id: null,
    liveMetrics: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_cost_usd: 0.42,
      turns: 3,
      duration_ms: 60_000,
    },
    ...overrides,
  };
}

vi.mock("@/lib/hooks", () => ({
  useUsageSummary: () => ({ data: undefined, isLoading: false }),
  useUsageBreakdown: () => ({ data: { items: [] }, isLoading: false }),
  useProjectStats: () => ({ data: undefined, isLoading: false }),
  useTasks: (
    offset: number,
    limit: number,
    filters: Record<string, unknown> | undefined,
  ) => {
    useTasksCalls.push({ offset, limit, filters });
    return useTasksResult;
  },
}));

// Recharts pulls in ResizeObserver + canvas APIs that jsdom lacks. Stub
// the sub-tree so the chart cards render harmlessly during tests — none
// of these tests assert on chart contents.
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    BarChart: Stub,
    Bar: Stub,
    LineChart: Stub,
    Line: Stub,
    XAxis: Stub,
    YAxis: Stub,
    Tooltip: Stub,
    ResponsiveContainer: Stub,
    CartesianGrid: Stub,
  };
});

// Imported AFTER the mock so the component picks up the stubbed hooks.
import { RunsTab } from "@/pages/project-detail-components/RunsTab";

// --- helpers ----------------------------------------------------------------

function LocationSpy() {
  const loc = useLocation();
  return (
    <div data-testid="navigated-to">{`${loc.pathname}${loc.search}`}</div>
  );
}

function renderTab(ui: React.ReactNode = <RunsTab projectId="proj-1" />) {
  return render(
    <MemoryRouter initialEntries={["/projects/proj-1?tab=runs"]}>
      <Routes>
        <Route path="/projects/:projectId" element={ui} />
        <Route path="/tasks/:taskId" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useTasksCalls.length = 0;
  useTasksResult = { data: { items: [], total: 0 }, isLoading: false };
  cleanup();
});

// --- tests ------------------------------------------------------------------

describe("RunsTab — flat-card surface", () => {
  it("wraps the tasks panel in a FlatCard (rounded + border + divider-y)", () => {
    renderTab();
    const filterRow = screen.getByTestId("project-runs-filter-row");
    // The FlatCard is the closest element above the filter row that
    // composes `rounded-xl + border + divider-y`. Walk up looking for
    // it so the assertion stays robust against extra wrappers.
    let node: HTMLElement | null = filterRow.parentElement;
    while (node && !(
      node.className.includes("rounded-xl") &&
      node.className.includes("border") &&
      node.className.includes("divider-y")
    )) {
      node = node.parentElement;
    }
    expect(node).not.toBeNull();
  });

  it("renders the column-header strip with uppercase tracking-wider zinc-500 font-semibold", () => {
    renderTab();
    const header = screen.getByTestId("project-runs-header-row");
    for (const cls of [
      "text-[11px]",
      "uppercase",
      "tracking-wider",
      "text-zinc-500",
      "font-semibold",
    ]) {
      expect(header.className).toContain(cls);
    }
    // Column labels left → right.
    const cells = Array.from(header.children).map(
      (c) => c.textContent?.trim() ?? "",
    );
    expect(cells.slice(0, 5)).toEqual([
      "Prompt / Agent",
      "Status",
      "Cost",
      "Duration",
      "Started",
    ]);
  });
});

describe("RunsTab — status filter SegmentToggle", () => {
  it("renders exactly 4 buckets in the prescribed order", () => {
    renderTab();
    const toggle = screen.getByTestId("project-runs-status-filter");
    const labels = Array.from(toggle.querySelectorAll("[role='radio']")).map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toEqual(["All", "Running", "Completed", "Failed"]);
  });

  it("starts on 'All' (no `status` filter passed to useTasks)", () => {
    renderTab();
    expect(useTasksCalls.length).toBeGreaterThan(0);
    const last = useTasksCalls[useTasksCalls.length - 1]!;
    expect(last.filters).toMatchObject({ project_id: "proj-1" });
    expect(last.filters).not.toHaveProperty("status");
  });

  it("clicking 'Running' passes status=running to useTasks", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("radio", { name: "Running" }));
    const last = useTasksCalls[useTasksCalls.length - 1]!;
    expect(last.filters).toMatchObject({
      project_id: "proj-1",
      status: "running",
    });
  });

  it("clicking 'Completed' passes status=done (not the literal label)", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("radio", { name: "Completed" }));
    const last = useTasksCalls[useTasksCalls.length - 1]!;
    expect(last.filters).toMatchObject({ status: "done" });
  });

  it("clicking 'Failed' passes status=failed", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("radio", { name: "Failed" }));
    const last = useTasksCalls[useTasksCalls.length - 1]!;
    expect(last.filters).toMatchObject({ status: "failed" });
  });
});

describe("RunsTab — row rendering", () => {
  it("renders a status pill per row using the design StatusPill (uppercase tracking-wider)", () => {
    useTasksResult = {
      data: {
        items: [
          makeTask({ id: "t-running", status: "running" }),
          makeTask({ id: "t-failed", status: "failed" }),
          makeTask({ id: "t-done", status: "done" }),
        ],
        total: 3,
      },
      isLoading: false,
    };
    renderTab();

    const rows = screen.getByTestId("project-runs-rows");
    // Each row exposes a StatusPill — the design primitive sets
    // `data-tone` + `uppercase tracking-wider` so we assert against
    // those rather than legacy `<Badge>` markup.
    const pills = rows.querySelectorAll("[data-tone]");
    expect(pills).toHaveLength(3);
    const tones = Array.from(pills).map((p) =>
      p.getAttribute("data-tone"),
    );
    // Canonical `statusPillTone` from `@/lib/task-status`:
    // running → success, failed → danger, done → success.
    expect(tones).toEqual(["success", "danger", "success"]);
    for (const pill of pills) {
      expect(pill.className).toContain("uppercase");
      expect(pill.className).toContain("tracking-wider");
    }
  });

  it("each row carries the `border-b divider-y` hairline classes", () => {
    useTasksResult = {
      data: {
        items: [makeTask({ id: "t-1" }), makeTask({ id: "t-2" })],
        total: 2,
      },
      isLoading: false,
    };
    renderTab();
    const row = screen.getByTestId("project-runs-task-row-t-1");
    expect(row.className).toContain("border-b");
    expect(row.className).toContain("divider-y");
  });

  it("does NOT render the legacy shadcn Badge in status cells", () => {
    useTasksResult = {
      data: {
        items: [makeTask({ id: "t-1", status: "running" })],
        total: 1,
      },
      isLoading: false,
    };
    renderTab();
    // Legacy badge had `data-slot="badge"` on the shadcn primitive.
    expect(document.querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("RunsTab — row click → /tasks/:id", () => {
  it("clicking a row navigates to the task detail route", async () => {
    useTasksResult = {
      data: { items: [makeTask({ id: "task-abc" })], total: 1 },
      isLoading: false,
    };
    renderTab();
    const row = screen.getByTestId("project-runs-task-row-task-abc");
    fireEvent.click(row);
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/tasks/task-abc",
    );
  });

  it("Enter / Space on a focused row also navigates", async () => {
    useTasksResult = {
      data: { items: [makeTask({ id: "task-xyz" })], total: 1 },
      isLoading: false,
    };
    renderTab();
    const row = screen.getByTestId("project-runs-task-row-task-xyz");
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/tasks/task-xyz",
    );
  });

  it("preserves the inline 'Open' link as a secondary affordance", () => {
    useTasksResult = {
      data: { items: [makeTask({ id: "task-1" })], total: 1 },
      isLoading: false,
    };
    renderTab();
    const row = screen.getByTestId("project-runs-task-row-task-1");
    const link = within(row).getByRole("link", { name: /Open/ });
    expect(link).toHaveAttribute("href", "/tasks/task-1");
  });

  it("clicking the inline 'Open' link still ends up at the same task detail route", () => {
    useTasksResult = {
      data: { items: [makeTask({ id: "task-1" })], total: 1 },
      isLoading: false,
    };
    renderTab();
    const row = screen.getByTestId("project-runs-task-row-task-1");
    const link = within(row).getByRole("link", { name: /Open/ });
    fireEvent.click(link);
    // Whether the click hits the link directly or bubbles up to the row
    // handler, the resulting route must be the same — the row + the
    // inline link are two affordances onto the same destination.
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/tasks/task-1",
    );
  });
});

describe("RunsTab — pagination wiring", () => {
  it("Next advances offset by `limit` (25) and Previous walks it back", async () => {
    useTasksResult = {
      data: {
        items: Array.from({ length: 25 }, (_, i) =>
          makeTask({ id: `t-${i}` }),
        ),
        total: 100,
      },
      isLoading: false,
    };
    const user = userEvent.setup();
    renderTab();

    // Initial render passes offset=0.
    expect(useTasksCalls[0]!.offset).toBe(0);
    expect(useTasksCalls[0]!.limit).toBe(25);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(useTasksCalls[useTasksCalls.length - 1]!.offset).toBe(25);

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(useTasksCalls[useTasksCalls.length - 1]!.offset).toBe(0);
  });

  it("disables Previous on page 0 and Next on the last page", () => {
    useTasksResult = {
      data: {
        items: Array.from({ length: 5 }, (_, i) => makeTask({ id: `t-${i}` })),
        total: 5,
      },
      isLoading: false,
    };
    renderTab();
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("changing the status filter resets the page back to 0", async () => {
    useTasksResult = {
      data: {
        items: Array.from({ length: 25 }, (_, i) =>
          makeTask({ id: `t-${i}` }),
        ),
        total: 100,
      },
      isLoading: false,
    };
    const user = userEvent.setup();
    renderTab();

    // Advance to page 1 then change the filter — the next call's offset
    // must drop back to 0.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(useTasksCalls[useTasksCalls.length - 1]!.offset).toBe(25);

    await user.click(screen.getByRole("radio", { name: "Failed" }));
    expect(useTasksCalls[useTasksCalls.length - 1]!.offset).toBe(0);
    expect(useTasksCalls[useTasksCalls.length - 1]!.filters).toMatchObject({
      status: "failed",
    });
  });

  it("changing the agent filter resets the page back to 0", async () => {
    useTasksResult = {
      data: {
        items: Array.from({ length: 25 }, (_, i) =>
          makeTask({ id: `t-${i}` }),
        ),
        total: 100,
      },
      isLoading: false,
    };
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(useTasksCalls[useTasksCalls.length - 1]!.offset).toBe(25);

    const agentInput = screen.getByLabelText("Filter by agent");
    await user.type(agentInput, "claude");
    const last = useTasksCalls[useTasksCalls.length - 1]!;
    expect(last.offset).toBe(0);
    expect(last.filters).toMatchObject({ agent: "claude" });
  });
});

describe("RunsTab — empty + loading states", () => {
  it("renders the no-tasks copy when the page is empty", () => {
    useTasksResult = { data: { items: [], total: 0 }, isLoading: false };
    renderTab();
    expect(
      screen.getByText("No tasks match the current filters."),
    ).toBeInTheDocument();
    // Pagination footer must not render when there are no items.
    expect(screen.queryByTestId("project-runs-pagination")).toBeNull();
  });

  it("renders skeleton rows while the first page is loading", () => {
    useTasksResult = { data: { items: [], total: 0 }, isLoading: true };
    renderTab();
    // Three pulsing skeleton placeholders inside the FlatCard.
    expect(
      document.querySelectorAll(".animate-pulse").length,
    ).toBeGreaterThanOrEqual(3);
  });
});
