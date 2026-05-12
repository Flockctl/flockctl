import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  KpiTile,
  formatKpiValue,
  _resetKpiTileWarnings,
} from "@/components/design/KpiTile";

beforeEach(() => {
  _resetKpiTileWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KpiTile / wrapper layout", () => {
  it("renders the label text uppercase with tracking-wider", () => {
    render(<KpiTile label="Active runs" value={3} />);
    const label = screen.getByTestId("kpi-label");
    expect(label).toHaveTextContent("Active runs");
    expect(label.className).toContain("uppercase");
    expect(label.className).toContain("tracking-wider");
  });

  it("applies the flat surface wrapper classes", () => {
    render(<KpiTile label="Tasks" value={2} />);
    const root = screen.getByTestId("kpi-tile");
    for (const cls of [
      "rounded-xl",
      "border",
      "divider-y",
      "bg-white",
      "dark:bg-zinc-900",
      "p-3.5",
    ]) {
      expect(root.className).toContain(cls);
    }
  });
});

describe("KpiTile / value rendering", () => {
  it("renders integer values as-is", () => {
    render(<KpiTile label="Tasks" value={42} />);
    expect(screen.getByTestId("kpi-value")).toHaveTextContent("42");
  });

  it("renders string values verbatim", () => {
    render(<KpiTile label="Status" value="green" />);
    expect(screen.getByTestId("kpi-value")).toHaveTextContent("green");
  });

  it("renders an em-dash placeholder for value=undefined and never NaN", () => {
    render(<KpiTile label="Cost" value={undefined} />);
    const v = screen.getByTestId("kpi-value");
    expect(v).toHaveTextContent("—");
    expect(v.textContent).not.toContain("NaN");
    expect(v.textContent).not.toContain("undefined");
  });

  it("renders an em-dash for NaN inputs (defensive)", () => {
    render(<KpiTile label="Cost" value={Number.NaN} />);
    expect(screen.getByTestId("kpi-value")).toHaveTextContent("—");
  });

  it("abbreviates values >= 1000 with K", () => {
    render(<KpiTile label="Tokens" value={1234} />);
    // Intl.NumberFormat compact en-US -> "1.2K"
    expect(screen.getByTestId("kpi-value")).toHaveTextContent(/1\.2K/);
  });

  it("abbreviates very large values (1_200_000) with M", () => {
    render(<KpiTile label="Tokens" value={1_200_000} />);
    expect(screen.getByTestId("kpi-value")).toHaveTextContent(/1\.2M/);
  });

  it("abbreviates 412_000 as 412K", () => {
    render(<KpiTile label="Tokens" value={412_000} />);
    expect(screen.getByTestId("kpi-value")).toHaveTextContent(/412K/);
  });
});

describe("KpiTile / mono variant", () => {
  it("does not apply mono class by default", () => {
    render(<KpiTile label="Tokens" value={42} />);
    expect(screen.getByTestId("kpi-value").className).not.toContain("mono");
  });

  it("applies the mono utility when mono=true", () => {
    render(<KpiTile label="Tokens" value={42} mono />);
    expect(screen.getByTestId("kpi-value").className).toContain("mono");
  });
});

describe("KpiTile / trend rendering", () => {
  it("renders a positive trend as a success StatusPill", () => {
    render(
      <KpiTile
        label="Runs"
        value={10}
        trend={{ delta: "+2 today", tone: "positive" }}
      />,
    );
    const trend = screen.getByTestId("kpi-trend");
    expect(trend).toHaveTextContent("+2 today");
    expect(trend.dataset.trendTone).toBe("positive");
    // StatusPill tone="success" applies bg-emerald-500/15.
    expect(trend.className).toContain("bg-emerald-500/15");
  });

  it("renders a negative trend as a danger StatusPill", () => {
    render(
      <KpiTile
        label="Failures"
        value={3}
        trend={{ delta: "-1 today", tone: "negative" }}
      />,
    );
    const trend = screen.getByTestId("kpi-trend");
    expect(trend.dataset.trendTone).toBe("negative");
    expect(trend.className).toContain("bg-red-500/15");
  });

  it("renders a neutral trend as a plain muted span (no pill)", () => {
    render(
      <KpiTile
        label="Runs"
        value={10}
        trend={{ delta: "no change", tone: "neutral" }}
      />,
    );
    const trend = screen.getByTestId("kpi-trend");
    expect(trend.dataset.trendTone).toBe("neutral");
    // Neutral does NOT use StatusPill, so it must not carry pill bg classes.
    expect(trend.className).not.toContain("bg-emerald-500/15");
    expect(trend.className).not.toContain("bg-red-500/15");
    expect(trend.className).toContain("text-zinc-500");
  });

  it("omits the trend chip entirely when no trend prop is passed", () => {
    render(<KpiTile label="Runs" value={10} />);
    expect(screen.queryByTestId("kpi-trend")).toBeNull();
  });
});

describe("KpiTile / hint", () => {
  it("renders the hint text muted in the value row", () => {
    render(<KpiTile label="Cost" value="$5.20" hint="$20 budget" />);
    const hint = screen.getByTestId("kpi-hint");
    expect(hint).toHaveTextContent("$20 budget");
    expect(hint.className).toContain("text-zinc-500");
  });

  it("omits the hint slot when no hint prop is passed", () => {
    render(<KpiTile label="Cost" value="$5.20" />);
    expect(screen.queryByTestId("kpi-hint")).toBeNull();
  });
});

describe("KpiTile / sparkbar vs progress", () => {
  it("renders the sparkbar when only spark is supplied", () => {
    render(
      <KpiTile label="Throughput" value={42} spark={[1, 5, 3, 8, 4, 9, 6, 2]} />,
    );
    expect(screen.getByTestId("kpi-sparkbar")).toBeTruthy();
    expect(screen.queryByTestId("kpi-progress")).toBeNull();
  });

  it("renders the progress bar when only progress is supplied", () => {
    render(
      <KpiTile
        label="Budget"
        value="$5"
        progress={{ value: 5, max: 20 }}
      />,
    );
    const bar = screen.getByTestId("kpi-progress");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "20");
    expect(screen.queryByTestId("kpi-sparkbar")).toBeNull();
  });

  it("renders progress and warns when BOTH spark and progress are passed (caller error)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <KpiTile
        label="Budget"
        value="$5"
        spark={[1, 2, 3]}
        progress={{ value: 5, max: 20 }}
      />,
    );
    expect(screen.queryByTestId("kpi-sparkbar")).toBeNull();
    expect(screen.getByTestId("kpi-progress")).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatch(/spark.*progress|progress.*spark/i);
  });

  it("supports the gradient progress tone variant", () => {
    render(
      <KpiTile
        label="Budget"
        value="$5"
        progress={{ value: 5, max: 20, tone: "gradient" }}
      />,
    );
    const fill = screen.getByTestId("kpi-progress").firstElementChild as HTMLElement;
    expect(fill.className).toContain("from-indigo-400");
    expect(fill.className).toContain("to-indigo-600");
  });

  it("renders nothing for an empty spark array", () => {
    render(<KpiTile label="Throughput" value={42} spark={[]} />);
    expect(screen.queryByTestId("kpi-sparkbar")).toBeNull();
  });
});

describe("KpiTile / tone variants", () => {
  it("default tone uses zinc-500 label colour", () => {
    render(<KpiTile label="Default" value={1} />);
    const label = screen.getByTestId("kpi-label");
    expect(label.className).toContain("text-zinc-500");
    expect(screen.getByTestId("kpi-tile").dataset.tone).toBe("default");
  });

  it("danger tone uses red-500 label colour (Failed 24h tile)", () => {
    render(<KpiTile label="Failed 24h" value={5} tone="danger" />);
    const label = screen.getByTestId("kpi-label");
    expect(label.className).toContain("text-red-500");
    expect(screen.getByTestId("kpi-tile").dataset.tone).toBe("danger");
  });

  it("warning tone uses amber-500 label colour", () => {
    render(<KpiTile label="At limit" value={1} tone="warning" />);
    const label = screen.getByTestId("kpi-label");
    expect(label.className).toContain("text-amber-500");
  });

  it("unknown tone falls back to default and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Cast through unknown — the type system blocks this but runtime callers
    // (or stale fixtures) can still smuggle a junk value in.
    render(
      <KpiTile
        label="Bogus"
        value={1}
        tone={"hax0r" as unknown as "default"}
      />,
    );
    const label = screen.getByTestId("kpi-label");
    expect(label.className).toContain("text-zinc-500");
    expect(screen.getByTestId("kpi-tile").dataset.tone).toBe("default");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/unknown tone/i);

    // Re-render with the same bad tone; the warn must be deduped.
    render(
      <KpiTile
        label="Bogus2"
        value={2}
        tone={"hax0r" as unknown as "default"}
      />,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("formatKpiValue helper", () => {
  it.each([
    [undefined, "—"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [42, "42"],
    [0, "0"],
    [-7, "-7"],
    ["green", "green"],
  ])("formats %p as %p", (input, expected) => {
    expect(formatKpiValue(input as never)).toBe(expected);
  });

  it("formats 0.4321 with 2 decimals", () => {
    expect(formatKpiValue(0.4321)).toBe("0.43");
  });

  it("uses compact notation past 1000", () => {
    expect(formatKpiValue(1234)).toMatch(/1\.2K/);
    expect(formatKpiValue(412_000)).toMatch(/412K/);
    expect(formatKpiValue(1_200_000)).toMatch(/1\.2M/);
  });
});
