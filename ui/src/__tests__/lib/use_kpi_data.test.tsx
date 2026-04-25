import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Stub the three underlying hooks. The whole point of useKpiData is to
// stitch these three together — the test exists to pin that contract in
// place, so we replace them with deterministic factories and assert the
// derived numbers end-to-end.
const projectStatsSpy = vi.fn();
const attentionSpy = vi.fn();
const usageSpy = vi.fn();

vi.mock("@/lib/hooks/stats", () => ({
  useProjectStats: (...args: unknown[]) => projectStatsSpy(...args),
}));
vi.mock("@/lib/hooks/attention", () => ({
  useAttention: (...args: unknown[]) => attentionSpy(...args),
}));
vi.mock("@/lib/hooks/usage", () => ({
  useUsageSummary: (...args: unknown[]) => usageSpy(...args),
}));

// Must import AFTER vi.mock so the module resolves to the stubbed hooks.
import { useKpiData, type KpiData } from "@/lib/use-kpi-data";

type ProjectStatsPayload = {
  tasks: {
    total: number;
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    done: number;
    failed: number;
    timed_out: number;
    cancelled: number;
  };
  avg_task_duration_seconds: number | null;
  milestones: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  slices: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  usage: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
};

function emptyProjectStats(): ProjectStatsPayload {
  return {
    tasks: {
      total: 0,
      queued: 0,
      assigned: 0,
      running: 0,
      completed: 0,
      done: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
    },
    avg_task_duration_seconds: null,
    milestones: { total: 0, pending: 0, in_progress: 0, completed: 0, failed: 0 },
    slices: {
      total: 0,
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    },
    usage: { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0 },
  };
}

function stubProjectStats(
  overrides: Partial<ProjectStatsPayload> = {},
  extras: { isLoading?: boolean; error?: unknown } = {},
) {
  projectStatsSpy.mockReturnValue({
    data: { ...emptyProjectStats(), ...overrides },
    isLoading: extras.isLoading ?? false,
    error: extras.error ?? null,
  });
}

function stubAttention(
  items: Array<{ project_id: string | null }>,
  extras: { isLoading?: boolean; error?: unknown } = {},
) {
  attentionSpy.mockReturnValue({
    items,
    total: items.length,
    isLoading: extras.isLoading ?? false,
    error: extras.error ?? null,
    connectionState: "open",
  });
}

function stubUsage(
  overrides: Partial<{
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
  }> = {},
  extras: { isLoading?: boolean; error?: unknown } = {},
) {
  usageSpy.mockReturnValue({
    data: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_cost_usd: 0,
      record_count: 0,
      by_provider: {},
      by_model: {},
      ...overrides,
    },
    isLoading: extras.isLoading ?? false,
    error: extras.error ?? null,
  });
}

describe("use_kpi_data", () => {
  beforeEach(() => {
    projectStatsSpy.mockReset();
    attentionSpy.mockReset();
    usageSpy.mockReset();
  });

  it("returns all zeros for an empty project", () => {
    stubProjectStats();
    stubAttention([]);
    stubUsage();

    const { result } = renderHook(() => useKpiData("p1"));
    const kpi: KpiData = result.current;

    expect(kpi.slicesDone).toBe(0);
    expect(kpi.slicesTotal).toBe(0);
    expect(kpi.activeTasks).toBe(0);
    expect(kpi.pendingApproval).toBe(0);
    expect(kpi.failed24h).toBe(0);
    expect(kpi.tokens24h).toBe(0);
    expect(kpi.costCents24h).toBe(0);
  });

  it("derives slice + task counts from useProjectStats", () => {
    stubProjectStats({
      tasks: {
        total: 10,
        queued: 2,
        assigned: 1,
        running: 3,
        completed: 4,
        done: 4,
        failed: 5,
        timed_out: 0,
        cancelled: 0,
      },
      slices: {
        total: 7,
        pending: 2,
        active: 1,
        completed: 4,
        failed: 0,
        skipped: 0,
      },
    });
    stubAttention([]);
    stubUsage();

    const { result } = renderHook(() => useKpiData("p1"));

    expect(result.current.slicesDone).toBe(4);
    expect(result.current.slicesTotal).toBe(7);
    // running (3) + assigned (1) — queued is deliberately excluded.
    expect(result.current.activeTasks).toBe(4);
    expect(result.current.failed24h).toBe(5);
  });

  it("only counts attention rows that belong to this project", () => {
    stubProjectStats();
    stubAttention([
      { project_id: "p1" },
      { project_id: "p1" },
      { project_id: "p2" },
      { project_id: null }, // workspace-level chat — must not count
    ]);
    stubUsage();

    const { result } = renderHook(() => useKpiData("p1"));
    expect(result.current.pendingApproval).toBe(2);
  });

  it("sums input + output tokens and converts USD to integer cents", () => {
    stubProjectStats();
    stubAttention([]);
    stubUsage({
      total_input_tokens: 1200,
      total_output_tokens: 800,
      // 0.1 + 0.2 style float noise — the hook must round, not truncate.
      total_cost_usd: 0.1 + 0.2,
    });

    const { result } = renderHook(() => useKpiData("p1"));
    expect(result.current.tokens24h).toBe(2000);
    expect(result.current.costCents24h).toBe(30);
  });

  it("forwards the period argument to useUsageSummary (default = 24h)", () => {
    stubProjectStats();
    stubAttention([]);
    stubUsage();

    renderHook(() => useKpiData("p1"));
    expect(usageSpy).toHaveBeenCalledWith({
      project_id: "p1",
      period: "24h",
    });

    usageSpy.mockClear();
    stubUsage();

    renderHook(() => useKpiData("p1", "7d"));
    expect(usageSpy).toHaveBeenCalledWith({
      project_id: "p1",
      period: "7d",
    });
  });

  it("surfaces per-field isLoading and error without collapsing siblings", () => {
    const boom = new Error("usage fetch failed");
    stubProjectStats({}, { isLoading: true });
    stubAttention([], { isLoading: false, error: null });
    stubUsage({}, { isLoading: false, error: boom });

    const { result } = renderHook(() => useKpiData("p1"));

    // project-stats-backed fields should all report loading …
    expect(result.current.isLoading.slicesDone).toBe(true);
    expect(result.current.isLoading.slicesTotal).toBe(true);
    expect(result.current.isLoading.activeTasks).toBe(true);
    expect(result.current.isLoading.failed24h).toBe(true);
    // … while unrelated upstreams stay steady.
    expect(result.current.isLoading.pendingApproval).toBe(false);
    expect(result.current.isLoading.tokens24h).toBe(false);
    expect(result.current.isLoading.costCents24h).toBe(false);

    // Usage failure is only visible on usage-backed fields.
    expect(result.current.error.tokens24h).toBe(boom);
    expect(result.current.error.costCents24h).toBe(boom);
    expect(result.current.error.slicesDone).toBeNull();
    expect(result.current.error.pendingApproval).toBeNull();
  });

  it("tolerates a completely missing project-stats payload", () => {
    // React Query reports `data: undefined` before the first fetch lands.
    // The aggregator must not crash; every field must fall back to 0.
    projectStatsSpy.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    stubAttention([]);
    stubUsage();

    const { result } = renderHook(() => useKpiData("p1"));
    expect(result.current.slicesDone).toBe(0);
    expect(result.current.slicesTotal).toBe(0);
    expect(result.current.activeTasks).toBe(0);
    expect(result.current.failed24h).toBe(0);
  });
});
