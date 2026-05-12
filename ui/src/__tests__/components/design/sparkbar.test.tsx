import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Sparkbar } from "@/components/design/Sparkbar";

function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("span.sparkbar"));
}

function heightPx(el: HTMLElement): number {
  // style.height is a string like "12px" — strip the unit and parse.
  return Number.parseFloat(el.style.height);
}

describe("Sparkbar", () => {
  it("renders nothing when data is empty", () => {
    const { container } = render(<Sparkbar data={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one .sparkbar span per data point (up to maxBars)", () => {
    const { container } = render(<Sparkbar data={[1, 2, 3, 4]} />);
    expect(bars(container)).toHaveLength(4);
  });

  it("slices to the last maxBars entries (default 8)", () => {
    const { container } = render(
      <Sparkbar data={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} />,
    );
    expect(bars(container)).toHaveLength(8);
  });

  it("respects an explicit maxBars override", () => {
    const { container } = render(
      <Sparkbar data={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} maxBars={3} />,
    );
    const rendered = bars(container);
    expect(rendered).toHaveLength(3);
    // The last three values are [8, 9, 10]; min=8, max=10 → heights:
    //   8  → 4 + 0/2 * 24 = 4
    //   9  → 4 + 1/2 * 24 = 16
    //   10 → 4 + 2/2 * 24 = 28
    expect(heightPx(rendered[0]!)).toBeCloseTo(4);
    expect(heightPx(rendered[1]!)).toBeCloseTo(16);
    expect(heightPx(rendered[2]!)).toBeCloseTo(28);
  });

  it("scales heights into the [4, 28]px window", () => {
    const { container } = render(<Sparkbar data={[10, 20, 30, 40]} />);
    const heights = bars(container).map(heightPx);
    expect(Math.min(...heights)).toBeCloseTo(4);
    expect(Math.max(...heights)).toBeCloseTo(28);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(4);
      expect(h).toBeLessThanOrEqual(28);
    }
  });

  it("collapses a flat series to the 4px floor (range = 0 guard)", () => {
    const { container } = render(<Sparkbar data={[7, 7, 7, 7]} />);
    const heights = bars(container).map(heightPx);
    expect(heights).toEqual([4, 4, 4, 4]);
  });

  it.each([
    ["emerald", "text-emerald-500"],
    ["indigo", "text-indigo-500"],
    ["amber", "text-amber-500"],
    ["rose", "text-rose-500"],
  ] as const)("applies tone=%s class", (tone, cls) => {
    const { container } = render(
      <Sparkbar data={[1, 2, 3]} tone={tone} data-testid="sb" />,
    );
    const wrapper = container.querySelector('[data-testid="sb"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain(cls);
    expect((wrapper as HTMLElement).dataset.tone).toBe(tone);
  });

  it("defaults to the indigo tone", () => {
    const { container } = render(
      <Sparkbar data={[1, 2, 3]} data-testid="sb" />,
    );
    const wrapper = container.querySelector(
      '[data-testid="sb"]',
    ) as HTMLElement;
    expect(wrapper.className).toContain("text-indigo-500");
    expect(wrapper.dataset.tone).toBe("indigo");
  });

  it("applies the .mono utility and 10px text size", () => {
    const { container } = render(
      <Sparkbar data={[1, 2, 3]} data-testid="sb" />,
    );
    const wrapper = container.querySelector(
      '[data-testid="sb"]',
    ) as HTMLElement;
    expect(wrapper.className).toContain("mono");
    expect(wrapper.className).toContain("text-[10px]");
  });

  it("merges caller className without dropping defaults", () => {
    const { container } = render(
      <Sparkbar
        data={[1, 2, 3]}
        className="ml-2"
        data-testid="sb"
      />,
    );
    const wrapper = container.querySelector(
      '[data-testid="sb"]',
    ) as HTMLElement;
    expect(wrapper.className).toContain("ml-2");
    expect(wrapper.className).toContain("mono");
    expect(wrapper.className).toContain("text-indigo-500");
  });

  it("forwards extra HTML attributes", () => {
    const { getByLabelText } = render(
      <Sparkbar
        data={[1, 2, 3]}
        aria-label="usage"
        title="hint"
        role="img"
      />,
    );
    const el = getByLabelText("usage");
    expect(el.getAttribute("title")).toBe("hint");
    expect(el.getAttribute("role")).toBe("img");
  });
});
