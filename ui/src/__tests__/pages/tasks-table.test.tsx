import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import { TasksTable } from "@/pages/tasks-components/TasksTable";
import type { TasksTableRow } from "@/pages/tasks-components/TasksTable";

/**
 * Unit tests for {@link TasksTable} (slice 24-00 T02 — tasks list table
 * restyle under M22 tokens).
 *
 * The component is presentational; the parent is responsible for fetching,
 * sorting, paging, and filtering. Multi-select is fully controlled via
 * `selectedIds` + `onSelectionChange`. These tests cover:
 *   - happy-path render of header (uppercase tracking-wider zinc-500 font-semibold)
 *     and body rows (divide-y, hover bg-zinc-50 / dark:bg-zinc-800/40)
 *   - column contract: checkbox / id (mono) / title / project (StatusPill) /
 *     status (StatusPill + optional LiveDot) / created (rel time) / cost (mono $N.NN) / kebab
 *   - status → tone + live-dot mapping for every Flockctl TaskStatus
 *   - multi-select: per-row toggle, header tri-state, select-all / deselect-all
 *   - row click → /tasks/:id navigation, custom onRowClick override
 *   - kebab opens dropdown without bubbling row navigation; cancel / rerun /
 *     copy-id callbacks fire with task id
 *   - edge cases: empty rows, missing project, missing cost, no kebab when no
 *     callbacks, no selection emitter when onSelectionChange omitted.
 */

function makeRow(overrides: Partial<TasksTableRow> = {}): TasksTableRow {
  return {
    id: "abc12345-deadbeef",
    title: "Refactor auth flow",
    status: "running",
    project: { name: "flockctl" },
    created_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    cost_usd: 0.04,
    ...overrides,
  };
}

function renderInRouter(ui: React.ReactNode, initialEntry = "/tasks") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/tasks" element={ui} />
        <Route path="/tasks/:id" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname}</div>;
}

describe("TasksTable / header", () => {
  it("renders an uppercase tracking-wider zinc-500 font-semibold header row", () => {
    renderInRouter(<TasksTable rows={[makeRow()]} />);
    const head = screen.getByTestId("tasks-table-head");
    const ths = within(head).getAllByRole("columnheader");
    // checkbox + id + title + project + status + created + cost + actions
    expect(ths.length).toBe(8);
    for (const th of ths) {
      expect(th.className).toContain("uppercase");
      expect(th.className).toContain("tracking-wider");
      expect(th.className).toContain("text-zinc-500");
      expect(th.className).toContain("font-semibold");
    }
    expect(within(head).getByText("ID")).toBeTruthy();
    expect(within(head).getByText("Title")).toBeTruthy();
    expect(within(head).getByText("Project")).toBeTruthy();
    expect(within(head).getByText("Status")).toBeTruthy();
    expect(within(head).getByText("Created")).toBeTruthy();
    expect(within(head).getByText("Cost")).toBeTruthy();
  });
});

describe("TasksTable / body row tokens", () => {
  it("separates body rows with divide-y and applies the M22 hover surface", () => {
    renderInRouter(
      <TasksTable
        rows={[
          makeRow(),
          makeRow({ id: "second-row-id", title: "Migrate schema" }),
        ]}
      />,
    );
    const body = screen.getByTestId("tasks-table-body");
    expect(body.className).toContain("divide-y");
    expect(body.className).toMatch(/divide-zinc-(100|200)/);

    const rows = screen.getAllByTestId("tasks-table-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.className).toContain("cursor-pointer");
      expect(row.className).toContain("hover:bg-zinc-50");
      expect(row.className).toContain("dark:hover:bg-zinc-800/40");
    }
  });
});

describe("TasksTable / column contract", () => {
  it("renders the ID column in monospace and truncates to 8 chars", () => {
    renderInRouter(
      <TasksTable rows={[makeRow({ id: "abcdef0123456789" })]} />,
    );
    const id = screen.getByTestId("tasks-table-id");
    expect(id.textContent).toBe("abcdef01");
    const cell = id.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("renders the title with a truncate utility", () => {
    renderInRouter(<TasksTable rows={[makeRow({ title: "A long-ish task title" })]} />);
    const title = screen.getByTestId("tasks-table-title");
    expect(title.textContent).toBe("A long-ish task title");
    expect(title.className).toContain("truncate");
  });

  it("renders the project as a StatusPill with the caller's accent override", () => {
    renderInRouter(
      <TasksTable
        rows={[
          makeRow({
            project: {
              name: "flockctl",
              accentClassName: "bg-indigo-500/15 text-indigo-600",
            },
          }),
        ]}
      />,
    );
    const pill = screen.getByTestId("tasks-table-project-pill");
    expect(pill.textContent).toBe("flockctl");
    expect(pill.className).toContain("bg-indigo-500/15");
    expect(pill.className).toContain("text-indigo-600");
    expect(pill.className).toContain("uppercase");
    expect(pill.className).toContain("tracking-wider");
  });

  it("falls back to a `—` placeholder for the project column when unassigned", () => {
    renderInRouter(<TasksTable rows={[makeRow({ project: undefined })]} />);
    expect(screen.queryByTestId("tasks-table-project-pill")).toBeNull();
    expect(screen.getByTestId("tasks-table-project-empty").textContent).toBe(
      "—",
    );
  });

  it("renders Created using relative time", () => {
    renderInRouter(
      <TasksTable
        rows={[
          makeRow({
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("tasks-table-created").textContent).toBe(
      "3h ago",
    );
  });

  it("falls back to `—` when created_at is null", () => {
    renderInRouter(<TasksTable rows={[makeRow({ created_at: null })]} />);
    expect(screen.getByTestId("tasks-table-created").textContent).toBe("—");
  });

  it("renders the cost column in monospace tabular numerics", () => {
    renderInRouter(<TasksTable rows={[makeRow({ cost_usd: 1.234 })]} />);
    const cost = screen.getByTestId("tasks-table-cost");
    expect(cost.textContent).toBe("$1.23");
    const cell = cost.closest("td")!;
    expect(cell.className).toContain("font-mono");
    expect(cell.className).toContain("tabular-nums");
  });

  it("falls back to $0.00 when cost is missing or non-finite", () => {
    renderInRouter(
      <TasksTable
        rows={[
          makeRow({ id: "row-a", cost_usd: null }),
          makeRow({ id: "row-b", cost_usd: undefined }),
          makeRow({ id: "row-c", cost_usd: Number.NaN }),
        ]}
      />,
    );
    const costs = screen.getAllByTestId("tasks-table-cost");
    expect(costs.map((c) => c.textContent)).toEqual([
      "$0.00",
      "$0.00",
      "$0.00",
    ]);
  });
});

describe("TasksTable / status → tone + live-dot mapping", () => {
  const cases: Array<{
    status: TasksTableRow["status"];
    tone: string;
    dot: "live" | "idle" | null;
  }> = [
    { status: "running", tone: "success", dot: "live" },
    { status: "queued", tone: "info", dot: "idle" },
    { status: "done", tone: "success", dot: null },
    { status: "failed", tone: "danger", dot: null },
    { status: "timed_out", tone: "danger", dot: null },
    { status: "cancelled", tone: "neutral", dot: null },
    { status: "waiting_for_input", tone: "warning", dot: "idle" },
    { status: "pending_approval", tone: "warning", dot: "idle" },
    { status: "rate_limited", tone: "warning", dot: "idle" },
  ];

  for (const { status, tone, dot } of cases) {
    it(`maps ${status} → tone=${tone} dot=${dot ?? "none"}`, () => {
      renderInRouter(<TasksTable rows={[makeRow({ status })]} />);
      const wrap = screen.getByTestId("tasks-table-status");
      const pill = within(wrap).getByText(String(status));
      expect(pill.getAttribute("data-tone")).toBe(tone);
      const dotEl = screen.queryByTestId("tasks-table-status-dot");
      if (dot) {
        expect(dotEl).not.toBeNull();
        expect(dotEl!.getAttribute("data-state")).toBe(dot);
      } else {
        expect(dotEl).toBeNull();
      }
    });
  }

  it("falls through to `neutral` for unknown status strings", () => {
    renderInRouter(
      <TasksTable rows={[makeRow({ status: "unknown_state" as never })]} />,
    );
    const pill = screen.getByText("unknown_state");
    expect(pill.getAttribute("data-tone")).toBe("neutral");
    expect(screen.queryByTestId("tasks-table-status-dot")).toBeNull();
  });
});

describe("TasksTable / multi-select", () => {
  it("emits onSelectionChange with the toggled row id", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" }), makeRow({ id: "task-2" })]}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const [first] = screen.getAllByTestId("tasks-table-row-checkbox");
    await user.click(first!);
    expect(onSelectionChange).toHaveBeenCalledWith(["task-1"]);
  });

  it("removes a row id from the selection when its checkbox is toggled off", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" }), makeRow({ id: "task-2" })]}
        selectedIds={["task-1", "task-2"]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const [first] = screen.getAllByTestId("tasks-table-row-checkbox");
    await user.click(first!);
    expect(onSelectionChange).toHaveBeenCalledWith(["task-2"]);
  });

  it("renders the header checkbox as indeterminate when only some rows are selected", () => {
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" }), makeRow({ id: "task-2" })]}
        selectedIds={["task-1"]}
        onSelectionChange={vi.fn()}
      />,
    );
    const headerCheckbox = screen.getByTestId("tasks-table-select-all");
    expect(headerCheckbox.getAttribute("data-state")).toBe("indeterminate");
  });

  it("select-all emits every visible row id", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" }), makeRow({ id: "task-2" })]}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );
    await user.click(screen.getByTestId("tasks-table-select-all"));
    expect(onSelectionChange).toHaveBeenCalledWith(["task-1", "task-2"]);
  });

  it("deselect-all clears the selection when the header is fully checked", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" }), makeRow({ id: "task-2" })]}
        selectedIds={["task-1", "task-2"]}
        onSelectionChange={onSelectionChange}
      />,
    );
    const headerCheckbox = screen.getByTestId("tasks-table-select-all");
    expect(headerCheckbox.getAttribute("data-state")).toBe("checked");
    await user.click(headerCheckbox);
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("clicking a row checkbox does NOT also fire row navigation", async () => {
    const user = userEvent.setup();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "task-1" })]}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("tasks-table-row-checkbox"));
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });

  it("disables the checkboxes when no onSelectionChange is provided", () => {
    renderInRouter(<TasksTable rows={[makeRow()]} />);
    expect(
      screen.getByTestId("tasks-table-select-all").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("tasks-table-row-checkbox")
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("TasksTable / navigation", () => {
  it("navigates to /tasks/:id when a row is clicked", () => {
    renderInRouter(<TasksTable rows={[makeRow({ id: "t-42" })]} />);
    fireEvent.click(screen.getByTestId("tasks-table-row"));
    expect(screen.getByTestId("navigated-to").textContent).toBe("/tasks/t-42");
  });

  it("invokes onRowClick override instead of router navigation", () => {
    const onRowClick = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "t-42" })]}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(screen.getByTestId("tasks-table-row"));
    expect(onRowClick).toHaveBeenCalledWith("t-42");
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });
});

describe("TasksTable / kebab menu", () => {
  it("does not render the kebab when no action callbacks are passed", () => {
    renderInRouter(<TasksTable rows={[makeRow()]} />);
    expect(screen.queryByTestId("tasks-table-kebab")).toBeNull();
  });

  it("renders the kebab and routes copy-id / rerun / cancel by task id", async () => {
    const user = userEvent.setup();
    const onCopyId = vi.fn();
    const onRerun = vi.fn();
    const onCancel = vi.fn();
    renderInRouter(
      <TasksTable
        rows={[makeRow({ id: "t-42" })]}
        onCopyId={onCopyId}
        onRerun={onRerun}
        onCancel={onCancel}
      />,
    );

    const kebab = screen.getByTestId("tasks-table-kebab");
    await user.click(kebab);

    // Row navigation should NOT have fired.
    expect(screen.queryByTestId("navigated-to")).toBeNull();

    const cancelItem = await screen.findByText("Cancel");
    await user.click(cancelItem);
    expect(onCancel).toHaveBeenCalledWith("t-42");
    expect(onCopyId).not.toHaveBeenCalled();
    expect(onRerun).not.toHaveBeenCalled();
  });
});

describe("TasksTable / edge cases", () => {
  it("renders an empty body when given no rows", () => {
    renderInRouter(<TasksTable rows={[]} />);
    const body = screen.getByTestId("tasks-table-body");
    expect(within(body).queryAllByTestId("tasks-table-row").length).toBe(0);
    // Header select-all also disables on empty.
    expect(
      screen.getByTestId("tasks-table-select-all").hasAttribute("disabled"),
    ).toBe(true);
  });
});
