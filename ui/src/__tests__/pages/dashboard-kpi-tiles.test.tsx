import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { DashboardKpiTiles } from "@/pages/dashboard-components/DashboardKpiTiles";
import { formatInOutHint } from "@/pages/dashboard-components/formatInOutHint";

/**
 * Unit tests for {@link DashboardKpiTiles} (M22 dashboard slice — T01).
 *
 * The strip is presentational: 5 tiles, single grid row at lg+, with
 * tile-shape + slot semantics that the brief calls out explicitly. We
 * cover:
 *
 *   - exactly 5 KpiTile-shaped instances render in `lg:grid-cols-5`,
 *   - each tile carries its expected label,
 *   - Cost is rendered mono with budget hint + indigo progress bar,
 *   - Tokens carries the `in/out R:1` hint + Sparkbar trail,
 *   - Open chats has a 5-dot bottom slot (live + idle),
 *   - Missions amber pill only appears when proposals > 0,
 *   - Missions progress bar uses the gradient tone.
 */

function baseProps() {
  return {
    activeTasks: 3,
    costUsd: 4.21,
    tokensTotal: 12_400,
    openChats: 2,
    missions: 1,
  } as const;
}

describe("DashboardKpiTiles / layout", () => {
  it("renders exactly 5 KpiTile-shaped tiles", () => {
    render(<DashboardKpiTiles {...baseProps()} />);
    const tiles = screen.getAllByTestId("kpi-tile");
    expect(tiles).toHaveLength(5);
  });

  it("uses a 5-column grid at lg+", () => {
    render(<DashboardKpiTiles {...baseProps()} />);
    const grid = screen.getByTestId("dashboard-kpi-tiles");
    expect(grid.className).toContain("lg:grid-cols-5");
    expect(grid.className).toContain("grid");
  });

  it("renders the five expected labels in order", () => {
    render(<DashboardKpiTiles {...baseProps()} />);
    const labels = screen.getAllByTestId("kpi-label").map((n) => n.textContent);
    expect(labels).toEqual([
      "Active tasks",
      "Cost · 24h",
      "Tokens",
      "Open chats",
      "Missions",
    ]);
  });
});

describe("DashboardKpiTiles / Active tasks tile", () => {
  it("renders the count as-is", () => {
    render(<DashboardKpiTiles {...baseProps()} activeTasks={7} />);
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("7");
  });

  it("renders neutral trend when activeTasksTrend is provided", () => {
    render(
      <DashboardKpiTiles {...baseProps()} activeTasksTrend="+3 today" />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[0]!;
    const trend = within(tile).getByTestId("kpi-trend");
    expect(trend).toHaveTextContent("+3 today");
    expect(trend.getAttribute("data-trend-tone")).toBe("neutral");
  });
});

describe("DashboardKpiTiles / Cost · 24h tile", () => {
  it("formats the value as $X.XX with mono styling", () => {
    render(<DashboardKpiTiles {...baseProps()} costUsd={4.2} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value).toHaveTextContent("$4.20");
    expect(value.className).toContain("mono");
  });

  it("renders the budget hint when a budget is supplied", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        costUsd={4.21}
        costBudgetUsd={10}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-hint")).toHaveTextContent(
      /of \$10\.00/,
    );
  });

  it("renders an indigo progress bar reflecting cost / budget", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        costUsd={4}
        costBudgetUsd={10}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    const bar = within(tile).getByTestId("kpi-progress");
    expect(bar).toBeInTheDocument();
    expect(bar.getAttribute("aria-valuemax")).toBe("10");
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    // Indigo tone — KpiTile renders a `bg-indigo-500` fill for tone="indigo".
    const fill = bar.querySelector("div");
    expect(fill?.className ?? "").toContain("bg-indigo-500");
  });

  it("omits the progress bar when no budget is supplied", () => {
    render(<DashboardKpiTiles {...baseProps()} costUsd={4} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).queryByTestId("kpi-progress")).toBeNull();
  });

  it("renders an em-dash when costUsd is undefined", () => {
    render(<DashboardKpiTiles {...baseProps()} costUsd={undefined} />);
    const tile = screen.getAllByTestId("kpi-tile")[1]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("—");
  });
});

describe("DashboardKpiTiles / Tokens tile", () => {
  it("formats the value mono and abbreviates large counts", () => {
    render(<DashboardKpiTiles {...baseProps()} tokensTotal={12_400} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    const value = within(tile).getByTestId("kpi-value");
    expect(value.className).toContain("mono");
    // 12_400 -> compact "12.4K"
    expect(value).toHaveTextContent(/12\.4K/);
  });

  it("renders an `in/out R:1` hint from tokensIn/tokensOut", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        tokensIn={9000}
        tokensOut={3000}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-hint")).toHaveTextContent(
      "in/out 3:1",
    );
  });

  it("renders a Sparkbar trail when tokensSpark is supplied", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        tokensSpark={[1, 2, 3, 4, 5, 6, 7, 8]}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).getByTestId("kpi-sparkbar")).toBeInTheDocument();
  });

  it("omits the Sparkbar when tokensSpark is empty / undefined", () => {
    render(<DashboardKpiTiles {...baseProps()} tokensSpark={[]} />);
    const tile = screen.getAllByTestId("kpi-tile")[2]!;
    expect(within(tile).queryByTestId("kpi-sparkbar")).toBeNull();
  });
});

describe("DashboardKpiTiles / Open chats tile", () => {
  it("renders 5 LiveDot slots regardless of input length", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        openChats={2}
        chatStates={["live", "live"]}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    const dots = within(tile).getAllByRole("listitem");
    expect(dots).toHaveLength(5);
  });

  it("respects live/idle order, padding the rest with idle", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        chatStates={["live", "idle", "live"]}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    const states = within(tile)
      .getAllByRole("listitem")
      .map((d) => d.getAttribute("data-state"));
    expect(states).toEqual(["live", "idle", "live", "idle", "idle"]);
  });

  it("clips to 5 dots if the caller passes more", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        chatStates={[
          "live",
          "live",
          "live",
          "live",
          "live",
          "live",
          "live",
        ]}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[3]!;
    expect(within(tile).getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("DashboardKpiTiles / Missions tile", () => {
  it("renders the count and no proposals pill when pendingProposals is 0", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        missions={2}
        pendingProposals={0}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    expect(within(tile).getByTestId("kpi-value")).toHaveTextContent("2");
    expect(
      within(tile).queryByTestId("missions-proposals-pill"),
    ).toBeNull();
  });

  it("renders an amber proposals pill when pendingProposals > 0", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        missions={2}
        pendingProposals={3}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    const pill = within(tile).getByTestId("missions-proposals-pill");
    expect(pill).toHaveTextContent("3 proposals");
    // StatusPill tone="warning" -> amber palette.
    expect(pill.getAttribute("data-tone")).toBe("warning");
  });

  it("renders a gradient progress bar when missionsTotal is supplied", () => {
    render(
      <DashboardKpiTiles
        {...baseProps()}
        missions={2}
        missionsTotal={5}
      />,
    );
    const tile = screen.getAllByTestId("kpi-tile")[4]!;
    const bar = within(tile).getByTestId("kpi-progress");
    expect(bar.getAttribute("data-tone")).toBe("gradient");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    const fill = bar.querySelector("div");
    expect(fill?.className ?? "").toContain("bg-gradient-to-r");
  });
});

describe("formatInOutHint", () => {
  it("returns undefined when both args are undefined", () => {
    expect(formatInOutHint(undefined, undefined)).toBeUndefined();
  });

  it("returns 'in only' when tokensOut is 0 and tokensIn > 0", () => {
    expect(formatInOutHint(100, 0)).toBe("in only");
  });

  it("computes 9000:3000 -> 'in/out 3:1'", () => {
    expect(formatInOutHint(9000, 3000)).toBe("in/out 3:1");
  });

  it("rounds to one decimal for non-integer ratios", () => {
    expect(formatInOutHint(3000, 2000)).toBe("in/out 1.5:1");
  });

  it("returns undefined for the trivial 0/0 case", () => {
    expect(formatInOutHint(0, 0)).toBeUndefined();
  });
});
