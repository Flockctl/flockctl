import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

import {
  ByProjectTable,
  type ByProjectTableRow,
} from "@/pages/analytics-components/ByProjectTable";

/**
 * Unit tests for {@link ByProjectTable} (M25 analytics slice — T03).
 *
 * The table is presentational with internal sort state. We cover:
 *
 *   - column contract: Project / Tasks completed / Total cost / Tokens /
 *     Last activity, in left → right order.
 *   - body row contract: name + numeric cells + relative-time activity.
 *   - sort cycle: clicking a column header toggles asc → desc → off.
 *   - switching between columns resets the previous to off and starts
 *     the new column at asc.
 *   - sort direction actually re-orders the body rows.
 *   - aria-sort reflects the active state.
 *   - numeric formatting: USD 2-decimal cost, compact tokens.
 *   - row click handler.
 */

function makeRow(overrides: Partial<ByProjectTableRow> = {}): ByProjectTableRow {
  return {
    id: "p-flockctl",
    name: "Flockctl",
    tasksCompleted: 17,
    totalCostUsd: 12.34,
    tokens: 42_000,
    lastActivity: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    ...overrides,
  };
}

const ROWS: ReadonlyArray<ByProjectTableRow> = [
  makeRow({
    id: "p-a",
    name: "alpha",
    tasksCompleted: 5,
    totalCostUsd: 10.0,
    tokens: 100,
    lastActivity: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  }),
  makeRow({
    id: "p-b",
    name: "bravo",
    tasksCompleted: 20,
    totalCostUsd: 1.5,
    tokens: 50_000,
    lastActivity: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }),
  makeRow({
    id: "p-c",
    name: "charlie",
    tasksCompleted: 12,
    totalCostUsd: 100.0,
    tokens: 1_000_000,
    lastActivity: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  }),
];

describe("ByProjectTable / column headers", () => {
  it("renders the five expected column headers in order", () => {
    render(<ByProjectTable rows={ROWS} />);
    const headers = screen
      .getAllByRole("columnheader")
      .map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      "Project",
      "Tasks completed",
      "Total cost",
      "Tokens",
      "Last activity",
    ]);
  });

  it("each header is a button (sortable)", () => {
    render(<ByProjectTable rows={ROWS} />);
    expect(
      screen.getByTestId("by-project-table-header-button-project"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("by-project-table-header-button-tasksCompleted"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("by-project-table-header-button-totalCostUsd"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("by-project-table-header-button-tokens"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("by-project-table-header-button-lastActivity"),
    ).toBeInTheDocument();
  });

  it("starts with all columns unsorted (aria-sort='none')", () => {
    render(<ByProjectTable rows={ROWS} />);
    const headers = screen.getAllByRole("columnheader");
    for (const th of headers) {
      expect(th).toHaveAttribute("aria-sort", "none");
    }
  });
});

describe("ByProjectTable / body rows", () => {
  it("renders one row per input row", () => {
    render(<ByProjectTable rows={ROWS} />);
    expect(screen.getAllByTestId("by-project-table-row")).toHaveLength(3);
  });

  it("preserves input order when no column is sorted", () => {
    render(<ByProjectTable rows={ROWS} />);
    const names = screen
      .getAllByTestId("by-project-table-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("formats total cost as USD with 2 decimals", () => {
    render(<ByProjectTable rows={[makeRow({ totalCostUsd: 12.34 })]} />);
    expect(
      screen.getByTestId("by-project-table-total-cost"),
    ).toHaveTextContent("$12.34");
  });

  it("formats tokens with compact notation (42K)", () => {
    render(<ByProjectTable rows={[makeRow({ tokens: 42_000 })]} />);
    expect(
      screen.getByTestId("by-project-table-tokens"),
    ).toHaveTextContent(/42K/);
  });

  it("renders raw tasksCompleted count", () => {
    render(<ByProjectTable rows={[makeRow({ tasksCompleted: 17 })]} />);
    expect(
      screen.getByTestId("by-project-table-tasks-completed"),
    ).toHaveTextContent("17");
  });

  it("renders em-dash for null lastActivity", () => {
    render(<ByProjectTable rows={[makeRow({ lastActivity: null })]} />);
    expect(
      screen.getByTestId("by-project-table-last-activity"),
    ).toHaveTextContent("—");
  });
});

describe("ByProjectTable / sort cycle", () => {
  it("first click on a column sorts ascending", () => {
    render(<ByProjectTable rows={ROWS} />);
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-project"),
    );
    const names = screen
      .getAllByTestId("by-project-table-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
    expect(
      screen.getByTestId("by-project-table-header-project"),
    ).toHaveAttribute("aria-sort", "ascending");
    expect(
      screen.getByTestId("by-project-table-sort-icon-project"),
    ).toHaveAttribute("data-sort-icon", "asc");
  });

  it("second click on the same column sorts descending", () => {
    render(<ByProjectTable rows={ROWS} />);
    const button = screen.getByTestId(
      "by-project-table-header-button-project",
    );
    fireEvent.click(button);
    fireEvent.click(button);
    const names = screen
      .getAllByTestId("by-project-table-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["charlie", "bravo", "alpha"]);
    expect(
      screen.getByTestId("by-project-table-header-project"),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      screen.getByTestId("by-project-table-sort-icon-project"),
    ).toHaveAttribute("data-sort-icon", "desc");
  });

  it("third click on the same column resets to off (input order, no sort icon)", () => {
    render(<ByProjectTable rows={ROWS} />);
    const button = screen.getByTestId(
      "by-project-table-header-button-project",
    );
    fireEvent.click(button); // asc
    fireEvent.click(button); // desc
    fireEvent.click(button); // off
    const names = screen
      .getAllByTestId("by-project-table-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["alpha", "bravo", "charlie"]); // back to input order
    expect(
      screen.getByTestId("by-project-table-header-project"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      screen.queryByTestId("by-project-table-sort-icon-project"),
    ).not.toBeInTheDocument();
  });

  it("clicking a different column resets the previous and starts at asc", () => {
    render(<ByProjectTable rows={ROWS} />);
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-project"),
    ); // project asc
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-project"),
    ); // project desc
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-tasksCompleted"),
    ); // tasksCompleted asc

    expect(
      screen.getByTestId("by-project-table-header-project"),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      screen.queryByTestId("by-project-table-sort-icon-project"),
    ).not.toBeInTheDocument();

    expect(
      screen.getByTestId("by-project-table-header-tasksCompleted"),
    ).toHaveAttribute("aria-sort", "ascending");

    // tasksCompleted asc: 5 (alpha), 12 (charlie), 20 (bravo)
    const names = screen
      .getAllByTestId("by-project-table-name")
      .map((el) => el.textContent);
    expect(names).toEqual(["alpha", "charlie", "bravo"]);
  });
});

describe("ByProjectTable / numeric column sorting", () => {
  it("sorts by total cost ascending", () => {
    render(<ByProjectTable rows={ROWS} />);
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-totalCostUsd"),
    );
    const costs = screen
      .getAllByTestId("by-project-table-total-cost")
      .map((el) => el.textContent);
    expect(costs).toEqual(["$1.50", "$10.00", "$100.00"]);
  });

  it("sorts by total cost descending on second click", () => {
    render(<ByProjectTable rows={ROWS} />);
    const btn = screen.getByTestId(
      "by-project-table-header-button-totalCostUsd",
    );
    fireEvent.click(btn);
    fireEvent.click(btn);
    const costs = screen
      .getAllByTestId("by-project-table-total-cost")
      .map((el) => el.textContent);
    expect(costs).toEqual(["$100.00", "$10.00", "$1.50"]);
  });

  it("sorts by tokens ascending (numeric, not lexicographic)", () => {
    render(<ByProjectTable rows={ROWS} />);
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-tokens"),
    );
    const ids = screen
      .getAllByTestId("by-project-table-row")
      .map((el) => el.getAttribute("data-project-id"));
    // tokens: alpha=100, bravo=50_000, charlie=1_000_000
    expect(ids).toEqual(["p-a", "p-b", "p-c"]);
  });

  it("sorts by lastActivity ascending (oldest first)", () => {
    render(<ByProjectTable rows={ROWS} />);
    fireEvent.click(
      screen.getByTestId("by-project-table-header-button-lastActivity"),
    );
    const ids = screen
      .getAllByTestId("by-project-table-row")
      .map((el) => el.getAttribute("data-project-id"));
    // ages: alpha=3h, bravo=30m, charlie=24h → asc (oldest first): charlie, alpha, bravo
    expect(ids).toEqual(["p-c", "p-a", "p-b"]);
  });
});

describe("ByProjectTable / row click", () => {
  it("invokes onRowClick with the project id when a row is clicked", () => {
    const onRowClick = vi.fn();
    render(<ByProjectTable rows={ROWS} onRowClick={onRowClick} />);
    const rows = screen.getAllByTestId("by-project-table-row");
    fireEvent.click(rows[1]!);
    expect(onRowClick).toHaveBeenCalledWith("p-b");
  });

  it("does not bind an onClick when onRowClick is not provided", () => {
    render(<ByProjectTable rows={ROWS} />);
    const row = screen.getAllByTestId("by-project-table-row")[0]!;
    expect(row.className).not.toContain("cursor-pointer");
  });
});

describe("ByProjectTable / edge cases", () => {
  it("renders an empty body when rows is empty", () => {
    render(<ByProjectTable rows={[]} />);
    const body = screen.getByTestId("by-project-table-body");
    expect(within(body).queryAllByTestId("by-project-table-row")).toHaveLength(
      0,
    );
  });

  it("handles a single row (sort cycle still works)", () => {
    render(<ByProjectTable rows={[makeRow({ id: "p-only", name: "only" })]} />);
    const button = screen.getByTestId(
      "by-project-table-header-button-project",
    );
    fireEvent.click(button); // asc
    fireEvent.click(button); // desc
    fireEvent.click(button); // off
    expect(screen.getAllByTestId("by-project-table-row")).toHaveLength(1);
  });
});
