import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Capture the onMessage callback wired up by `useGlobalWs` so tests can
// dispatch simulated WS frames without spinning up a real socket.
type OnMessage = (msg: { type: string; payload: unknown }) => void;
const wsSpies: { lastOnMessage: OnMessage | null } = { lastOnMessage: null };

// Replace the WebSocket layer wholesale — a unit test has no business
// opening real sockets, and the shared `useWebSocket` hook creates a
// reconnecting WebSocket in a useEffect on mount.
vi.mock("@/lib/ws", () => ({
  useWebSocket: ({ onMessage }: { onMessage?: OnMessage }) => {
    wsSpies.lastOnMessage = onMessage ?? null;
    return { state: "open", send: vi.fn() };
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
import { useAttention } from "@/lib/hooks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

beforeEach(() => {
  wsSpies.lastOnMessage = null;
});

describe("useAttention", () => {
  it("exposes total: 0 when the initial fetch returns an empty list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAttention(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.total).toBe(0);
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("/attention");
  });

  it("refetches when an `attention_changed` WS message arrives", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], total: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "t1",
              kind: "task_approval",
              title: "Approve task",
              projectId: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          total: 1,
        }),
      );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAttention(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.total).toBe(0));
    expect(typeof wsSpies.lastOnMessage).toBe("function");

    act(() => {
      wsSpies.lastOnMessage!({ type: "attention_changed", payload: {} });
    });

    await waitFor(() => expect(result.current.total).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Irrelevant WS frames must not trigger extra fetches.
    act(() => {
      wsSpies.lastOnMessage!({ type: "log_line", payload: {} });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the error without crashing when the request fails", async () => {
    (globalThis as any).fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "attention unavailable" }, 500),
      );

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAttention(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.total).toBe(0);
    expect(result.current.items).toEqual([]);
    expect((result.current.error as Error).message).toContain(
      "attention unavailable",
    );
  });
});
