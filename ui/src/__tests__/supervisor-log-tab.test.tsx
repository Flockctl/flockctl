import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { MissionEvent } from "@/lib/hooks/missions";

/**
 * Slice 11/07 — `SupervisorLogTab` reconnect + a11y corner cases.
 *
 * Companion to `components/supervisor_log_tab.test.tsx` (baseline render +
 * registry composition). This file pins the WS-reconnect contract and
 * accessibility invariants the slice spec calls out:
 *
 *   - WS connection-state transitions (`open` → `closed` → `connecting` →
 *     `open`) bubble through `data-connection-state` so an operator can see
 *     when the live overlay is offline.
 *   - The list uses semantic <ul>/<li> ordering (axe `listitem`).
 *   - The "ws: <state>" status carries an aria-label so AT users hear the
 *     transition.
 *   - Loading + error + empty are mutually exclusive surfaces.
 *
 * The hook itself owns the RAF coalescing + reconnect-invalidate logic —
 * that contract is covered by `lib/use_mission_events_hook.test.tsx`. Here
 * we mock the hook output and rerender to simulate state transitions.
 */

const useMissionEventsMock = vi.fn();
vi.mock("@/lib/hooks/missions", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useMissionEvents: (...args: unknown[]) => useMissionEventsMock(...args),
  };
});

// Import AFTER vi.mock.
import { SupervisorLogTab } from "@/pages/project-detail-components/SupervisorLogTab";

beforeEach(() => {
  useMissionEventsMock.mockReset();
});

function makeEvent(over: Partial<MissionEvent> = {}): MissionEvent {
  return {
    id: "evt-default",
    mission_id: "mission-x",
    kind: "task_observed",
    payload: null,
    cost_tokens: 0,
    cost_usd_cents: 0,
    depth: 0,
    created_at: 1_700_000_000,
    ...over,
  };
}

// --- WS reconnect surface ----------------------------------------------------

describe("ws_reconnecting", () => {
  it("surfaces the four canonical connection states via data-connection-state", () => {
    const events = [makeEvent({ id: "evt-1" })];
    for (const state of ["connecting", "open", "closing", "closed"] as const) {
      useMissionEventsMock.mockReturnValueOnce({
        events,
        isLoading: false,
        error: null,
        connectionState: state,
      });
      const { unmount } = render(<SupervisorLogTab missionId="mission-x" />);
      const tab = screen.getByTestId("supervisor-log-tab");
      expect(tab.getAttribute("data-connection-state")).toBe(state);
      unmount();
    }
  });

  it("'closed' state still renders the buffered events (offline overlay)", () => {
    useMissionEventsMock.mockReturnValue({
      events: [
        makeEvent({ id: "evt-2", kind: "no_action", depth: 1 }),
        makeEvent({ id: "evt-1", kind: "task_observed", depth: 0 }),
      ],
      isLoading: false,
      error: null,
      connectionState: "closed",
    });

    render(<SupervisorLogTab missionId="mission-x" />);
    const rows = screen.getAllByTestId("supervisor-log-row");
    expect(rows).toHaveLength(2);
    // Even with the socket closed, the rendered list mirrors the buffer.
    expect(rows[0]!.getAttribute("data-event-id")).toBe("evt-2");
    expect(rows[1]!.getAttribute("data-event-id")).toBe("evt-1");
  });

  it("transitions from 'open' to 'closed' to 'open' propagate without unmounting the row list", () => {
    // First render: open + 1 event.
    useMissionEventsMock.mockReturnValueOnce({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    const { rerender } = render(<SupervisorLogTab missionId="mission-x" />);
    expect(
      screen.getByTestId("supervisor-log-tab").getAttribute("data-connection-state"),
    ).toBe("open");

    // Drop the connection — list keeps the same buffer.
    useMissionEventsMock.mockReturnValueOnce({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "closed",
    });
    rerender(<SupervisorLogTab missionId="mission-x" />);
    expect(
      screen.getByTestId("supervisor-log-tab").getAttribute("data-connection-state"),
    ).toBe("closed");
    expect(screen.getAllByTestId("supervisor-log-row")).toHaveLength(1);

    // Reconnect — the hook would have invalidated the query upstream; from
    // the view's perspective the events array swaps and connectionState
    // flips back to "open".
    useMissionEventsMock.mockReturnValueOnce({
      events: [
        makeEvent({ id: "evt-2", kind: "remediation_proposed" }),
        makeEvent({ id: "evt-1" }),
      ],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    rerender(<SupervisorLogTab missionId="mission-x" />);
    expect(
      screen.getByTestId("supervisor-log-tab").getAttribute("data-connection-state"),
    ).toBe("open");
    const rows = screen.getAllByTestId("supervisor-log-row");
    expect(rows.map((r) => r.getAttribute("data-event-id"))).toEqual([
      "evt-2",
      "evt-1",
    ]);
  });

  it("'connecting' between closed and open still shows the existing buffer (no flicker to empty)", () => {
    useMissionEventsMock.mockReturnValueOnce({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "closed",
    });
    const { rerender } = render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByTestId("supervisor-log-list")).toBeInTheDocument();

    useMissionEventsMock.mockReturnValueOnce({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "connecting",
    });
    rerender(<SupervisorLogTab missionId="mission-x" />);
    expect(
      screen.getByTestId("supervisor-log-tab").getAttribute("data-connection-state"),
    ).toBe("connecting");
    // CRITICAL: the list MUST stay mounted — flickering to the empty state
    // every time the socket reconnects would be jarring on a flaky network.
    expect(screen.getByTestId("supervisor-log-list")).toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-log-empty")).toBeNull();
  });
});

// --- Axe-style a11y ----------------------------------------------------------

describe("axe_compliance_supervisor_log", () => {
  it("the timeline is a semantic <ul> with <li> rows (axe `list` rule)", () => {
    useMissionEventsMock.mockReturnValue({
      events: [
        makeEvent({ id: "evt-1" }),
        makeEvent({ id: "evt-2", kind: "no_action" }),
      ],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    render(<SupervisorLogTab missionId="mission-x" />);
    const list = screen.getByTestId("supervisor-log-list");
    expect(list.tagName).toBe("UL");
    const rows = screen.getAllByTestId("supervisor-log-row");
    for (const r of rows) {
      expect(r.tagName).toBe("LI");
    }
  });

  it("the WS state pill has an aria-label so AT can read 'websocket connection state'", () => {
    useMissionEventsMock.mockReturnValue({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    render(<SupervisorLogTab missionId="mission-x" />);
    const stateLabel = screen.getByLabelText("websocket connection state");
    expect(stateLabel.textContent).toContain("ws: open");
  });

  it("event-row spans expose semantic aria-labels (timestamp / kind / depth)", () => {
    useMissionEventsMock.mockReturnValue({
      events: [makeEvent({ id: "evt-1", depth: 2, kind: "no_action" })],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByLabelText("event timestamp")).toBeInTheDocument();
    expect(screen.getByLabelText("event kind")).toBeInTheDocument();
    expect(screen.getByLabelText("event depth").textContent).toBe("d=2");
  });

  it("the error surface uses role=alert (axe `aria-allowed-role`)", () => {
    useMissionEventsMock.mockReturnValue({
      events: [],
      isLoading: false,
      error: new Error("boom"),
      connectionState: "closed",
    });
    render(<SupervisorLogTab missionId="mission-x" />);
    const banner = screen.getByTestId("supervisor-log-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("boom");
  });

  it("loading / empty / error / list are mutually exclusive surfaces", () => {
    // Loading
    useMissionEventsMock.mockReturnValueOnce({
      events: [],
      isLoading: true,
      error: null,
      connectionState: "connecting",
    });
    const { unmount: u1 } = render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByTestId("supervisor-log-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-log-empty")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-error")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-list")).toBeNull();
    u1();

    // Empty
    useMissionEventsMock.mockReturnValueOnce({
      events: [],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    const { unmount: u2 } = render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByTestId("supervisor-log-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-log-loading")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-error")).toBeNull();
    u2();

    // Error
    useMissionEventsMock.mockReturnValueOnce({
      events: [],
      isLoading: false,
      error: new Error("x"),
      connectionState: "closed",
    });
    const { unmount: u3 } = render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByTestId("supervisor-log-error")).toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-log-loading")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-empty")).toBeNull();
    u3();

    // List
    useMissionEventsMock.mockReturnValueOnce({
      events: [makeEvent({ id: "evt-1" })],
      isLoading: false,
      error: null,
      connectionState: "open",
    });
    render(<SupervisorLogTab missionId="mission-x" />);
    expect(screen.getByTestId("supervisor-log-list")).toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-log-loading")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-empty")).toBeNull();
    expect(screen.queryByTestId("supervisor-log-error")).toBeNull();
  });
});
