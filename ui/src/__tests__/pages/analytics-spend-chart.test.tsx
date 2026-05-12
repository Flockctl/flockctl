import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * SpendChart contract (M22 analytics restyle / T0X).
 *
 * Pins the recharts wiring without spinning up a real responsive
 * container — recharts is mocked so we can inspect:
 *   - the per-model `<Bar>` series share a single stack id,
 *   - every bar fills from the gradient defined in `<defs>`,
 *   - the gradient renders an indigo→purple `<linearGradient>` with
 *     two `<stop>` children,
 *   - tooltip + legend slots are wired to the custom content
 *     components (`SpendTooltipContent`, `ChartLegendContent`).
 *
 * The custom content components are themselves rendered in isolation
 * to assert on their tailwind class contracts (the brief pins exact
 * class strings).
 */

// --- recharts mock --------------------------------------------------

interface CapturedProps {
  bars: Array<Record<string, unknown>>;
  lines: Array<Record<string, unknown>>;
  tooltip: Record<string, unknown> | null;
  legend: Record<string, unknown> | null;
  barChart: Record<string, unknown> | null;
  cartesianGrid: Record<string, unknown> | null;
  xAxis: Record<string, unknown> | null;
  yAxis: Record<string, unknown> | null;
}

const captured: CapturedProps = {
  bars: [],
  lines: [],
  tooltip: null,
  legend: null,
  barChart: null,
  cartesianGrid: null,
  xAxis: null,
  yAxis: null,
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
    BarChart: passthrough("BarChart", (p) => {
      captured.barChart = p;
    }),
    Bar: passthrough("Bar", (p) => {
      captured.bars.push(p);
    }),
    LineChart: passthrough("LineChart"),
    Line: passthrough("Line", (p) => {
      captured.lines.push(p);
    }),
    XAxis: passthrough("XAxis", (p) => {
      captured.xAxis = p;
    }),
    YAxis: passthrough("YAxis", (p) => {
      captured.yAxis = p;
    }),
    Tooltip: passthrough("Tooltip", (p) => {
      captured.tooltip = p;
    }),
    Legend: passthrough("Legend", (p) => {
      captured.legend = p;
    }),
    CartesianGrid: passthrough("CartesianGrid", (p) => {
      captured.cartesianGrid = p;
    }),
  };
});

// Imported after the mock so the chart picks up stubbed primitives.
import {
  SpendChart,
  SpendTooltipContent,
  ChartLegendContent,
  SPEND_GRADIENT_ID,
  SPEND_STACK_ID,
} from "@/pages/analytics-components/SpendChart";

beforeEach(() => {
  captured.bars = [];
  captured.lines = [];
  captured.tooltip = null;
  captured.legend = null;
  captured.barChart = null;
  captured.cartesianGrid = null;
  captured.xAxis = null;
  captured.yAxis = null;
});

const SAMPLE = [
  { day: "2026-05-01", sonnet: 1.23, opus: 0.45 },
  { day: "2026-05-02", sonnet: 0.9, opus: 0.6 },
];
const MODELS = ["sonnet", "opus"];

describe("SpendChart / chart wiring", () => {
  it("renders one <Bar> per model, sharing a stack id", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);
    expect(captured.bars).toHaveLength(MODELS.length);
    const stackIds = new Set(captured.bars.map((b) => b.stackId));
    expect(stackIds.size).toBe(1);
    expect([...stackIds][0]).toBe(SPEND_STACK_ID);
  });

  it("each <Bar> uses the gradient defined in <defs>", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);
    for (const bar of captured.bars) {
      expect(bar.fill).toBe(`url(#${SPEND_GRADIENT_ID})`);
    }
  });

  it("preserves the model order from props as dataKey", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);
    expect(captured.bars.map((b) => b.dataKey)).toEqual(MODELS);
  });

  it("forwards the day data to BarChart", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);
    expect(captured.barChart?.data).toEqual(SAMPLE);
  });

  it("passes tooltip and legend through the custom content slot", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);

    const tooltipContent = captured.tooltip?.content as React.ReactElement | undefined;
    expect(React.isValidElement(tooltipContent)).toBe(true);
    expect((tooltipContent as React.ReactElement).type).toBe(SpendTooltipContent);

    const legendContent = captured.legend?.content as React.ReactElement | undefined;
    expect(React.isValidElement(legendContent)).toBe(true);
    expect((legendContent as React.ReactElement).type).toBe(ChartLegendContent);
  });

  it("renders an indigo→purple <linearGradient> with two stops in <defs>", () => {
    const { container } = render(<SpendChart data={SAMPLE} models={MODELS} />);
    const defs = container.querySelector("defs");
    expect(defs).not.toBeNull();
    const gradient = container.querySelector("linearGradient");
    expect(gradient).not.toBeNull();
    expect(gradient!.getAttribute("id")).toBe(SPEND_GRADIENT_ID);
    const stops = gradient!.querySelectorAll("stop");
    expect(stops.length).toBe(2);
    expect(stops[0]!.getAttribute("offset")).toBe("0%");
    expect(stops[1]!.getAttribute("offset")).toBe("100%");
  });

  it("rounds only the top-most bar in the stack", () => {
    render(<SpendChart data={SAMPLE} models={MODELS} />);
    expect(captured.bars[0]!.radius).toBe(0);
    expect(captured.bars[captured.bars.length - 1]!.radius).toEqual([4, 4, 0, 0]);
  });
});

describe("SpendTooltipContent", () => {
  it("returns null when inactive", () => {
    const { container } = render(
      <SpendTooltipContent active={false} payload={[{ dataKey: "x", value: 1 }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when payload is empty", () => {
    const { container } = render(<SpendTooltipContent active payload={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the brief's exact tooltip class string", () => {
    render(
      <SpendTooltipContent
        active
        label="2026-05-01"
        payload={[{ dataKey: "sonnet", name: "sonnet", value: 1.234, color: "#f00" }]}
      />,
    );
    const tip = screen.getByTestId("spend-tooltip");
    const cls = tip.className;
    expect(cls).toContain("bg-card");
    expect(cls).toContain("border");
    expect(cls).toContain("border-border");
    expect(cls).toContain("rounded-md");
    expect(cls).toContain("p-2");
    expect(cls).toContain("text-[12px]");
  });

  it("renders the label and one row per payload entry", () => {
    render(
      <SpendTooltipContent
        active
        label="2026-05-01"
        payload={[
          { dataKey: "sonnet", name: "sonnet", value: 1.2345, color: "#abc" },
          { dataKey: "opus", name: "opus", value: 0.5, color: "#def" },
        ]}
      />,
    );
    expect(screen.getByText("2026-05-01")).toBeInTheDocument();
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("$1.2345")).toBeInTheDocument();
    expect(screen.getByText("$0.5000")).toBeInTheDocument();
  });
});

describe("ChartLegendContent", () => {
  it("renders the brief's exact legend class string", () => {
    render(
      <ChartLegendContent payload={[{ value: "sonnet", color: "#abc" }]} />,
    );
    const legend = screen.getByTestId("chart-legend");
    const cls = legend.className;
    expect(cls).toContain("text-zinc-500");
    expect(cls).toContain("text-[11px]");
  });

  it("renders one chip per payload entry", () => {
    render(
      <ChartLegendContent
        payload={[
          { value: "sonnet", color: "#abc" },
          { value: "opus", color: "#def" },
        ]}
      />,
    );
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
  });

  it("tolerates an undefined payload", () => {
    render(<ChartLegendContent />);
    expect(screen.getByTestId("chart-legend")).toBeInTheDocument();
  });
});
