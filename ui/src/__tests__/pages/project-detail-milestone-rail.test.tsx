import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";

import { MilestoneRail } from "@/pages/project-detail-components/MilestoneRail";
import type { MilestoneTree } from "@/lib/types";

/**
 * Contract tests for {@link MilestoneRail} (slice 23-00 T04).
 *
 * Pins:
 *   - Vertical list of one button per milestone, in caller order.
 *   - Each row: chevron (decorative) + optional CheckCircle (when
 *     `status === "completed"`) + truncated title with `title=` attr
 *     for hover-discovery.
 *   - Active milestone is visually distinct via `bg-zinc-100`
 *     (dark variant `dark:bg-zinc-800`) + `aria-current="true"`.
 *   - Click → fires `onSelectMilestone(id)`.
 *   - Selection round-trips through the URL `?milestone=` param when
 *     wired via a parent that uses `useSearchParams` — a tab switch
 *     therefore preserves the active milestone.
 *
 * Negative tests called out in the slice spec:
 *   - milestone-rail.test.tsx::clicking inactive milestone updates
 *     active state + URL.
 *   - milestone-rail.test.tsx::milestone title 80 chars truncates
 *     with title attr.
 */

// --- helpers -----------------------------------------------------------------

function makeMilestone(overrides: Partial<MilestoneTree> = {}): MilestoneTree {
  return {
    id: "ms-foundation",
    project_id: "p-flockctl",
    title: "Foundation",
    description: null,
    status: "pending",
    vision: null,
    success_criteria: null,
    depends_on: null,
    order_index: 0,
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    slices: [],
    ...overrides,
  };
}

function URLProbe({
  onUrl,
}: {
  onUrl: (search: string, milestone: string) => void;
}) {
  const location = useLocation();
  const [params] = useSearchParams();
  const search = location.search;
  const milestone = params.get("milestone") ?? "";
  onUrl(search, milestone);
  return null;
}

function renderWithRouter(
  ui: ReactNode,
  { initialUrl = "/projects/p1" }: { initialUrl?: string } = {},
) {
  let lastSearch = "";
  let lastMilestone = "";
  const probe = (search: string, milestone: string) => {
    lastSearch = search;
    lastMilestone = milestone;
  };
  const utils = render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route
          path="/projects/:projectId"
          element={
            <>
              {ui}
              <URLProbe onUrl={probe} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return {
    ...utils,
    getSearch: () => lastSearch,
    getMilestoneParam: () => lastMilestone,
  };
}

/**
 * Thin host that mirrors how the project-detail page wires the rail to
 * `?milestone=` via `useSearchParams`. Used by the URL-persistence tests
 * to demonstrate that the rail itself stays prop-driven while the
 * surrounding app drives the URL.
 */
function URLBackedRail({ milestones }: { milestones: MilestoneTree[] }) {
  const [params, setParams] = useSearchParams();
  const active = params.get("milestone");
  return (
    <MilestoneRail
      milestones={milestones}
      activeMilestoneId={active}
      onSelectMilestone={(id) => {
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("milestone", id);
            return next;
          },
          { replace: true },
        );
      }}
    />
  );
}

/**
 * Thin host that simulates the project-detail tabs by additionally
 * carrying a `?tab=` param. Lets us prove that flipping tabs does NOT
 * disturb the active milestone — the slice spec's "persists across
 * tab switches" pin.
 */
function TabbedHost({ milestones }: { milestones: MilestoneTree[] }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "plan";
  return (
    <>
      <button
        type="button"
        data-testid="tab-runs"
        onClick={() =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set("tab", "runs");
              return next;
            },
            { replace: true },
          )
        }
      >
        Runs
      </button>
      <span data-testid="tab-current">{tab}</span>
      <URLBackedRail milestones={milestones} />
    </>
  );
}

// --- tests -------------------------------------------------------------------

describe("MilestoneRail — vertical list", () => {
  it("renders one button per milestone, in caller-supplied order", () => {
    renderWithRouter(
      <MilestoneRail
        milestones={[
          makeMilestone({ id: "ms-a", title: "Foundation" }),
          makeMilestone({ id: "ms-b", title: "Host checks" }),
          makeMilestone({ id: "ms-c", title: "Container checks" }),
        ]}
      />,
    );
    const items = screen.getAllByTestId("milestone-rail-item");
    expect(items).toHaveLength(3);
    expect(items.map((b) => b.getAttribute("data-milestone-id"))).toEqual([
      "ms-a",
      "ms-b",
      "ms-c",
    ]);
    expect(items.map((b) => b.textContent?.trim())).toEqual([
      "Foundation",
      "Host checks",
      "Container checks",
    ]);
  });

  it("buttons are type='button' so they don't submit a parent form", () => {
    renderWithRouter(
      <MilestoneRail milestones={[makeMilestone({ id: "ms-a" })]} />,
    );
    const item = screen.getByTestId("milestone-rail-item");
    expect(item.getAttribute("type")).toBe("button");
  });

  it("renders an empty rail (no items, distinct testid) when milestones=[]", () => {
    renderWithRouter(<MilestoneRail milestones={[]} />);
    expect(screen.queryByTestId("milestone-rail")).toBeNull();
    expect(screen.getByTestId("milestone-rail-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("milestone-rail-item")).toBeNull();
  });

  it("nav has aria-label='Milestones' for screen readers", () => {
    renderWithRouter(
      <MilestoneRail milestones={[makeMilestone({ id: "ms-a" })]} />,
    );
    const nav = screen.getByRole("navigation", { name: "Milestones" });
    expect(nav).toBeInTheDocument();
  });
});

describe("MilestoneRail — active highlighting", () => {
  it("active milestone gets bg-zinc-100 dark:bg-zinc-800 + aria-current=true", () => {
    renderWithRouter(
      <MilestoneRail
        milestones={[
          makeMilestone({ id: "ms-a", title: "Foundation" }),
          makeMilestone({ id: "ms-b", title: "Host checks" }),
        ]}
        activeMilestoneId="ms-a"
      />,
    );

    const active = screen.getByTitle("Foundation");
    expect(active.className).toContain("bg-zinc-100");
    expect(active.className).toContain("dark:bg-zinc-800");
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(active.getAttribute("data-active")).toBe("true");

    const idle = screen.getByTitle("Host checks");
    expect(idle.getAttribute("aria-current")).toBeNull();
    expect(idle.getAttribute("data-active")).toBeNull();
    // Idle row carries the hover variant only — the active classes
    // are conditional on `isActive`.
    expect(idle.className).toContain("hover:bg-zinc-100");
    expect(idle.className).toContain("dark:hover:bg-zinc-800");
  });

  it("renders no active row when activeMilestoneId is null/undefined", () => {
    renderWithRouter(
      <MilestoneRail
        milestones={[makeMilestone({ id: "ms-a", title: "Foundation" })]}
        activeMilestoneId={null}
      />,
    );
    const item = screen.getByTestId("milestone-rail-item");
    expect(item.getAttribute("aria-current")).toBeNull();
  });
});

describe("MilestoneRail — row anatomy", () => {
  it("every row carries the decorative chevron (aria-hidden, text-zinc-400)", () => {
    const { container } = renderWithRouter(
      <MilestoneRail
        milestones={[makeMilestone({ id: "ms-a", title: "Foundation" })]}
      />,
    );
    const chevrons = container.querySelectorAll(
      'svg.text-zinc-400[aria-hidden="true"]',
    );
    expect(chevrons.length).toBe(1);
  });

  it("renders CheckCircle in emerald-500 only when status='completed'", () => {
    renderWithRouter(
      <MilestoneRail
        milestones={[
          makeMilestone({ id: "ms-a", title: "Done", status: "completed" }),
          makeMilestone({ id: "ms-b", title: "Planning", status: "pending" }),
        ]}
      />,
    );
    const completed = screen.getByTestId("milestone-rail-item-ms-a-completed");
    expect(completed).toBeInTheDocument();
    expect(completed.classList.contains("text-emerald-500")).toBe(true);
    expect(
      screen.queryByTestId("milestone-rail-item-ms-b-completed"),
    ).toBeNull();
  });

  it("title span uses `truncate flex-1 text-left` so long titles clip", () => {
    const { container } = renderWithRouter(
      <MilestoneRail
        milestones={[makeMilestone({ id: "ms-a", title: "Foundation" })]}
      />,
    );
    const titleSpan = container.querySelector(
      'button[data-testid="milestone-rail-item"] span',
    );
    expect(titleSpan?.className).toContain("truncate");
    expect(titleSpan?.className).toContain("flex-1");
    expect(titleSpan?.className).toContain("text-left");
  });

  // Negative test pin: milestone-rail.test.tsx::milestone title 80
  // chars truncates with title attr.
  it("80-char title is rendered AND mirrored into the native `title` attr", () => {
    const longTitle = "Foundation: " + "x".repeat(80);
    expect(longTitle.length).toBeGreaterThan(80);
    renderWithRouter(
      <MilestoneRail
        milestones={[makeMilestone({ id: "ms-a", title: longTitle })]}
      />,
    );
    const button = screen.getByTestId("milestone-rail-item");
    // Title attr carries the full string for hover discovery.
    expect(button.getAttribute("title")).toBe(longTitle);
    // The visible span keeps the same text — `truncate` clips it
    // visually via CSS, the text-content is intact.
    expect(button.textContent).toContain(longTitle);
    // And the truncate class is on the title span specifically.
    const span = button.querySelector("span");
    expect(span?.className).toContain("truncate");
  });
});

describe("MilestoneRail — interaction", () => {
  it("clicking a row fires onSelectMilestone with that milestone id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: string) => void>();
    renderWithRouter(
      <MilestoneRail
        milestones={[
          makeMilestone({ id: "ms-a", title: "Foundation" }),
          makeMilestone({ id: "ms-b", title: "Host checks" }),
        ]}
        onSelectMilestone={onSelect}
      />,
    );
    await user.click(screen.getByTitle("Host checks"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("ms-b");
  });

  it("clicking the already-active row still fires onSelectMilestone (no swallow)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: string) => void>();
    renderWithRouter(
      <MilestoneRail
        milestones={[makeMilestone({ id: "ms-a", title: "Foundation" })]}
        activeMilestoneId="ms-a"
        onSelectMilestone={onSelect}
      />,
    );
    await user.click(screen.getByTitle("Foundation"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("ms-a");
  });

  // Negative test pin: milestone-rail.test.tsx::clicking inactive
  // milestone updates active state + URL.
  it("clicking an inactive row updates the active highlight AND the ?milestone= URL", async () => {
    const user = userEvent.setup();
    const milestones = [
      makeMilestone({ id: "ms-a", title: "Foundation" }),
      makeMilestone({ id: "ms-b", title: "Host checks" }),
    ];
    const { getMilestoneParam } = renderWithRouter(
      <URLBackedRail milestones={milestones} />,
      { initialUrl: "/projects/p1?milestone=ms-a" },
    );

    expect(getMilestoneParam()).toBe("ms-a");
    expect(
      screen.getByTitle("Foundation").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByTitle("Host checks").getAttribute("aria-current"),
    ).toBeNull();

    await user.click(screen.getByTitle("Host checks"));

    expect(getMilestoneParam()).toBe("ms-b");
    expect(
      screen.getByTitle("Host checks").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByTitle("Foundation").getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("MilestoneRail — selection persists across tab switches", () => {
  it("flipping ?tab= keeps the active milestone highlighted", async () => {
    const user = userEvent.setup();
    const milestones = [
      makeMilestone({ id: "ms-a", title: "Foundation" }),
      makeMilestone({ id: "ms-b", title: "Host checks" }),
    ];
    renderWithRouter(<TabbedHost milestones={milestones} />, {
      initialUrl: "/projects/p1?milestone=ms-b",
    });

    expect(screen.getByTestId("tab-current").textContent).toBe("plan");
    expect(
      screen.getByTitle("Host checks").getAttribute("aria-current"),
    ).toBe("true");

    await user.click(screen.getByTestId("tab-runs"));

    expect(screen.getByTestId("tab-current").textContent).toBe("runs");
    // Active milestone still highlighted because the URL `?milestone=`
    // param is untouched by the tab flip.
    expect(
      screen.getByTitle("Host checks").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByTitle("Foundation").getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("MilestoneRail — controlled-from-state parent (no URL)", () => {
  it("works when the parent drives selection from local state alone", async () => {
    const user = userEvent.setup();
    function StatefulHost() {
      const [active, setActive] = useState<string | null>("ms-a");
      return (
        <>
          <span data-testid="active-mirror">{active ?? ""}</span>
          <MilestoneRail
            milestones={[
              makeMilestone({ id: "ms-a", title: "Foundation" }),
              makeMilestone({ id: "ms-b", title: "Host checks" }),
            ]}
            activeMilestoneId={active}
            onSelectMilestone={setActive}
          />
        </>
      );
    }
    renderWithRouter(<StatefulHost />);
    expect(screen.getByTestId("active-mirror").textContent).toBe("ms-a");

    await user.click(screen.getByTitle("Host checks"));
    expect(screen.getByTestId("active-mirror").textContent).toBe("ms-b");
    expect(
      screen.getByTitle("Host checks").getAttribute("aria-current"),
    ).toBe("true");
  });
});
