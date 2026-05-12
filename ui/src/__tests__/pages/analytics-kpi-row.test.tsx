import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AnalyticsKpiRow } from "@/pages/analytics-components/AnalyticsKpiRow";

/**
 * Unit tests for {@link AnalyticsKpiRow} (M25 analytics slice — T01).
 *
 * The strip is presentational: 4 tiles with deterministic labels +
 * numeric formatting. We cover:
 *
 *   - exactly 4 KpiTile-shaped instances render in `lg:grid-cols-4`,
 *   - each tile carries its expected label in order,
 *   - Spend formats USD with 2-decimal mono styling,
 *   - Tokens uses KpiTile's compact formatter (mono),
 *   - Tasks completed renders the raw count (NOT mono — it's a plain
 *     index, not a financial figure),
 *   - Avg cost/task uses 4-decimal precision for sub-cent values,
 *   - undefined values render an em-dash.
 */

function baseProps() {
  return {
    spendUsd: 12.34,
    tokensTotal: 42_000,
    tasksCompleted: 17,
    avgCostPerTask: 0.0421,
  } as const;
}

describe("AnalyticsKpiRow / layout", () => {
  it("renders exactly 4 KpiTile-shaped tiles", () => {
    render(<AnalyticsKpiRow {...baseProps()} />);
    const tiles = screen.getAllByTestId("kpi-tile");
    expect(tiles).toHaveLength(4);
  });

  it("uses a 4-column grid at lg+", () => {
    render(<AnalyticsKpiRow {...baseProps()} />);
    const grid = screen.getByTestId("analytics-kpi-row");
    expect(grid.className).toContain("lg:grid-cols-4");
    expect(grid.className).toContain("grid");
  });

  it("renders the four expected labels in order", () => {
    render(<AnalyticsKpiRow {...baseProps()} />);
    const labels = screen
      .getAllByTestId("kpi-label")
      .map((n) => n.textContent);
    expect(labels).toEqual([
      "Spend",
      "Tokens",
      "Tasks completed",
      "Avg cost / task",
    ]);
  });
});

describe("AnalyticsKpiRow / Spend tile", () => {
  it("formats the value as $X.XX with mono styling", () => {
    render(<AnalyticsKpiRow {...baseProps()} spendUsd={4.2} />);
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value).toHaveTextContent("$4.20");
    expect(value.className).toContain("mono");
  });

  it("renders an em-dash when spendUsd is undefined", () => {
    render(<AnalyticsKpiRow {...baseProps()} spendUsd={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });

  it("renders an em-dash when spendUsd is NaN", () => {
    render(<AnalyticsKpiRow {...baseProps()} spendUsd={Number.NaN} />);
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });

  it("formats large totals with thousands grouping (USD locale)", () => {
    render(<AnalyticsKpiRow {...baseProps()} spendUsd={1234.5} />);
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent(
      "$1,234.50",
    );
  });
});

describe("AnalyticsKpiRow / Tokens tile", () => {
  it("formats the value mono and abbreviates large counts", () => {
    render(<AnalyticsKpiRow {...baseProps()} tokensTotal={42_000} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value.className).toContain("mono");
    // KpiTile compact formatter: 42_000 -> "42K".
    expect(value).toHaveTextContent(/42K/);
  });

  it("renders raw integer when below 1000", () => {
    render(<AnalyticsKpiRow {...baseProps()} tokensTotal={812} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("812");
  });

  it("renders an em-dash when tokensTotal is undefined", () => {
    render(<AnalyticsKpiRow {...baseProps()} tokensTotal={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});

describe("AnalyticsKpiRow / Tasks completed tile", () => {
  it("renders the count as-is", () => {
    render(<AnalyticsKpiRow {...baseProps()} tasksCompleted={17} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("17");
  });

  it("renders 0 (not em-dash) when tasksCompleted is 0", () => {
    render(<AnalyticsKpiRow {...baseProps()} tasksCompleted={0} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("0");
  });

  it("renders an em-dash when tasksCompleted is undefined", () => {
    render(<AnalyticsKpiRow {...baseProps()} tasksCompleted={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});

describe("AnalyticsKpiRow / Avg cost per task tile", () => {
  it("formats the value with 4-decimal USD precision and mono styling", () => {
    render(<AnalyticsKpiRow {...baseProps()} avgCostPerTask={0.0421} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value).toHaveTextContent("$0.0421");
    expect(value.className).toContain("mono");
  });

  it("preserves precision for sub-cent costs (regression: 2-decimal would round to $0.00)", () => {
    render(<AnalyticsKpiRow {...baseProps()} avgCostPerTask={0.0009} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    const value = within(tile).getByTestId("kpi-value");
    // 4-decimal rounding: 0.0009 -> $0.0009 (NOT $0.00 — that would
    // be a regression to the old 2-decimal cost formatter).
    expect(value.textContent).toBe("$0.0009");
  });

  it("renders an em-dash when avgCostPerTask is undefined", () => {
    render(<AnalyticsKpiRow {...baseProps()} avgCostPerTask={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});
