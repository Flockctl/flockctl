import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ProjectKpiRow } from "@/pages/project-detail-components/ProjectKpiRow";

/**
 * Unit tests for {@link ProjectKpiRow} (M23 / project-detail / T01).
 *
 * The row is presentational: 5 KpiTile instances in a `grid grid-cols-5
 * gap-3` row. Page assembly (T09) wires `useKpiData(projectId)` into
 * these props — that's covered by the page-level test, not here.
 *
 * Coverage:
 *   - exact 5-tile layout in `grid-cols-5`,
 *   - tile labels in left → right order,
 *   - Slices renders `{done} / {total}` + gradient progress bar,
 *   - Active tasks / Pending approval render the raw counts,
 *   - Failed 24h flips to danger tone when > 0 and stays default at 0,
 *   - Cost is `$X.XX` mono with optional `of $Y.YY` budget hint,
 *   - undefined values across every field collapse to the em-dash sentinel.
 */

function baseProps() {
  return {
    slicesDone: 12,
    slicesTotal: 12,
    activeTasks: 0,
    pendingApproval: 0,
    failed24h: 0,
    costUsd: 0.04,
  } as const;
}

describe("ProjectKpiRow / layout", () => {
  it("renders exactly 5 KpiTile-shaped tiles", () => {
    render(<ProjectKpiRow {...baseProps()} />);
    expect(screen.getAllByTestId("kpi-tile")).toHaveLength(5);
  });

  it("uses a 5-column grid with the prototype's gap", () => {
    render(<ProjectKpiRow {...baseProps()} />);
    const root = screen.getByTestId("project-kpi-row");
    expect(root.className).toContain("grid");
    expect(root.className).toContain("grid-cols-5");
    expect(root.className).toContain("gap-3");
  });

  it("renders the five expected labels in left → right order", () => {
    render(<ProjectKpiRow {...baseProps()} />);
    const labels = screen
      .getAllByTestId("kpi-label")
      .map((n) => n.textContent);
    expect(labels).toEqual([
      "Slices",
      "Active tasks",
      "Pending approval",
      "Failed 24h",
      "Cost",
    ]);
  });
});

describe("ProjectKpiRow / Slices tile", () => {
  it('renders "{done} / {total}"', () => {
    render(
      <ProjectKpiRow {...baseProps()} slicesDone={7} slicesTotal={12} />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent(
      "7 / 12",
    );
  });

  it("renders a gradient progress bar with the right valuemin/max/now", () => {
    render(
      <ProjectKpiRow {...baseProps()} slicesDone={7} slicesTotal={12} />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    const bar = within(tile).getByTestId("kpi-progress");
    expect(bar).toBeInTheDocument();
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("12");
    expect(bar.getAttribute("aria-valuenow")).toBe("7");
    const fill = bar.querySelector("div");
    // Gradient tone — bg-gradient-to-r from-indigo-400 to-indigo-600.
    expect(fill?.className ?? "").toContain("bg-gradient-to-r");
  });

  it("omits the progress bar when slicesTotal is 0", () => {
    render(
      <ProjectKpiRow {...baseProps()} slicesDone={0} slicesTotal={0} />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).queryByTestId("kpi-progress")).toBeNull();
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent(
      "0 / 0",
    );
  });

  it("collapses to em-dash when either slicesDone or slicesTotal is undefined", () => {
    render(
      <ProjectKpiRow
        {...baseProps()}
        slicesDone={undefined}
        slicesTotal={12}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});

describe("ProjectKpiRow / Active tasks tile", () => {
  it("renders the raw count", () => {
    render(<ProjectKpiRow {...baseProps()} activeTasks={5} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("5");
  });

  it("renders zero as `0` (not em-dash)", () => {
    render(<ProjectKpiRow {...baseProps()} activeTasks={0} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("0");
  });

  it("renders em-dash when undefined", () => {
    render(<ProjectKpiRow {...baseProps()} activeTasks={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});

describe("ProjectKpiRow / Pending approval tile", () => {
  it("renders the raw count", () => {
    render(<ProjectKpiRow {...baseProps()} pendingApproval={3} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("3");
  });
});

describe("ProjectKpiRow / Failed 24h tile", () => {
  it("uses the default tone when count is 0", () => {
    render(<ProjectKpiRow {...baseProps()} failed24h={0} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    expect(tile.getAttribute("data-tone")).toBe("default");
  });

  it("flips to the danger tone when count > 0", () => {
    render(<ProjectKpiRow {...baseProps()} failed24h={2} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    expect(tile.getAttribute("data-tone")).toBe("danger");
    // The label ought to render in the danger palette too.
    const label = within(tile).getByTestId("kpi-label");
    expect(label.className).toContain("text-red-500");
  });

  it("stays default when failed24h is undefined", () => {
    render(<ProjectKpiRow {...baseProps()} failed24h={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    expect(tile.getAttribute("data-tone")).toBe("default");
  });
});

describe("ProjectKpiRow / Cost tile", () => {
  it("formats the value as $X.XX with mono styling", () => {
    render(<ProjectKpiRow {...baseProps()} costUsd={0.04} />);
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value).toHaveTextContent("$0.04");
    expect(value.className).toContain("mono");
  });

  it("renders the budget hint when one is supplied", () => {
    render(
      <ProjectKpiRow
        {...baseProps()}
        costUsd={4.21}
        costBudgetUsd={10}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    expect(within(tile).getByTestId("kpi-hint")).toHaveTextContent(
      /of \$10\.00/,
    );
  });

  it("omits the budget hint when no cap is supplied", () => {
    render(<ProjectKpiRow {...baseProps()} costUsd={4.21} />);
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    expect(within(tile).queryByTestId("kpi-hint")).toBeNull();
  });

  it("renders an em-dash when costUsd is undefined", () => {
    render(<ProjectKpiRow {...baseProps()} costUsd={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});
