import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub `useKpiData` — the component is a pure render of whatever that
// hook returns. All edge cases we care about (zeros, amber highlight,
// red "failed", million-token formatter, sub-cent cost, per-field
// skeleton) are driven by varying the mock's return value.
const kpiSpy = vi.fn();

vi.mock("@/lib/use-kpi-data", () => ({
  useKpiData: (...args: unknown[]) => kpiSpy(...args),
}));

// Must import AFTER vi.mock so the component resolves to the stub.
import {
  MissionControlKpiBar,
  MissionControlKpiBarView,
  KPI_NULL_PLACEHOLDER,
  formatKpiTokens,
  formatKpiCost,
} from "@/pages/project-detail-components/MissionControlKpiBar";

type KpiSnapshot = {
  slicesDone: number;
  slicesTotal: number;
  activeTasks: number;
  pendingApproval: number;
  failed24h: number;
  tokens24h: number;
  costCents24h: number;
  isLoading?: Partial<Record<
    | "slicesDone"
    | "slicesTotal"
    | "activeTasks"
    | "pendingApproval"
    | "failed24h"
    | "tokens24h"
    | "costCents24h",
    boolean
  >>;
  error?: Partial<Record<
    | "slicesDone"
    | "slicesTotal"
    | "activeTasks"
    | "pendingApproval"
    | "failed24h"
    | "tokens24h"
    | "costCents24h",
    unknown
  >>;
};

function stubKpi(overrides: Partial<KpiSnapshot> = {}) {
  kpiSpy.mockReturnValue({
    slicesDone: 0,
    slicesTotal: 0,
    activeTasks: 0,
    pendingApproval: 0,
    failed24h: 0,
    tokens24h: 0,
    costCents24h: 0,
    ...overrides,
    isLoading: {
      slicesDone: false,
      slicesTotal: false,
      activeTasks: false,
      pendingApproval: false,
      failed24h: false,
      tokens24h: false,
      costCents24h: false,
      ...(overrides.isLoading ?? {}),
    },
    error: {
      slicesDone: null,
      slicesTotal: null,
      activeTasks: null,
      pendingApproval: null,
      failed24h: null,
      tokens24h: null,
      costCents24h: null,
      ...(overrides.error ?? {}),
    },
  });
}

describe("kpi_bar formatters", () => {
  it("formats millions of tokens as `1.2M` (not scientific notation)", () => {
    expect(formatKpiTokens(1_200_000)).toBe("1.2M");
    // Boundary: exactly 1M should still use the M unit.
    expect(formatKpiTokens(1_000_000)).toBe("1.0M");
    expect(formatKpiTokens(999_999)).toBe("1000.0K");
  });

  it("formats thousands as `1.2K` and leaves small numbers raw", () => {
    expect(formatKpiTokens(1_200)).toBe("1.2K");
    expect(formatKpiTokens(0)).toBe("0");
    expect(formatKpiTokens(42)).toBe("42");
  });

  it("formats zero cents as `$0.00`", () => {
    // Explicitly zero — no spend at all — must read as $0.00, NOT the
    // sub-cent sentinel.
    expect(formatKpiCost(0)).toBe("$0.00");
  });

  it("formats non-zero sub-cent costs as `<$0.01`, never `$0.00`", () => {
    // 0.4 cents would round to $0.00 if we just stringified it; the
    // sentinel makes the non-zero spend visible.
    expect(formatKpiCost(0.4)).toBe("<$0.01");
  });

  it("formats whole-cent costs as `$X.YZ`", () => {
    expect(formatKpiCost(42)).toBe("$0.42");
    expect(formatKpiCost(1234)).toBe("$12.34");
  });
});

describe("kpi_bar component", () => {
  beforeEach(() => {
    kpiSpy.mockReset();
  });

  it("renders exactly 5 stat cards in the fixed order", () => {
    stubKpi({
      slicesDone: 3,
      slicesTotal: 7,
      activeTasks: 2,
      pendingApproval: 0,
      failed24h: 0,
      tokens24h: 1_234,
      costCents24h: 42,
    });

    render(<MissionControlKpiBar projectId="p1" />);

    const ids = [
      "kpi-slices",
      "kpi-active-tasks",
      "kpi-pending-approval",
      "kpi-failed-24h",
      "kpi-tokens-cost",
    ];
    for (const id of ids) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }

    // The bar must not grow past 5 cards — parent slice.md is explicit.
    const bar = screen.getByTestId("mission-control-kpi-bar");
    // Each card is a direct grid child. Count them.
    expect(bar.children.length).toBe(5);
  });

  it("passes the route projectId through to useKpiData", () => {
    stubKpi();
    render(<MissionControlKpiBar projectId="proj-77" />);
    expect(kpiSpy).toHaveBeenCalledWith("proj-77");
  });

  it("empty project: shows `0 / 0`, zeros everywhere, and an empty progress bar", () => {
    stubKpi();
    render(<MissionControlKpiBar projectId="p1" />);

    expect(screen.getByTestId("kpi-slices-value").textContent).toBe("0 / 0");

    // Progress indicator must sit fully offscreen (translateX(-100%)).
    const progress = screen.getByTestId("kpi-slices-progress");
    const indicator = progress.querySelector<HTMLElement>(
      '[data-slot="progress-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.style.transform).toBe("translateX(-100%)");

    // Pending-approval and failed stay neutral tone when both are 0.
    expect(
      screen.getByTestId("kpi-pending-approval").getAttribute("data-tone"),
    ).toBe("neutral");
    expect(
      screen.getByTestId("kpi-failed-24h").getAttribute("data-tone"),
    ).toBe("neutral");
  });

  it("renders `slicesDone / slicesTotal` and a matching progress percentage", () => {
    stubKpi({ slicesDone: 3, slicesTotal: 4 });
    render(<MissionControlKpiBar projectId="p1" />);

    expect(screen.getByTestId("kpi-slices-value").textContent).toBe("3 / 4");

    const progress = screen.getByTestId("kpi-slices-progress");
    const indicator = progress.querySelector<HTMLElement>(
      '[data-slot="progress-indicator"]',
    );
    // 75% filled means the indicator is shifted left by 25%.
    expect(indicator!.style.transform).toBe("translateX(-25%)");
  });

  it("highlights the Pending-approval card amber when pendingApproval > 0", () => {
    stubKpi({ pendingApproval: 3 });
    render(<MissionControlKpiBar projectId="p1" />);

    const card = screen.getByTestId("kpi-pending-approval");
    expect(card.getAttribute("data-tone")).toBe("amber");
    expect(card.className).toMatch(/amber/);
  });

  it("does NOT highlight the Pending-approval card when it's exactly 0", () => {
    stubKpi({ pendingApproval: 0 });
    render(<MissionControlKpiBar projectId="p1" />);

    const card = screen.getByTestId("kpi-pending-approval");
    expect(card.getAttribute("data-tone")).toBe("neutral");
    expect(card.className).not.toMatch(/amber/);
  });

  it("renders Failed (24h) with destructive tone when > 0", () => {
    stubKpi({ failed24h: 4 });
    render(<MissionControlKpiBar projectId="p1" />);

    const card = screen.getByTestId("kpi-failed-24h");
    expect(card.getAttribute("data-tone")).toBe("destructive");
    expect(card.className).toMatch(/destructive/);
  });

  it("formats millions-of-tokens in the Tokens/$ card", () => {
    stubKpi({ tokens24h: 1_234_567, costCents24h: 4567 });
    render(<MissionControlKpiBar projectId="p1" />);

    // Token count as `1.2M` — not `1234567`, not scientific notation.
    expect(screen.getByText("1.2M")).toBeInTheDocument();
    // Cost in dollars.
    expect(screen.getByText("$45.67")).toBeInTheDocument();
  });

  it("renders the `<$0.01` sentinel when sub-cent cost is non-zero", () => {
    stubKpi({ tokens24h: 100, costCents24h: 0.3 });
    render(<MissionControlKpiBar projectId="p1" />);

    expect(screen.getByText("<$0.01")).toBeInTheDocument();
  });

  it("project-stats error: cards backed by stats show skeleton, Tokens card unaffected", () => {
    stubKpi({
      tokens24h: 500,
      costCents24h: 12,
      isLoading: {
        // Simulate the hook's contract: all stats-backed fields flip to
        // loading when the project-stats request is in flight / failing.
        slicesDone: true,
        slicesTotal: true,
        activeTasks: true,
        failed24h: true,
      },
    });
    render(<MissionControlKpiBar projectId="p1" />);

    // Slices/active/pending/failed cards all render a skeleton in place
    // of the value. Locating the skeleton elements is enough — we don't
    // inspect their dimensions.
    const slices = screen.getByTestId("kpi-slices");
    expect(slices.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    const active = screen.getByTestId("kpi-active-tasks");
    expect(active.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    const failed = screen.getByTestId("kpi-failed-24h");
    expect(failed.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    // Tokens card stays steady — its backing hook didn't fail.
    const tokens = screen.getByTestId("kpi-tokens-cost");
    expect(tokens.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(tokens.textContent).toContain("500");
  });

  it("usage error: only the Tokens card shows a skeleton", () => {
    stubKpi({
      slicesDone: 2,
      slicesTotal: 3,
      activeTasks: 1,
      pendingApproval: 0,
      failed24h: 0,
      isLoading: { tokens24h: true, costCents24h: true },
    });
    render(<MissionControlKpiBar projectId="p1" />);

    const tokens = screen.getByTestId("kpi-tokens-cost");
    expect(tokens.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    // Every other card renders its real value.
    expect(screen.getByTestId("kpi-slices-value").textContent).toBe("2 / 3");
    const active = screen.getByTestId("kpi-active-tasks");
    expect(active.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("View: null stat values render the `—` placeholder without crashing", () => {
    // The workspace view lacks per-workspace usage + progress hooks,
    // so it passes `null` on the fields it can't source today. The pure
    // view must collapse every null slot to the en-dash sentinel — zero
    // is a real datum and must NOT be shown in its place.
    render(
      <MissionControlKpiBarView
        slicesDone={null}
        slicesTotal={null}
        activeTasks={null}
        pendingApproval={null}
        failed24h={null}
        tokens24h={null}
        costCents24h={null}
        slicesLabel="Projects"
      />,
    );

    // First card: the `N / M` composite collapses to a single `—`.
    expect(screen.getByTestId("kpi-slices-value").textContent).toBe(
      KPI_NULL_PLACEHOLDER,
    );

    // Label override flows through: workspace view renames the first
    // card from "Slices" to "Projects".
    expect(screen.getByTestId("kpi-slices").textContent).toContain("Projects");

    // Active tasks + pending approval + failed (24h) — each of those
    // three cards owns a value slot that must render exactly the
    // sentinel. Restrict the lookup to each card's subtree so a stray
    // `—` from another card can't false-positive.
    for (const testId of [
      "kpi-active-tasks",
      "kpi-pending-approval",
      "kpi-failed-24h",
    ]) {
      const card = screen.getByTestId(testId);
      expect(card.textContent).toContain(KPI_NULL_PLACEHOLDER);
    }

    // Tone promotion sees `null` as "no data", not "positive" — so the
    // amber/destructive classes must stay off. That's the invariant
    // protecting the workspace view from lighting up tiles just because
    // data is missing.
    expect(
      screen.getByTestId("kpi-pending-approval").getAttribute("data-tone"),
    ).toBe("neutral");
    expect(
      screen.getByTestId("kpi-failed-24h").getAttribute("data-tone"),
    ).toBe("neutral");

    // Tokens/$ card: both the token slot and the cost subtitle collapse
    // to the same sentinel. formatKpiTokens + formatKpiCost are the
    // formatters that produce those strings, so we double-check their
    // null contract here too.
    expect(formatKpiTokens(null)).toBe(KPI_NULL_PLACEHOLDER);
    expect(formatKpiCost(null)).toBe(KPI_NULL_PLACEHOLDER);
    const tokensCard = screen.getByTestId("kpi-tokens-cost");
    // Value + subtitle both print the sentinel — the card should contain
    // at least two occurrences. (We match a slice rather than a regex
    // count so a future layout change doesn't accidentally drop one.)
    const matches = tokensCard.textContent?.split(KPI_NULL_PLACEHOLDER) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // N-1 dashes => N slices

    // Progress bar must be fully empty — null numerator/denominator
    // MUST NOT render an arbitrary percentage.
    const progress = screen.getByTestId("kpi-slices-progress");
    const indicator = progress.querySelector<HTMLElement>(
      '[data-slot="progress-indicator"]',
    );
    expect(indicator!.style.transform).toBe("translateX(-100%)");
  });

  it("re-renders when useKpiData returns fresh numbers (react-query invalidation path)", () => {
    // First render: a stale snapshot with zero active tasks.
    stubKpi({ activeTasks: 0 });
    const { rerender } = render(<MissionControlKpiBar projectId="p1" />);
    // StatCard renders numeric values as text — look inside the active-
    // tasks subtree to avoid matching "0"s elsewhere.
    const activeBefore = screen.getByTestId("kpi-active-tasks");
    expect(activeBefore.textContent).toContain("0");

    // Now a task starts running; react-query invalidates, useKpiData
    // returns a fresh snapshot. The component must reflect it on the
    // next render pass. (2s wall-clock is a property of react-query
    // refetch timing, not of the component — asserting the refresh
    // happens on rerender is the contract we actually own here.)
    stubKpi({ activeTasks: 3 });
    rerender(<MissionControlKpiBar projectId="p1" />);
    const activeAfter = screen.getByTestId("kpi-active-tasks");
    expect(activeAfter.textContent).toContain("3");
  });
});
