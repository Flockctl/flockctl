import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Slice 10/06 — SupervisorLogTab + DEFAULT_SLICE_TABS composition.
 *
 * Two surfaces under test:
 *
 *   1. {@link SupervisorLogTab} renders the timeline returned by the
 *      mocked {@link useMissionEvents} hook. The component is a thin
 *      view layer; the hook owns the data flow (initial fetch + WS
 *      overlay + RAF coalescing) — that contract is covered by the
 *      sibling `use_mission_events_hook.test.tsx` file.
 *
 *   2. {@link getSliceDetailTabs} composes
 *      `DEFAULT_SLICE_TABS + supervisorLogTab(missionId)` IFF a mission
 *      id is passed — i.e. "registered in DEFAULT_SLICE_TABS when a
 *      mission is selected". Without a missionId, it returns the
 *      default registry untouched (so the existing `slice_detail_tabs`
 *      extension-point test still passes).
 */

// Mock the hook so the component can be rendered without a query client
// or a global WS mock — those are exercised by the hook's own test file.
const useMissionEventsMock = vi.fn();
vi.mock("@/lib/hooks/missions", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useMissionEvents: (...args: unknown[]) => useMissionEventsMock(...args),
  };
});

// Must import AFTER vi.mock so the component resolves to the mocked hook.
import { SupervisorLogTab } from "@/pages/project-detail-components/SupervisorLogTab";
import {
  DEFAULT_SLICE_TABS,
  SUPERVISOR_LOG_TAB_ID,
  SliceDetailTabs,
  getSliceDetailTabs,
  supervisorLogTab,
} from "@/pages/project-detail-components/SliceDetailTabs";

beforeEach(() => {
  useMissionEventsMock.mockReset();
});

describe("SupervisorLogTab — view layer", () => {
  it("renders a loading hint while the initial fetch is in-flight", () => {
    useMissionEventsMock.mockReturnValue({
      events: [],
      isLoading: true,
      error: null,
      connectionState: "connecting",
    });

    render(<SupervisorLogTab missionId="mission-x" />);

    expect(screen.getByTestId("supervisor-log-loading")).toBeTruthy();
    expect(screen.queryByTestId("supervisor-log-list")).toBeNull();
  });

  it("renders an empty-state hint when the timeline has no events", () => {
    useMissionEventsMock.mockReturnValue({
      events: [],
      isLoading: false,
      error: null,
      connectionState: "open",
    });

    render(<SupervisorLogTab missionId="mission-x" />);

    expect(screen.getByTestId("supervisor-log-empty")).toBeTruthy();
  });

  it("renders one row per event (newest-first), kind + depth visible", () => {
    useMissionEventsMock.mockReturnValue({
      events: [
        {
          id: "evt-2",
          mission_id: "mission-x",
          kind: "no_action",
          payload: null,
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 1,
          created_at: 1_700_000_200,
        },
        {
          id: "evt-1",
          mission_id: "mission-x",
          kind: "task_observed",
          payload: null,
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 0,
          created_at: 1_700_000_100,
        },
      ],
      isLoading: false,
      error: null,
      connectionState: "open",
    });

    render(<SupervisorLogTab missionId="mission-x" />);

    const rows = screen.getAllByTestId("supervisor-log-row");
    expect(rows).toHaveLength(2);
    // Newest-first: evt-2 (no_action, d=1) comes before evt-1.
    expect(rows[0]!.getAttribute("data-event-id")).toBe("evt-2");
    expect(rows[0]!.getAttribute("data-event-kind")).toBe("no_action");
    expect(rows[0]!.textContent).toContain("no_action");
    expect(rows[0]!.textContent).toContain("d=1");

    expect(rows[1]!.getAttribute("data-event-id")).toBe("evt-1");
    expect(rows[1]!.getAttribute("data-event-kind")).toBe("task_observed");
  });

  it("surfaces the WS connection state via a data attribute", () => {
    useMissionEventsMock.mockReturnValue({
      events: [
        {
          id: "evt-1",
          mission_id: "mission-x",
          kind: "task_observed",
          payload: null,
          cost_tokens: 0,
          cost_usd_cents: 0,
          depth: 0,
          created_at: 1_700_000_100,
        },
      ],
      isLoading: false,
      error: null,
      connectionState: "open",
    });

    render(<SupervisorLogTab missionId="mission-x" />);

    const tab = screen.getByTestId("supervisor-log-tab");
    expect(tab.getAttribute("data-connection-state")).toBe("open");
  });

  it("renders an error hint when the fetch fails and no events are buffered", () => {
    useMissionEventsMock.mockReturnValue({
      events: [],
      isLoading: false,
      error: new Error("boom"),
      connectionState: "closed",
    });

    render(<SupervisorLogTab missionId="mission-x" />);

    const banner = screen.getByTestId("supervisor-log-error");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("boom");
  });
});

describe("supervisor_log_tab — DEFAULT_SLICE_TABS composition", () => {
  it("getSliceDetailTabs() returns DEFAULT_SLICE_TABS unchanged when no mission is selected", () => {
    const tabs = getSliceDetailTabs();
    // Identity-equal to the exported default — no mission id ⇒ no
    // supervisor tab registered.
    expect(tabs).toBe(DEFAULT_SLICE_TABS);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.id).toBe("slice-detail");
  });

  it("getSliceDetailTabs({ missionId }) registers the Supervisor log tab alongside the default", () => {
    const tabs = getSliceDetailTabs({ missionId: "mission-x" });
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.id).toBe("slice-detail");
    expect(tabs[1]!.id).toBe(SUPERVISOR_LOG_TAB_ID);
    expect(tabs[1]!.label).toBe("Supervisor log");
  });

  it("supervisorLogTab(missionId) is a registry-friendly TabDef factory", () => {
    const tab = supervisorLogTab("mission-y");
    expect(tab.id).toBe(SUPERVISOR_LOG_TAB_ID);
    expect(typeof tab.render).toBe("function");
  });

  it("renders alongside the default Slice tab when registered via the composition seam", async () => {
    // End-to-end smoke for the composition pattern: the registry from
    // getSliceDetailTabs lands in SliceDetailTabs.tsx without modifying
    // the registry component. Switching to the supervisor tab mounts the
    // SupervisorLogTab body.
    useMissionEventsMock.mockReturnValue({
      events: [],
      isLoading: false,
      error: null,
      connectionState: "open",
    });

    const tabs = getSliceDetailTabs({ missionId: "mission-x" });
    render(
      <SliceDetailTabs
        sliceId="slice-1"
        missionId="mission-x"
        tabs={tabs}
      />,
    );

    const sliceTrigger = screen.getByRole("tab", { name: "Slice" });
    const supervisorTrigger = screen.getByRole("tab", {
      name: "Supervisor log",
    });
    expect(sliceTrigger).toBeTruthy();
    expect(supervisorTrigger).toBeTruthy();

    // Default tab is still active on mount.
    expect(sliceTrigger.getAttribute("data-state")).toBe("active");

    // Switch to the supervisor tab — its body mounts.
    await userEvent.click(supervisorTrigger);
    expect(supervisorTrigger.getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("supervisor-log-empty")).toBeTruthy();
  });
});
