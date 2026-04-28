import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * Slice 10/06 — `useMissionEvents` contract tests.
 *
 * Pins the four invariants the parent slice calls out:
 *
 *   1. Initial fetch via GET /missions/:id/events seeds the buffer.
 *   2. Live `mission_event` WS envelopes for a matching missionId are
 *      appended (newest-first).
 *   3. RAF coalescing: a 100-event burst lands as a SINGLE flush — the
 *      committed-state setter fires once per animation frame, not 100x.
 *   4. WS reconnect ("open" after a non-"open" state) invalidates the
 *      query — the canonical timeline replaces the optimistic overlay.
 *
 * Mocking surface:
 *   - `@/lib/ws`     — replaced wholesale to capture the registered
 *                      onMessage handler and to drive a programmable
 *                      "connection state" between renders.
 *   - `requestAnimationFrame` — replaced with a manual scheduler so the
 *                      RAF coalescing test is deterministic.
 */

// ─── WS mock ───────────────────────────────────────────────────────────────

type OnMessage = (msg: { type: string; payload?: unknown }) => void;
const wsSpies: {
  lastOnMessage: OnMessage | null;
  state: "open" | "closed";
} = {
  lastOnMessage: null,
  state: "open",
};

vi.mock("@/lib/ws", () => ({
  useWebSocket: ({ onMessage }: { onMessage?: OnMessage }) => {
    wsSpies.lastOnMessage = onMessage ?? null;
    return { state: wsSpies.state, send: vi.fn() };
  },
  ConnectionState: {
    CONNECTING: "connecting",
    OPEN: "open",
    CLOSING: "closing",
    CLOSED: "closed",
  },
  MessageType: {},
}));

// Must import AFTER vi.mock so the hook resolves to the mocked module.
import { useMissionEvents } from "@/lib/hooks/missions";

// ─── Helpers ───────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

// Wire-side fixture (camelCase, what the router emits before apiFetch).
const EVENT_WIRE_1 = {
  id: "evt-1",
  missionId: "mission-x",
  kind: "task_observed",
  payload: { task_id: 7 },
  costTokens: 100,
  costUsdCents: 1,
  depth: 0,
  createdAt: 1_700_000_100,
};

const EVENT_WIRE_2 = {
  id: "evt-2",
  missionId: "mission-x",
  kind: "no_action",
  payload: { rationale: "nothing to do" },
  costTokens: 50,
  costUsdCents: 1,
  depth: 0,
  createdAt: 1_700_000_200,
};

// ─── RAF scheduler — make the coalescing deterministic. ───────────────────

const rafQueue: Array<() => void> = [];
let originalRaf: typeof requestAnimationFrame | undefined;
let originalCancelRaf: typeof cancelAnimationFrame | undefined;

beforeEach(() => {
  wsSpies.lastOnMessage = null;
  wsSpies.state = "open";

  rafQueue.length = 0;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancelRaf = globalThis.cancelAnimationFrame;
  // Stub RAF: enqueue + return a numeric id. Tests flush via `flushRaf()`.
  (globalThis as Record<string, unknown>).requestAnimationFrame = ((
    cb: () => void,
  ) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (() => {}) as
    typeof cancelAnimationFrame;
});

afterEach(() => {
  if (originalRaf !== undefined) {
    (globalThis as Record<string, unknown>).requestAnimationFrame = originalRaf;
  }
  if (originalCancelRaf !== undefined) {
    (globalThis as Record<string, unknown>).cancelAnimationFrame =
      originalCancelRaf;
  }
});

function flushRaf() {
  // Drain the queue; cbs may schedule more (defensive).
  for (let i = 0; i < 32 && rafQueue.length > 0; i++) {
    const cbs = rafQueue.splice(0);
    for (const cb of cbs) cb();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("use_mission_events_hook — initial fetch + live overlay", () => {
  it("seeds the timeline from GET /missions/:id/events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          items: [EVENT_WIRE_2, EVENT_WIRE_1], // newest-first
          total: 2,
          page: 1,
          perPage: 200,
        }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]!.id).toBe("evt-2");
    expect(result.current.events[1]!.id).toBe("evt-1");

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/missions/mission-x/events");
  });

  it("appends a live mission_event envelope (matching missionId) on the next RAF flush", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items: [], total: 0, page: 1, perPage: 200 }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(typeof wsSpies.lastOnMessage).toBe("function");

    // Dispatch a frame BEFORE flushing rAF — committed state must still be
    // empty (the buffer hasn't been flushed yet).
    act(() => {
      wsSpies.lastOnMessage!({
        type: "mission_event",
        missionId: "mission-x",
        kind: "task_observed",
        eventId: "evt-live-1",
        depth: 1,
      } as unknown as { type: string; payload: unknown });
    });

    expect(result.current.events).toEqual([]);

    // Flush the RAF — the buffer commits in a single setState call.
    act(() => {
      flushRaf();
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]!.id).toBe("evt-live-1");
    expect(result.current.events[0]!.kind).toBe("task_observed");
    expect(result.current.events[0]!.depth).toBe(1);
  });

  it("ignores envelopes for a different missionId", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items: [], total: 0, page: 1, perPage: 200 }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      wsSpies.lastOnMessage!({
        type: "mission_event",
        missionId: "OTHER-MISSION",
        kind: "task_observed",
        eventId: "evt-ignored",
        depth: 0,
      } as unknown as { type: string; payload: unknown });
      flushRaf();
    });

    expect(result.current.events).toEqual([]);
  });

  it("ignores frames whose type is not mission_event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items: [], total: 0, page: 1, perPage: 200 }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      wsSpies.lastOnMessage!({
        type: "attention_changed",
        payload: {},
      });
      flushRaf();
    });

    expect(result.current.events).toEqual([]);
  });
});

describe("use_mission_events_hook — RAF coalescing (100-event burst)", () => {
  it("coalesces a 100-event burst into a single RAF flush", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items: [], total: 0, page: 1, perPage: 200 }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Push 100 envelopes synchronously without flushing — only ONE rAF
    // callback should be queued (the buffer pattern coalesces all the
    // arrivals into a single pending flush).
    act(() => {
      for (let i = 0; i < 100; i++) {
        wsSpies.lastOnMessage!({
          type: "mission_event",
          missionId: "mission-x",
          kind: "task_observed",
          eventId: `burst-${i}`,
          depth: 0,
        } as unknown as { type: string; payload: unknown });
      }
    });

    // Critical perf invariant: a 100-event burst schedules ONE rAF, not 100.
    expect(rafQueue.length).toBe(1);

    // Committed state hasn't been touched yet — the burst is pending.
    expect(result.current.events).toEqual([]);

    // Flush the single rAF — all 100 events land in one setState.
    act(() => {
      flushRaf();
    });

    expect(result.current.events).toHaveLength(100);
    // Newest-first ordering: the LAST event pushed lands at the head.
    expect(result.current.events[0]!.id).toBe("burst-99");
    expect(result.current.events[99]!.id).toBe("burst-0");
  });

  it("does not double-render an event that arrives twice in the same burst", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items: [], total: 0, page: 1, perPage: 200 }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMissionEvents("mission-x"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      // Same eventId twice — duplicate guard must drop the second.
      wsSpies.lastOnMessage!({
        type: "mission_event",
        missionId: "mission-x",
        kind: "task_observed",
        eventId: "dup-1",
        depth: 0,
      } as unknown as { type: string; payload: unknown });
      wsSpies.lastOnMessage!({
        type: "mission_event",
        missionId: "mission-x",
        kind: "task_observed",
        eventId: "dup-1",
        depth: 0,
      } as unknown as { type: string; payload: unknown });
      flushRaf();
    });

    expect(result.current.events).toHaveLength(1);
  });
});

describe("use_mission_events_hook — reconnect refresh", () => {
  it("re-fetches the timeline when the WS state transitions back to open", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [EVENT_WIRE_1],
          total: 1,
          page: 1,
          perPage: 200,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [EVENT_WIRE_2, EVENT_WIRE_1],
          total: 2,
          page: 1,
          perPage: 200,
        }),
      );
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    // Start from a "closed" state so the very first transition into "open"
    // (which happens on the second render after we flip the state below)
    // triggers the invalidate-on-reconnect effect.
    wsSpies.state = "closed";

    const { Wrapper } = wrap();
    const { result, rerender } = renderHook(
      () => useMissionEvents("mission-x"),
      { wrapper: Wrapper },
    );

    await waitFor(() =>
      expect(result.current.events.map((e) => e.id)).toEqual(["evt-1"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Flip the WS state to "open" and re-render — useGlobalWs returns the
    // new state, the reconnect effect fires, and the hook invalidates.
    wsSpies.state = "open";
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.events.map((e) => e.id)).toEqual(["evt-2", "evt-1"]),
    );
  });
});
