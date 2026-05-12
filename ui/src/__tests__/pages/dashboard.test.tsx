import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

/**
 * Page-assembly tests for the redesigned dashboard (slice 23-01 / T06).
 *
 * The dashboard is a thin assembly of the five components shipped in
 * T01–T05. These tests pin down the structural contract called out in
 * the slice's `## Tasks → T06` block:
 *
 *   1. The page wrapper carries `max-w-7xl` (the shell's <main> already
 *      adds the page-edge padding — see `components/shell/NewShell.tsx`).
 *   2. The page renders a `<SectionHeader title="Dashboard" />` with a
 *      `TimeRangeSelect` + a "New chat" button in the action slot.
 *   3. `<DashboardKpiTiles />` renders below the header.
 *   4. The 3-column grid hosts `<RecentActivity class="col-span-2" />`
 *      and a sibling column of `<ActiveMissionCard /> + <QuickLinks />`.
 *   5. The "New chat" button navigates to `/chats`.
 *
 * Hooks are stubbed at the module boundary so the component renders
 * deterministically — none of the assertions exercise live network or
 * react-query state. The KPI / activity / mission / quick-links visual
 * contracts already have their own unit suites; this file is purely
 * structural.
 */

// ---------------------------------------------------------------------------
// Hook stubs — all dashboards-side data fan-out lives in @/lib/hooks plus
// `useAttention` from @/lib/hooks/attention. We keep the shapes minimal so
// the assertions don't accidentally drift with real-world data growth.
// ---------------------------------------------------------------------------

vi.mock("@/lib/hooks", () => ({
  useTasks: () => ({ data: { items: [], total: 0 }, isLoading: false }),
  useUsageSummary: () => ({
    data: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_cost_usd: 0,
      record_count: 0,
      by_provider: {},
      by_model: {},
    },
    isLoading: false,
  }),
  useChats: () => ({ data: [], isLoading: false }),
  useProjects: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/hooks/attention", () => ({
  useAttention: () => ({
    items: [],
    total: 0,
    isLoading: false,
    error: null,
    connectionState: "open" as const,
  }),
}));

// Imported AFTER the mocks so the page picks up the stubbed hooks.
import DashboardPage from "@/pages/dashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function LocationSpy() {
  const loc = useLocation();
  return (
    <div data-testid="navigated-to">{`${loc.pathname}${loc.search}`}</div>
  );
}

function renderDashboard(initialEntry = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chats" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // The slice's TimeRangeSelect persists `?range=` on the URL via
  // `useSearchParams`, but we pin the entry route per test so each
  // render starts from a known param state.
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DashboardPage / page wrapper", () => {
  it("renders the data-testid sentinel and applies max-w-7xl (no extra padding — shell <main> owns it)", () => {
    renderDashboard();
    const root = screen.getByTestId("dashboard-page");
    expect(root.className).toContain("max-w-7xl");
    // The dashboard used to also apply `mx-auto p-6` here, but that
    // double-padded against the shell's <main> (`p-3 sm:p-4 md:p-6`) and
    // offset the page content from every other surface (Tasks, Projects,
    // Workspaces, Templates, …). Per the consistency audit we now defer
    // to the shell — assert neither slipped back in.
    expect(root.className).not.toContain("p-6");
    expect(root.className).not.toContain("mx-auto");
  });
});

describe("DashboardPage / header", () => {
  it("renders the Dashboard h1 from SectionHeader", () => {
    renderDashboard();
    const heading = screen.getByRole("heading", {
      name: "Dashboard",
      level: 1,
    });
    expect(heading).toBeInTheDocument();
  });

  it("renders a dynamic subtitle that mentions tasks, chats, and daemon", () => {
    renderDashboard();
    const header = screen.getByTestId("section-header");
    expect(header.textContent).toMatch(/active task/);
    expect(header.textContent).toMatch(/chat/);
    expect(header.textContent).toMatch(/daemon healthy/);
  });

  it("renders the TimeRangeSelect inside the header action slot", () => {
    renderDashboard();
    const header = screen.getByTestId("section-header");
    expect(within(header).getByTestId("time-range-select")).toBeInTheDocument();
  });

  it("renders the New chat button inside the header action slot", () => {
    renderDashboard();
    const header = screen.getByTestId("section-header");
    const button = within(header).getByTestId("dashboard-new-chat-button");
    expect(button).toBeInTheDocument();
    expect(button.textContent).toMatch(/New chat/);
  });
});

describe("DashboardPage / KPI strip", () => {
  it("renders DashboardKpiTiles below the header", () => {
    renderDashboard();
    expect(screen.getByTestId("dashboard-kpi-tiles")).toBeInTheDocument();
    // Five tiles per the T01 contract.
    expect(screen.getAllByTestId("kpi-tile")).toHaveLength(5);
  });
});

describe("DashboardPage / 3-column grid", () => {
  it("renders the grid with grid + lg:grid-cols-3", () => {
    renderDashboard();
    const grid = screen.getByTestId("dashboard-grid");
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain("lg:grid-cols-3");
  });

  it("RecentActivity is the wide (col-span-2) child", () => {
    renderDashboard();
    const grid = screen.getByTestId("dashboard-grid");
    // Recent activity renders its `Recent activity` header.
    const recentHeader = within(grid).getByTestId(
      "recent-activity-header",
    );
    // Walk up to find the FlatCard wrapper that carries col-span-2.
    let node: HTMLElement | null = recentHeader.parentElement;
    while (node && !node.className.includes("col-span-2")) {
      node = node.parentElement;
    }
    expect(node).not.toBeNull();
    expect(node!.className).toContain("lg:col-span-2");
  });

  it("renders ActiveMissionCard and QuickLinks in the right column", () => {
    renderDashboard();
    const grid = screen.getByTestId("dashboard-grid");
    expect(
      within(grid).getByTestId("active-mission-card"),
    ).toBeInTheDocument();
    // Empty state by default — no mission, no projects.
    expect(
      within(grid).getByTestId("active-mission-card").getAttribute("data-state"),
    ).toBe("empty");
    expect(
      within(grid).getByTestId("quick-links-header"),
    ).toBeInTheDocument();
  });

  it("ActiveMissionCard + QuickLinks share a space-y-3 container", () => {
    renderDashboard();
    const grid = screen.getByTestId("dashboard-grid");
    const mission = within(grid).getByTestId("active-mission-card");
    const wrapper = mission.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("space-y-3");
  });
});

describe("DashboardPage / new-chat navigation", () => {
  it("clicking New chat routes to /chats", async () => {
    renderDashboard();
    fireEvent.click(screen.getByTestId("dashboard-new-chat-button"));
    expect(screen.getByTestId("navigated-to").textContent).toBe("/chats");
  });
});
