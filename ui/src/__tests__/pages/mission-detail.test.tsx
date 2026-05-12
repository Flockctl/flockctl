import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Page-assembly tests for the redesigned mission detail page
 * (slice 24-01 / T04).
 *
 * The page is a thin orchestrator. These assertions pin down only the
 * structural contract called out in the slice's `## Tasks → T04` block:
 *
 *   1. The page wrapper carries `max-w-7xl` (the shell's <main> already
 *      adds the page-edge padding — see `components/shell/NewShell.tsx`).
 *   2. `MissionHeader` renders at the top.
 *   3. `MissionKpiStrip` renders below the header.
 *   4. The 3-column grid hosts `MissionEventsFeed` (col-span-2) and
 *      `ProposalsQueue` in the right column.
 *   5. The not-found branch renders an empty-state when the mission
 *      query rejects.
 *
 * The hooks are mocked at the module boundary so the page can render
 * without a live backend, react-query state, or a global WS — every
 * child component already has its own unit suite covering the
 * behavioural contracts; this file is structural only.
 */

// ---------------------------------------------------------------------------
// Hook stubs
// ---------------------------------------------------------------------------

const useMissionMock = vi.fn();
const useMissionEventsMock = vi.fn();
const useMissionProposalsMock = vi.fn();

vi.mock("@/lib/hooks/missions", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useMission: (...args: unknown[]) => useMissionMock(...args),
    useMissionEvents: (...args: unknown[]) => useMissionEventsMock(...args),
    useMissionProposals: (...args: unknown[]) =>
      useMissionProposalsMock(...args),
  };
});

// `useTrackRecent` writes into localStorage; stub to a no-op so the
// assembly tests don't pollute the harness's localStorage.
vi.mock("@/lib/recent-store", () => ({
  useTrackRecent: vi.fn(),
}));

// Imported AFTER the mocks so the page picks up the stubs.
import MissionDetailPage from "@/pages/mission-detail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-abc",
    project_id: "proj-1",
    objective: "Stand up the supervisor onboarding flow",
    status: "active",
    autonomy: "suggest",
    budget_tokens: 1_000_000,
    budget_usd_cents: 5000,
    spent_tokens: 12_345,
    spent_usd_cents: 67,
    supervisor_prompt_version: "1.0.0",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_500,
    ...overrides,
  };
}

function renderPage() {
  // A throwaway QueryClient — none of the children we don't mock issue
  // a network request in this harness, but the QueryClientProvider is
  // required for any nested `useQuery` instantiated through children.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/missions/mission-abc"]}>
        <Routes>
          <Route path="/missions/:missionId" element={<MissionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useMissionMock.mockReset();
  useMissionEventsMock.mockReset();
  useMissionProposalsMock.mockReset();

  // Defaults: mission resolved, empty events, empty proposals.
  useMissionMock.mockReturnValue({
    data: makeMission(),
    isLoading: false,
    error: null,
  });
  useMissionEventsMock.mockReturnValue({
    events: [],
    isLoading: false,
    error: null,
    connectionState: "open" as const,
  });
  useMissionProposalsMock.mockReturnValue({
    data: { items: [], total: 0, status: "pending" as const },
    isLoading: false,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MissionDetailPage / page wrapper", () => {
  it("renders the page sentinel and applies max-w-7xl (no extra padding — shell <main> owns it)", () => {
    renderPage();
    const root = screen.getByTestId("mission-detail-page");
    expect(root.className).toContain("max-w-7xl");
    // Mission detail used to also apply `mx-auto p-6` here, but that
    // double-padded against the shell's <main> (`p-3 sm:p-4 md:p-6`) and
    // offset the page from every other surface. Assert neither slipped back.
    expect(root.className).not.toContain("p-6");
    expect(root.className).not.toContain("mx-auto");
  });
});

describe("MissionDetailPage / structural composition", () => {
  it("renders MissionHeader → MissionKpiStrip → grid (events col-span-2 + proposals)", () => {
    renderPage();

    // Header.
    expect(screen.getByTestId("mission-header")).toBeInTheDocument();
    expect(screen.getByTestId("mission-header-objective")).toHaveTextContent(
      "Stand up the supervisor onboarding flow",
    );

    // KPI strip.
    expect(screen.getByTestId("mission-kpi-strip")).toBeInTheDocument();

    // Grid.
    const grid = screen.getByTestId("mission-detail-grid");
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain("lg:grid-cols-3");

    // Events column carries col-span-2.
    const eventsCol = screen.getByTestId("mission-detail-events-col");
    expect(eventsCol.className).toContain("lg:col-span-2");
    expect(eventsCol.querySelector('[data-testid="mission-events-feed"]')).not.toBeNull();

    // Proposals column.
    const proposalsCol = screen.getByTestId("mission-detail-proposals-col");
    expect(proposalsCol).toBeInTheDocument();
    // Empty default → empty card variant rendered.
    expect(
      proposalsCol.querySelector(
        '[data-testid="mission-proposals-queue-empty-card"]',
      ),
    ).not.toBeNull();
  });

  it("hands the pending proposal count off to the KPI strip", () => {
    useMissionProposalsMock.mockReturnValue({
      data: {
        items: [
          {
            id: "prop-1",
            mission_id: "mission-abc",
            kind: "remediation_proposed",
            payload: {
              rationale: "trial",
              proposal: { target_type: "task", candidate: { action: "do thing" } },
            },
            cost_tokens: 0,
            cost_usd_cents: 0,
            depth: 0,
            created_at: Math.floor(Date.now() / 1000),
          },
          {
            id: "prop-2",
            mission_id: "mission-abc",
            kind: "remediation_proposed",
            payload: {
              rationale: "trial",
              proposal: { target_type: "task", candidate: { action: "do thing 2" } },
            },
            cost_tokens: 0,
            cost_usd_cents: 0,
            depth: 1,
            created_at: Math.floor(Date.now() / 1000),
          },
        ],
        total: 2,
        status: "pending" as const,
      },
      isLoading: false,
      error: null,
    });

    renderPage();
    const pending = screen.getByTestId("mission-kpi-pending");
    expect(pending).toHaveTextContent("2");
    // Tone flips to warning when pending > 0.
    expect(pending.getAttribute("data-tone")).toBe("warning");
  });

  it("derives triggers24h from the timeline", () => {
    const nowS = Math.floor(Date.now() / 1000);
    useMissionEventsMock.mockReturnValue({
      events: [
        // Within the 24h window.
        {
          id: "ev-1",
          mission_id: "mission-abc",
          kind: "task_observed",
          payload: {},
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 1,
          created_at: nowS - 60,
        },
        {
          id: "ev-2",
          mission_id: "mission-abc",
          kind: "no_action",
          payload: {},
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 0,
          created_at: nowS - 60 * 60,
        },
        // Out of the 24h window — the loop short-circuits here.
        {
          id: "ev-3",
          mission_id: "mission-abc",
          kind: "heartbeat",
          payload: {},
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 0,
          created_at: nowS - 48 * 60 * 60,
        },
      ],
      isLoading: false,
      error: null,
      connectionState: "open" as const,
    });

    renderPage();
    const triggers = screen.getByTestId("mission-kpi-triggers");
    expect(triggers).toHaveTextContent("2");
  });
});

describe("MissionDetailPage / loading + error states", () => {
  it("renders skeleton placeholders while the mission query is loading", () => {
    useMissionMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    renderPage();
    const root = screen.getByTestId("mission-detail-page");
    // Skeleton elements are present (any rounded-bg-muted shapes).
    expect(root.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // Header / KPI strip are NOT mounted in the loading branch.
    expect(screen.queryByTestId("mission-header")).toBeNull();
    expect(screen.queryByTestId("mission-kpi-strip")).toBeNull();
  });

  it("renders the not-found empty-state when the mission query errors", () => {
    useMissionMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("404"),
    });

    renderPage();
    const root = screen.getByTestId("mission-detail-page");
    expect(root.getAttribute("data-state")).toBe("not-found");
    expect(screen.getByText(/Mission not found/)).toBeInTheDocument();
    // The structural composition is NOT mounted in the not-found branch.
    expect(screen.queryByTestId("mission-detail-grid")).toBeNull();
  });
});
