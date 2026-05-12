import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * TokenChart contract.
 *
 * Pins the recharts wiring without spinning up a real responsive
 * container. Asserts:
 *   - exactly two `<Line>` series — `tokens_in` and `tokens_out`,
 *   - in-line strokes indigo (`var(--primary)`) and emerald
 *     (`var(--chart-success, #10b981)`),
 *   - tooltip slot wired to TokenTooltipContent,
 *   - legend slot wired to the shared ChartLegendContent.
 *
 * Tooltip class contract is verified by rendering TokenTooltipContent
 * directly with a mocked payload.
 */

interface CapturedProps {
  lines: Array<Record<string, unknown>>;
  tooltip: Record<string, unknown> | null;
  legend: Record<string, unknown> | null;
  lineChart: Record<string, unknown> | null;
}

const captured: CapturedProps = {
  lines: [],
  tooltip: null,
  legend: null,
  lineChart: null,
};

vi.mock("recharts", () => {
  const passthrough = (
    name: string,
    sink?: (props: Record<string, unknown>) => void,
  ) => {
    const Comp = (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      const { children, ...rest } = props;
      sink?.(rest);
      return React.createElement("div", { "data-recharts": name }, children);
    };
    Comp.displayName = name;
    return Comp;
  };

  return {
    ResponsiveContainer: passthrough("ResponsiveContainer"),
    BarChart: passthrough("BarChart"),
    Bar: passthrough("Bar"),
    LineChart: passthrough("LineChart", (p) => {
      captured.lineChart = p;
    }),
    Line: passthrough("Line", (p) => {
      captured.lines.push(p);
    }),
    XAxis: passthrough("XAxis"),
    YAxis: passthrough("YAxis"),
    Tooltip: passthrough("Tooltip", (p) => {
      captured.tooltip = p;
    }),
    Legend: passthrough("Legend", (p) => {
      captured.legend = p;
    }),
    CartesianGrid: passthrough("CartesianGrid"),
  };
});

import {
  TokenChart,
  TokenTooltipContent,
  TOKEN_IN_STROKE,
  TOKEN_OUT_STROKE,
} from "@/pages/analytics-components/TokenChart";
import { ChartLegendContent } from "@/pages/analytics-components/SpendChart";

beforeEach(() => {
  captured.lines = [];
  captured.tooltip = null;
  captured.legend = null;
  captured.lineChart = null;
});

const SAMPLE = [
  { day: "2026-05-01", tokens_in: 12_400, tokens_out: 4_100 },
  { day: "2026-05-02", tokens_in: 9_800, tokens_out: 3_200 },
];

describe("TokenChart / chart wiring", () => {
  it("renders exactly two line series — tokens_in and tokens_out", () => {
    render(<TokenChart data={SAMPLE} />);
    expect(captured.lines).toHaveLength(2);
    expect(captured.lines.map((l) => l.dataKey)).toEqual([
      "tokens_in",
      "tokens_out",
    ]);
  });

  it("strokes the in line indigo and the out line emerald", () => {
    render(<TokenChart data={SAMPLE} />);
    expect(captured.lines[0]!.stroke).toBe(TOKEN_IN_STROKE);
    expect(captured.lines[1]!.stroke).toBe(TOKEN_OUT_STROKE);
    // Sanity-check the tokens themselves resolve to indigo / emerald.
    expect(TOKEN_IN_STROKE).toContain("var(--primary)");
    expect(TOKEN_OUT_STROKE).toContain("#10b981");
  });

  it("forwards the day data to LineChart", () => {
    render(<TokenChart data={SAMPLE} />);
    expect(captured.lineChart?.data).toEqual(SAMPLE);
  });

  it("disables dots on both lines (clean strokes only)", () => {
    render(<TokenChart data={SAMPLE} />);
    for (const line of captured.lines) {
      expect(line.dot).toBe(false);
    }
  });

  it("wires the tooltip slot to TokenTooltipContent", () => {
    render(<TokenChart data={SAMPLE} />);
    const tooltipContent = captured.tooltip?.content as React.ReactElement | undefined;
    expect(React.isValidElement(tooltipContent)).toBe(true);
    expect((tooltipContent as React.ReactElement).type).toBe(TokenTooltipContent);
  });

  it("wires the legend slot to the shared ChartLegendContent", () => {
    render(<TokenChart data={SAMPLE} />);
    const legendContent = captured.legend?.content as React.ReactElement | undefined;
    expect(React.isValidElement(legendContent)).toBe(true);
    expect((legendContent as React.ReactElement).type).toBe(ChartLegendContent);
  });
});

describe("TokenTooltipContent", () => {
  it("returns null when inactive", () => {
    const { container } = render(
      <TokenTooltipContent active={false} payload={[{ dataKey: "tokens_in", value: 1 }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when payload is empty", () => {
    const { container } = render(<TokenTooltipContent active payload={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the brief's exact tooltip class string", () => {
    render(
      <TokenTooltipContent
        active
        label="2026-05-01"
        payload={[{ dataKey: "tokens_in", name: "In", value: 1234, color: "#6366f1" }]}
      />,
    );
    const tip = screen.getByTestId("token-tooltip");
    const cls = tip.className;
    expect(cls).toContain("bg-card");
    expect(cls).toContain("border");
    expect(cls).toContain("border-border");
    expect(cls).toContain("rounded-md");
    expect(cls).toContain("p-2");
    expect(cls).toContain("text-[12px]");
  });

  it("renders both in and out series with locale-formatted values", () => {
    render(
      <TokenTooltipContent
        active
        label="2026-05-01"
        payload={[
          { dataKey: "tokens_in", name: "In", value: 12_400, color: "#6366f1" },
          { dataKey: "tokens_out", name: "Out", value: 4_100, color: "#10b981" },
        ]}
      />,
    );
    expect(screen.getByText("2026-05-01")).toBeInTheDocument();
    expect(screen.getByText("In")).toBeInTheDocument();
    expect(screen.getByText("Out")).toBeInTheDocument();
    // Locale-formatted (en-US grouping) — accept either thousand-separator
    // form so the test isn't sensitive to the runner's default locale.
    const inLine = screen.getByText(/^12[\s,.]?400$/);
    const outLine = screen.getByText(/^4[\s,.]?100$/);
    expect(inLine).toBeInTheDocument();
    expect(outLine).toBeInTheDocument();
  });
});
