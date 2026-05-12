import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";

import {
  PROJECT_TAB_IDS,
  ProjectTabs,
  type ProjectTabId,
} from "@/pages/project-detail-components/ProjectTabs";

/**
 * Contract tests for the project-detail tab strip.
 *
 * Pins down:
 *   - 5 tabs (plan / tree / code / runs / config) render in order. The
 *     legacy "Board" tab was removed — Tree now drills all the way down
 *     to tasks, making the cross-milestone slice swimlane redundant.
 *   - The active tab is visually distinct via bg-white (or dark variant)
 *     + shadow-sm + font-semibold; inactive tabs are zinc-500.
 *   - The URL `?tab=` query param drives + reflects the active state via
 *     `useSearchParams` (with `replace: true` semantics).
 *   - Keyboard navigation (ArrowLeft / ArrowRight wraps; Home / End jump).
 */

// --- helpers -----------------------------------------------------------------

/**
 * Render the tabs inside a real Routes/Route tree so `useSearchParams`
 * resolves a stable router context. A spy renders alongside that
 * captures `?tab=` so URL assertions are direct.
 */
function URLProbe({ onUrl }: { onUrl: (search: string, tab: string) => void }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const search = location.search;
  const tab = params.get("tab") ?? "";
  onUrl(search, tab);
  return null;
}

function renderTabs(
  ui: ReactNode,
  { initialUrl = "/projects/p1" }: { initialUrl?: string } = {},
) {
  let lastSearch = "";
  let lastTab = "";
  const probe = (search: string, tab: string) => {
    lastSearch = search;
    lastTab = tab;
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
    getTabParam: () => lastTab,
  };
}

// --- tests -------------------------------------------------------------------

describe("ProjectTabs — tab strip", () => {
  it("renders exactly the 5 expected tabs in order", () => {
    renderTabs(<ProjectTabs />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toEqual(["Plan", "Tree", "Code", "Runs", "Config"]);
    // Sanity-check the data-tab-id attribute drives the IDs the parent
    // page consumes.
    expect(tabs.map((t) => t.getAttribute("data-tab-id"))).toEqual([
      ...PROJECT_TAB_IDS,
    ]);
  });

  it("defaults to 'plan' when no ?tab= is present", () => {
    renderTabs(<ProjectTabs />);
    const planTab = screen.getByRole("tab", { name: "Plan" });
    expect(planTab.getAttribute("aria-selected")).toBe("true");
    expect(planTab.getAttribute("data-active")).toBe("true");
    for (const id of ["tree", "code", "runs", "config"]) {
      const tab = screen.getByTestId(`project-tab-${id}`);
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.getAttribute("data-active")).toBeNull();
    }
  });

  it("the legacy 'board' tab is no longer rendered", () => {
    renderTabs(<ProjectTabs />);
    expect(screen.queryByRole("tab", { name: "Board" })).toBeNull();
    expect(screen.queryByTestId("project-tab-board")).toBeNull();
  });

  it("normalises an unknown ?tab= value back to plan", () => {
    renderTabs(<ProjectTabs />, {
      initialUrl: "/projects/p1?tab=mystery",
    });
    expect(
      screen
        .getByRole("tab", { name: "Plan" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("active tab is visually distinct (bg-card + shadow + font-semibold)", () => {
    renderTabs(<ProjectTabs />, { initialUrl: "/projects/p1?tab=runs" });
    const runs = screen.getByRole("tab", { name: "Runs" });
    expect(runs.className).toContain("bg-white");
    expect(runs.className).toContain("dark:bg-zinc-900");
    expect(runs.className).toContain("shadow-sm");
    expect(runs.className).toContain("font-semibold");

    const plan = screen.getByRole("tab", { name: "Plan" });
    expect(plan.className).toContain("text-zinc-500");
    expect(plan.className).not.toContain("font-semibold");
  });

  it("container uses the segmented-pill classes from the spec", () => {
    renderTabs(<ProjectTabs />);
    const list = screen.getByRole("tablist", { name: "Project sections" });
    for (const cls of [
      "inline-flex",
      "rounded-lg",
      "bg-zinc-100",
      "dark:bg-zinc-800",
      "p-0.5",
    ]) {
      expect(list.className).toContain(cls);
    }
  });

  it("clicking a tab updates ?tab= via useSearchParams", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<ProjectTabs />);
    await user.click(screen.getByRole("tab", { name: "Code" }));
    expect(getTabParam()).toBe("code");
    expect(
      screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("selecting Plan clears the ?tab= param entirely", async () => {
    const user = userEvent.setup();
    const { getSearch } = renderTabs(<ProjectTabs />, {
      initialUrl: "/projects/p1?tab=runs",
    });
    expect(getSearch()).toContain("tab=runs");
    await user.click(screen.getByRole("tab", { name: "Plan" }));
    expect(getSearch()).toBe("");
  });

  it("fires onTabChange with the new id when a tab is clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn<(tab: ProjectTabId) => void>();
    renderTabs(<ProjectTabs onTabChange={onTabChange} />);
    await user.click(screen.getByRole("tab", { name: "Tree" }));
    expect(onTabChange).toHaveBeenCalledWith("tree");
  });

  it("ArrowRight cycles to the next tab and wraps at the end", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<ProjectTabs />);
    const plan = screen.getByRole("tab", { name: "Plan" });
    plan.focus();

    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("tree");
    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("code");
    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("runs");
    await user.keyboard("{ArrowRight}");
    expect(getTabParam()).toBe("config");
    // Wrap.
    await user.keyboard("{ArrowRight}");
    // Plan is the default — param is cleared rather than set to "plan".
    expect(getTabParam()).toBe("");
    expect(
      screen.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("ArrowLeft cycles to the previous tab and wraps at the start", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<ProjectTabs />);
    screen.getByRole("tab", { name: "Plan" }).focus();
    await user.keyboard("{ArrowLeft}");
    // Wrapped to last (config).
    expect(getTabParam()).toBe("config");
    await user.keyboard("{ArrowLeft}");
    expect(getTabParam()).toBe("runs");
  });

  it("Home jumps to the first tab and End jumps to the last", async () => {
    const user = userEvent.setup();
    const { getTabParam } = renderTabs(<ProjectTabs />, {
      initialUrl: "/projects/p1?tab=code",
    });
    const code = screen.getByRole("tab", { name: "Code" });
    code.focus();

    await user.keyboard("{End}");
    expect(getTabParam()).toBe("config");
    await user.keyboard("{Home}");
    // Plan is default — param cleared.
    expect(getTabParam()).toBe("");
    expect(
      screen.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("only the active tab is in the focus ring (roving tabindex)", () => {
    renderTabs(<ProjectTabs />, { initialUrl: "/projects/p1?tab=runs" });
    expect(
      screen.getByRole("tab", { name: "Runs" }).getAttribute("tabindex"),
    ).toBe("0");
    for (const name of ["Plan", "Tree", "Code", "Config"]) {
      expect(
        screen.getByRole("tab", { name }).getAttribute("tabindex"),
      ).toBe("-1");
    }
  });
});
