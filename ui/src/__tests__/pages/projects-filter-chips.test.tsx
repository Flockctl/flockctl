import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  FilterChips,
  FILTER_ALL,
  FILTER_STANDALONE,
  type FilterChipsWorkspace,
} from "@/pages/projects-components/FilterChips";

/**
 * Contract tests for {@link FilterChips} (slice 23-02 T03).
 *
 * Each spec covers exactly one promise from the slice:
 *
 *   - Chip row layout: `All <total>`, one chip per workspace, then
 *     `Standalone <count>` — in that order.
 *   - Default filter is `'all'` when the URL has no `?filter=`.
 *   - URL `?filter=` is the single source of truth (replace-not-push,
 *     and the canonical `all` state strips the param).
 *   - Active chip styling: `bg-zinc-200 dark:bg-zinc-800 font-medium`.
 *   - Group-by dropdown placeholder reads `By workspace ▾`.
 *   - Invalid `?filter=xxx` falls back to `'all'` + `console.warn`.
 *
 * Negative tests (per task spec):
 *   - filter-chips.test.tsx::Standalone chip filters to standalone-only.
 *   - filter-chips.test.tsx::clicking same chip twice keeps All
 *     selected (no deselect).
 */

// --- Router probe ------------------------------------------------------------
type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

function renderWithRouter(initial: string, ui: ReactNode) {
  const probe: { current: Probe } = {
    current: { pathname: "", search: "" },
  };
  render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <LocationProbe onLocation={(p) => (probe.current = p)} />
    </MemoryRouter>,
  );
  return probe;
}

// --- Standalone-filter harness ----------------------------------------------
// FilterChips is intentionally presentational — it does not own the project
// list. The "Standalone chip filters to standalone-only" negative test wires
// the same end-to-end shape the page uses: chip click → onFilterChange →
// parent partitions projects → render reflects the partition.

interface TestProject {
  id: string;
  workspace_slug: string | null;
  name: string;
}

function FilterHarness({
  totalCount,
  standaloneCount,
  workspaces,
  rows,
}: {
  totalCount: number;
  standaloneCount: number;
  workspaces: FilterChipsWorkspace[];
  rows: TestProject[];
}) {
  const [filter, setFilter] = useState<string>(FILTER_ALL);
  const visible = rows.filter((r) => {
    if (filter === FILTER_ALL) return true;
    if (filter === FILTER_STANDALONE) return r.workspace_slug === null;
    return r.workspace_slug === filter;
  });
  return (
    <>
      <FilterChips
        totalCount={totalCount}
        standaloneCount={standaloneCount}
        workspaces={workspaces}
        onFilterChange={setFilter}
      />
      <ul data-testid="harness-results">
        {visible.map((p) => (
          <li key={p.id} data-testid={`row-${p.id}`}>
            {p.name}
          </li>
        ))}
      </ul>
    </>
  );
}

const SAMPLE_WORKSPACES: FilterChipsWorkspace[] = [
  { id: "ws-1", name: "work", slug: "work", count: 5 },
  { id: "ws-2", name: "personal", slug: "personal", count: 4 },
  { id: "ws-3", name: "opensource", slug: "opensource", count: 3 },
];

describe("FilterChips — chip row", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Most specs don't expect warnings; tests that DO want them assert
    // explicitly. Spy is restored in afterEach so leakage doesn't cascade.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("renders All <total>, one chip per workspace, then Standalone <count> — in that order", () => {
    renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );

    // The order matters: prototype lines 426–437 pin "All", workspaces,
    // "Standalone". Read the buttons via the testids the component
    // assigns and assert document order.
    const all = screen.getByTestId("filter-chip-all");
    const work = screen.getByTestId("filter-chip-work");
    const personal = screen.getByTestId("filter-chip-personal");
    const opensource = screen.getByTestId("filter-chip-opensource");
    const standalone = screen.getByTestId("filter-chip-standalone");

    expect(all.textContent).toBe("All 12");
    expect(work.textContent).toBe("work 5");
    expect(personal.textContent).toBe("personal 4");
    expect(opensource.textContent).toBe("opensource 3");
    expect(standalone.textContent).toBe("Standalone 3");

    const all4 = all.compareDocumentPosition(work);
    const work4 = work.compareDocumentPosition(personal);
    const personal4 = personal.compareDocumentPosition(opensource);
    const open4 = opensource.compareDocumentPosition(standalone);
    // DOCUMENT_POSITION_FOLLOWING bit (0x04) — left node precedes right.
    expect(all4 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(work4 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(personal4 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(open4 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the 'Filter:' label and the group-by dropdown placeholder", () => {
    renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={0}
        standaloneCount={0}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    expect(screen.getByText("Filter:")).toBeInTheDocument();
    const groupBy = screen.getByTestId("projects-group-by");
    expect(groupBy.textContent).toContain("By workspace");
    // The pill carries the down-chevron glyph as a future-mode affordance.
    expect(groupBy.textContent).toContain("▾");
    // It's a placeholder until other modes ship — don't let it submit a
    // form or fire navigation.
    expect(groupBy).toBeDisabled();
  });

  it("defaults to All when the URL has no ?filter=", () => {
    renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("filter-chip-work")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("filter-chip-standalone")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("active chip carries bg-zinc-200 dark:bg-zinc-800 font-medium classes", () => {
    renderWithRouter(
      "/projects?filter=work",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    const work = screen.getByTestId("filter-chip-work");
    expect(work).toHaveAttribute("aria-pressed", "true");
    for (const cls of ["bg-zinc-200", "dark:bg-zinc-800", "font-medium"]) {
      expect(work.className).toContain(cls);
    }
    // Inactive chip carries the hover-only inactive classes — explicitly
    // does NOT carry the active background.
    const all = screen.getByTestId("filter-chip-all");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(all.className).not.toContain("bg-zinc-200");
    for (const cls of [
      "hover:bg-zinc-100",
      "dark:hover:bg-zinc-800",
      "text-zinc-600",
    ]) {
      expect(all.className).toContain(cls);
    }
  });

  it("activates the workspace chip when URL holds ?filter=<slug>", () => {
    renderWithRouter(
      "/projects?filter=personal",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    expect(screen.getByTestId("filter-chip-personal")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("activates the standalone chip when URL holds ?filter=standalone", () => {
    renderWithRouter(
      "/projects?filter=standalone",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    expect(screen.getByTestId("filter-chip-standalone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking a workspace chip writes ?filter=<slug> to URL and emits onFilterChange", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();

    const probe = renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
        onFilterChange={onFilterChange}
      />,
    );

    // Mount fires the synthetic "all" emission once — clear it so the
    // assertion on the click event isn't ambiguous.
    onFilterChange.mockClear();

    await user.click(screen.getByTestId("filter-chip-work"));

    expect(probe.current.search).toContain("filter=work");
    expect(onFilterChange).toHaveBeenLastCalledWith("work");
    expect(screen.getByTestId("filter-chip-work")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking the All chip from a workspace filter strips ?filter= from URL", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/projects?filter=work",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );
    expect(probe.current.search).toContain("filter=work");

    await user.click(screen.getByTestId("filter-chip-all"));

    // Canonical "All" state is encoded as the param being absent.
    expect(probe.current.search).not.toContain("filter=");
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preserves unrelated query params when toggling a chip", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/projects?q=site",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );

    await user.click(screen.getByTestId("filter-chip-personal"));

    expect(probe.current.search).toContain("filter=personal");
    expect(probe.current.search).toContain("q=site");
  });

  it("falls back to 'all' + console.warn when ?filter= is unknown", async () => {
    // The component spy in beforeEach already swallows warnings; capture
    // the call here so we can assert on it.
    renderWithRouter(
      "/projects?filter=ghost-workspace",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );

    // Active chip is All — never the unknown value.
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Warning surfaces forensics for the rejected value. We assert on
    // substring rather than exact text so the message can be reworded
    // without fragile test failures.
    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(warnArgs).toContain("ghost-workspace");
    expect(warnArgs).toContain("all");
  });

  // Negative test (per task spec): Standalone chip filters to standalone-only.
  it("Standalone chip filters to standalone-only", async () => {
    const user = userEvent.setup();
    const rows: TestProject[] = [
      { id: "p1", workspace_slug: "work", name: "alpha" },
      { id: "p2", workspace_slug: "personal", name: "bravo" },
      { id: "p3", workspace_slug: null, name: "charlie" },
      { id: "p4", workspace_slug: null, name: "delta" },
    ];

    renderWithRouter(
      "/projects",
      <FilterHarness
        totalCount={4}
        standaloneCount={2}
        workspaces={SAMPLE_WORKSPACES}
        rows={rows}
      />,
    );

    // All four rows up front (default = all).
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(4);

    await user.click(screen.getByTestId("filter-chip-standalone"));

    // Only the standalone projects survive the partition.
    const visible = screen.getAllByTestId(/^row-/);
    expect(visible.map((el) => el.getAttribute("data-testid"))).toEqual([
      "row-p3",
      "row-p4",
    ]);
    // And — critically — no workspace project leaks through.
    expect(screen.queryByTestId("row-p1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-p2")).not.toBeInTheDocument();
  });

  // Negative test (per task spec): clicking same chip twice keeps All
  // selected (no deselect).
  it("clicking the All chip twice keeps All selected (no deselect)", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();

    const probe = renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
        onFilterChange={onFilterChange}
      />,
    );

    // Sanity: starts at All with no ?filter= in the URL.
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("filter=");

    // First click — already active. Should be a no-op for state.
    await user.click(screen.getByTestId("filter-chip-all"));
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("filter=");

    // Second click — still no-op. The chip must not flip to a "no
    // selection" state; All stays the canonical default.
    await user.click(screen.getByTestId("filter-chip-all"));
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("filter=");

    // Other chips remain inactive throughout.
    expect(screen.getByTestId("filter-chip-work")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("filter-chip-standalone")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking the same workspace chip twice keeps it selected (no deselect)", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
      />,
    );

    await user.click(screen.getByTestId("filter-chip-work"));
    expect(screen.getByTestId("filter-chip-work")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).toContain("filter=work");

    // Click again — chip stays active, URL stays at filter=work. No
    // toggle to All, no clearing the param.
    await user.click(screen.getByTestId("filter-chip-work"));
    expect(screen.getByTestId("filter-chip-work")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).toContain("filter=work");
  });

  it("renders chips in the order the parent supplies workspaces", () => {
    const reordered: FilterChipsWorkspace[] = [
      { id: "ws-3", name: "opensource", slug: "opensource", count: 3 },
      { id: "ws-1", name: "work", slug: "work", count: 5 },
      { id: "ws-2", name: "personal", slug: "personal", count: 4 },
    ];
    renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={reordered}
      />,
    );
    const opensource = screen.getByTestId("filter-chip-opensource");
    const work = screen.getByTestId("filter-chip-work");
    const personal = screen.getByTestId("filter-chip-personal");

    expect(
      opensource.compareDocumentPosition(work) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      work.compareDocumentPosition(personal) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("handles zero workspaces — only All and Standalone chips render", () => {
    renderWithRouter(
      "/projects",
      <FilterChips totalCount={3} standaloneCount={3} workspaces={[]} />,
    );
    expect(screen.getByTestId("filter-chip-all")).toBeInTheDocument();
    expect(screen.getByTestId("filter-chip-standalone")).toBeInTheDocument();
    // No workspace chips rendered between them.
    expect(screen.queryByTestId(/filter-chip-(?!all$|standalone$).+/)).toBeNull();
  });

  it("emits onFilterChange exactly once per filter change (not on every render)", async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();

    renderWithRouter(
      "/projects",
      <FilterChips
        totalCount={12}
        standaloneCount={3}
        workspaces={SAMPLE_WORKSPACES}
        onFilterChange={onFilterChange}
      />,
    );

    // Mount fires the synthetic initial emission once.
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenLastCalledWith(FILTER_ALL);

    // First click triggers a real change — emit.
    await user.click(screen.getByTestId("filter-chip-personal"));
    expect(onFilterChange).toHaveBeenCalledTimes(2);
    expect(onFilterChange).toHaveBeenLastCalledWith("personal");

    // Re-clicking the SAME chip — value is unchanged, no re-emit.
    await user.click(screen.getByTestId("filter-chip-personal"));
    expect(onFilterChange).toHaveBeenCalledTimes(2);
  });

  it("warns at most once for the same invalid value (no per-render spam)", async () => {
    // Render with an invalid value and force a re-render via a parent
    // state bump. The warning should fire once; subsequent renders for
    // the same `?filter=` value must stay silent.
    const Harness = () => {
      const [_, setTick] = useState(0);
      return (
        <>
          <FilterChips
            totalCount={12}
            standaloneCount={3}
            workspaces={SAMPLE_WORKSPACES}
          />
          <button
            type="button"
            data-testid="bump"
            onClick={() => setTick((t) => t + 1)}
          />
        </>
      );
    };

    const user = userEvent.setup();
    renderWithRouter("/projects?filter=ghost", <Harness />);

    // First mount — exactly one warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("bump"));
    await user.click(screen.getByTestId("bump"));
    await act(async () => {});

    // Re-renders with the same invalid value don't re-warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
