import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { MilestoneKanban } from "@/pages/project-detail-components/MilestoneKanban";
import type {
  PlanSliceTree,
  PlanTask,
  PlanTaskStatus,
  SliceStatus,
} from "@/lib/types/plan";

/**
 * Contract tests for {@link MilestoneKanban} (slice 23-00 T03).
 *
 * The kanban renders three columns — Pending / Active / Completed —
 * each as a `<FlatCard>` with a sticky header (label + count chip) and
 * a scrollable body of `<SliceCard>` instances.
 *
 * These tests pin:
 *   - The 3 column labels (uppercase) and per-column count chips.
 *   - The slice → column mapping for every `SliceStatus` enum value
 *     (pending, planning, active, verifying, merging, completed,
 *     skipped, failed). Negative tests:
 *       - "abandoned" (=skipped) slice not shown anywhere.
 *       - "blocked" (=failed) slice shown in Pending with a Lock icon.
 *   - Empty column → "No slices" placeholder text.
 *   - 50-slice column → wrapped in a vertically-scrollable body
 *     (`overflow-y-auto`), not the page itself.
 *   - Click on a slice card → `onSelectSlice(sliceId)` fired.
 *   - Unknown status → console.warn + slice falls into Pending.
 */

function makeTask(id: string, status: PlanTaskStatus): PlanTask {
  return {
    id,
    slice_id: "slice-1",
    title: `Task ${id}`,
    description: null,
    model: null,
    status,
    estimate: null,
    files: null,
    verify: null,
    inputs: null,
    expected_output: null,
    task_id: null,
    order_index: 0,
    output: null,
    summary: null,
    verification_passed: null,
    verification_output: null,
    created_at: "2026-05-07T00:00:00Z",
    updated_at: "2026-05-07T00:00:00Z",
  };
}

function makeSlice(overrides: Partial<PlanSliceTree> = {}): PlanSliceTree {
  return {
    id: "slice-1",
    milestone_id: "ms-1",
    title: "A slice",
    description: null,
    status: "pending" as SliceStatus,
    risk: "low",
    depends: null,
    demo: null,
    goal: null,
    success_criteria: null,
    proof_level: null,
    threat_surface: null,
    order_index: 0,
    created_at: "2026-05-07T00:00:00Z",
    updated_at: "2026-05-07T00:00:00Z",
    tasks: [],
    ...overrides,
  };
}

describe("MilestoneKanban / column structure", () => {
  it("renders 3 columns labelled PENDING / ACTIVE / COMPLETED", () => {
    render(<MilestoneKanban milestoneTitle="ms" slices={[]} />);

    expect(screen.getByTestId("milestone-kanban")).toBeTruthy();
    expect(
      screen.getByTestId("milestone-kanban-column-pending"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("milestone-kanban-column-active"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("milestone-kanban-column-completed"),
    ).toBeTruthy();

    expect(
      screen.getByTestId("milestone-kanban-column-label-pending").textContent,
    ).toBe("Pending");
    expect(
      screen.getByTestId("milestone-kanban-column-label-active").textContent,
    ).toBe("Active");
    expect(
      screen.getByTestId("milestone-kanban-column-label-completed").textContent,
    ).toBe("Completed");
  });

  it("each column header is sticky and uppercase / tracking-wider", () => {
    render(<MilestoneKanban milestoneTitle="ms" slices={[]} />);
    const label = screen.getByTestId("milestone-kanban-column-label-pending");
    // uppercase + tracking-wider (per design spec for column labels).
    expect(label.className).toContain("uppercase");
    expect(label.className).toContain("tracking-wider");
    expect(label.className).toContain("text-[11px]");
    expect(label.className).toContain("text-zinc-500");

    // The header row itself is sticky so it stays visible while the
    // body scrolls.
    const header = screen.getByTestId("milestone-kanban-column-pending");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
  });

  it("count chip reports per-column slice counts", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({ id: "p1", status: "pending" }),
          makeSlice({ id: "p2", status: "planning" }),
          makeSlice({ id: "a1", status: "active" }),
          makeSlice({ id: "c1", status: "completed" }),
          makeSlice({ id: "c2", status: "completed" }),
          makeSlice({ id: "c3", status: "completed" }),
        ]}
      />,
    );

    expect(
      screen.getByTestId("milestone-kanban-column-count-pending").textContent,
    ).toBe("2");
    expect(
      screen.getByTestId("milestone-kanban-column-count-active").textContent,
    ).toBe("1");
    expect(
      screen.getByTestId("milestone-kanban-column-count-completed").textContent,
    ).toBe("3");
  });
});

describe("MilestoneKanban / slice → column mapping", () => {
  const cases: Array<[SliceStatus, "pending" | "active" | "completed"]> = [
    ["pending", "pending"],
    ["planning", "pending"],
    ["active", "active"],
    ["verifying", "active"],
    ["merging", "active"],
    ["completed", "completed"],
    // failed → "blocked" → Pending column (with Lock icon, asserted below).
    ["failed", "pending"],
  ];

  for (const [status, columnId] of cases) {
    it(`status=${status} → column=${columnId}`, () => {
      render(
        <MilestoneKanban
          milestoneTitle="ms"
          slices={[makeSlice({ id: `slice-${status}`, status })]}
        />,
      );
      const body = screen.getByTestId(
        `milestone-kanban-column-body-${columnId}`,
      );
      expect(
        within(body).getByTestId("slice-card").getAttribute("data-slice-id"),
      ).toBe(`slice-${status}`);
    });
  }

  it("skipped slice (=abandoned) is filtered out of every column", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({ id: "s1", status: "skipped" }),
          makeSlice({ id: "p1", status: "pending" }),
        ]}
      />,
    );
    expect(screen.queryByTestId("slice-card")?.getAttribute("data-slice-id")).toBe(
      "p1",
    );
    expect(
      screen.queryAllByTestId("slice-card").map((el) => el.getAttribute("data-slice-id")),
    ).toEqual(["p1"]);
    // count chips reflect the filtered slice
    expect(
      screen.getByTestId("milestone-kanban-column-count-pending").textContent,
    ).toBe("1");
    expect(
      screen.getByTestId("milestone-kanban-column-count-completed").textContent,
    ).toBe("0");
  });

  it("failed slice (=blocked) shows the Lock icon next to its card in the Pending column", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[makeSlice({ id: "blocked-1", status: "failed" })]}
      />,
    );
    const lock = screen.getByTestId("milestone-kanban-blocked-lock-blocked-1");
    expect(lock).toBeTruthy();
    // The lock lives inside the Pending column body, alongside the slice card.
    const pendingBody = screen.getByTestId("milestone-kanban-column-body-pending");
    expect(pendingBody.contains(lock)).toBe(true);
    // The wrapper carries data-blocked="true" so the parent can style the row.
    const wrapper = pendingBody.querySelector(
      '[data-testid="milestone-kanban-slice-wrapper"][data-slice-id="blocked-1"]',
    );
    expect(wrapper?.getAttribute("data-blocked")).toBe("true");
  });

  it("non-blocked slices in Pending do NOT render a Lock icon", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[makeSlice({ id: "ok", status: "pending" })]}
      />,
    );
    expect(screen.queryByTestId("milestone-kanban-blocked-lock-ok")).toBeNull();
  });
});

describe("MilestoneKanban / empty column placeholder", () => {
  it("shows 'No slices' placeholder for every empty column when slices=[]", () => {
    render(<MilestoneKanban milestoneTitle="ms" slices={[]} />);

    for (const col of ["pending", "active", "completed"] as const) {
      const empty = screen.getByTestId(`milestone-kanban-column-empty-${col}`);
      expect(empty.textContent).toBe("No slices");
      expect(empty.className).toContain("text-zinc-500");
      expect(empty.className).toContain("text-[12px]");
      expect(empty.className).toContain("place-items-center");
      expect(empty.className).toContain("min-h-[120px]");
    }
  });

  it("removes the placeholder once a slice is added to the column", () => {
    const { rerender } = render(
      <MilestoneKanban milestoneTitle="ms" slices={[]} />,
    );
    expect(
      screen.getByTestId("milestone-kanban-column-empty-pending"),
    ).toBeTruthy();

    rerender(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[makeSlice({ id: "p1", status: "pending" })]}
      />,
    );
    expect(
      screen.queryByTestId("milestone-kanban-column-empty-pending"),
    ).toBeNull();
    // Empty placeholder still present in the still-empty columns.
    expect(
      screen.getByTestId("milestone-kanban-column-empty-active"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("milestone-kanban-column-empty-completed"),
    ).toBeTruthy();
  });
});

describe("MilestoneKanban / scrolling body (50-slice corner case)", () => {
  it("a column with 50 slices is wrapped in an overflow-y-auto body", () => {
    const fifty: PlanSliceTree[] = Array.from({ length: 50 }, (_, i) =>
      makeSlice({ id: `pending-${i}`, status: "pending" }),
    );
    render(<MilestoneKanban milestoneTitle="ms" slices={fifty} />);

    const body = screen.getByTestId("milestone-kanban-column-body-pending");
    expect(body.className).toContain("overflow-y-auto");

    // Count chip reports the full count.
    expect(
      screen.getByTestId("milestone-kanban-column-count-pending").textContent,
    ).toBe("50");

    // All 50 slice cards rendered in that body.
    const cards = within(body).getAllByTestId("slice-card");
    expect(cards.length).toBe(50);
  });
});

describe("MilestoneKanban / interaction", () => {
  it("clicking a slice card invokes onSelectSlice with the slice id", () => {
    const onSelect = vi.fn();
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({ id: "alpha", status: "active", title: "Alpha" }),
        ]}
        onSelectSlice={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("slice-card"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("alpha");
  });

  it("propagates activeSliceId to the matching SliceCard's data-selected", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({ id: "a", status: "active" }),
          makeSlice({ id: "b", status: "active" }),
        ]}
        activeSliceId="b"
      />,
    );
    const cards = screen.getAllByTestId("slice-card");
    const a = cards.find((c) => c.getAttribute("data-slice-id") === "a")!;
    const b = cards.find((c) => c.getAttribute("data-slice-id") === "b")!;
    expect(a.getAttribute("data-selected")).toBe("false");
    expect(b.getAttribute("data-selected")).toBe("true");
  });

  it("forwards milestoneTitle to every SliceCard breadcrumb", () => {
    render(
      <MilestoneKanban
        milestoneTitle="Milestone 09 — Mission control"
        slices={[
          makeSlice({ id: "p1", status: "pending" }),
          makeSlice({ id: "a1", status: "active" }),
        ]}
      />,
    );
    const crumbs = screen.getAllByTestId("slice-card-breadcrumb");
    expect(crumbs.length).toBe(2);
    for (const crumb of crumbs) {
      expect(crumb.textContent).toBe("Milestone 09 — Mission control");
    }
  });

  it("forwards prioritiesBySliceId so each card renders its priority pill", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({ id: "hi", status: "pending" }),
          makeSlice({ id: "lo", status: "active" }),
        ]}
        prioritiesBySliceId={{ hi: "high", lo: "low" }}
      />,
    );
    const pills = screen.getAllByTestId("slice-card-priority");
    const byPriority = Object.fromEntries(
      pills.map((p) => [p.getAttribute("data-priority"), p.getAttribute("data-tone")]),
    );
    expect(byPriority).toEqual({ high: "danger", low: "neutral" });
  });

  it("renders SliceCard task counts based on the slice's tasks array", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          makeSlice({
            id: "with-tasks",
            status: "active",
            tasks: [
              makeTask("t1", "completed"),
              makeTask("t2", "completed"),
              makeTask("t3", "pending"),
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("slice-card-task-count").textContent).toBe("2/3");
  });
});

describe("MilestoneKanban / forward-compat for unknown statuses", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("an unknown status renders in Pending and emits a console.warn", () => {
    render(
      <MilestoneKanban
        milestoneTitle="ms"
        slices={[
          // Cast through unknown — we deliberately exercise the
          // forward-compat branch that the failure_modes rule requires.
          makeSlice({ id: "x", status: "future-status" as unknown as SliceStatus }),
        ]}
      />,
    );

    const pendingBody = screen.getByTestId(
      "milestone-kanban-column-body-pending",
    );
    expect(
      within(pendingBody).getByTestId("slice-card").getAttribute("data-slice-id"),
    ).toBe("x");
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("future-status");
  });
});
