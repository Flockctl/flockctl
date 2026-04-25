import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Capture the onMessage callback wired up by `useWebSocket` so tests can
// dispatch simulated WS frames without spinning up a real socket.
type OnMessage = (msg: { type: string; payload: unknown; chatId?: string }) => void;
const wsSpies: { lastOnMessage: OnMessage | null } = { lastOnMessage: null };

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

// The hook hydrates pending permissions on mount — stub to resolve empty so
// the test doesn't race against a real fetch.
vi.mock("@/lib/api", () => ({
  fetchChatPendingPermissions: vi.fn().mockResolvedValue({ items: [] }),
}));

import { useChatEventStream } from "@/lib/hooks/chat-events";
import { queryKeys } from "@/lib/hooks/core";

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

describe("useChatEventStream — variant B WS handlers", () => {
  it("drops a pending permission card when `permission_resolved` arrives", () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatEventStream("c1"), {
      wrapper: Wrapper,
    });

    // Seed a pending request via the permission_request branch first.
    act(() => {
      wsSpies.lastOnMessage!({
        type: "permission_request",
        chatId: "c1",
        payload: {
          request_id: "r1",
          tool_name: "Edit",
          tool_input: {},
          tool_use_id: "tu1",
        },
      });
    });
    expect(result.current.permissionRequests).toHaveLength(1);
    expect(result.current.permissionRequests[0]!.request_id).toBe("r1");

    // Now the auto-resolve broadcast arrives.
    act(() => {
      wsSpies.lastOnMessage!({
        type: "permission_resolved",
        chatId: "c1",
        payload: { request_id: "r1", decision: "allow" },
      });
    });
    expect(result.current.permissionRequests).toHaveLength(0);
  });

  it("ignores `permission_resolved` for a request we never saw", () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatEventStream("c1"), {
      wrapper: Wrapper,
    });

    act(() => {
      wsSpies.lastOnMessage!({
        type: "permission_request",
        chatId: "c1",
        payload: {
          request_id: "r1",
          tool_name: "Edit",
          tool_input: {},
          tool_use_id: "tu1",
        },
      });
      wsSpies.lastOnMessage!({
        type: "permission_resolved",
        chatId: "c1",
        payload: { request_id: "r-other", decision: "allow" },
      });
    });
    // r1 stays, r-other is a no-op.
    expect(result.current.permissionRequests.map((r) => r.request_id)).toEqual([
      "r1",
    ]);
  });

  it("patches the cached chat's `permission_mode` on `chat_permission_mode_changed`", () => {
    const { qc, Wrapper } = wrap();
    qc.setQueryData(queryKeys.chat("c1"), {
      id: "c1",
      permission_mode: "default",
      messages: [],
    });

    renderHook(() => useChatEventStream("c1"), { wrapper: Wrapper });

    act(() => {
      wsSpies.lastOnMessage!({
        type: "chat_permission_mode_changed",
        chatId: "c1",
        payload: {
          chat_id: "c1",
          previous: "default",
          current: "bypassPermissions",
        },
      });
    });

    const cached = qc.getQueryData<{ permission_mode: string }>(
      queryKeys.chat("c1"),
    );
    expect(cached?.permission_mode).toBe("bypassPermissions");
  });

  it("does not create a cache entry if none existed when mode change fires", () => {
    const { qc, Wrapper } = wrap();
    renderHook(() => useChatEventStream("c1"), { wrapper: Wrapper });

    act(() => {
      wsSpies.lastOnMessage!({
        type: "chat_permission_mode_changed",
        chatId: "c1",
        payload: {
          chat_id: "c1",
          previous: "default",
          current: "bypassPermissions",
        },
      });
    });

    // The updater returns `prev` unchanged when prev is undefined — the
    // cache should remain empty rather than materialize a partial object.
    expect(qc.getQueryData(queryKeys.chat("c1"))).toBeUndefined();
  });

  it("filters out WS frames whose `chatId` does not match the subscribed chat", () => {
    const { qc, Wrapper } = wrap();
    qc.setQueryData(queryKeys.chat("c1"), {
      id: "c1",
      permission_mode: "default",
      messages: [],
    });

    const { result } = renderHook(() => useChatEventStream("c1"), {
      wrapper: Wrapper,
    });

    act(() => {
      // Cross-chat frame — must be ignored even if the type is handled.
      wsSpies.lastOnMessage!({
        type: "chat_permission_mode_changed",
        chatId: "c-other",
        payload: {
          chat_id: "c-other",
          previous: "default",
          current: "bypassPermissions",
        },
      });
      wsSpies.lastOnMessage!({
        type: "permission_resolved",
        chatId: "c-other",
        payload: { request_id: "r1", decision: "allow" },
      });
    });

    expect(result.current.permissionRequests).toHaveLength(0);
    expect(
      qc.getQueryData<{ permission_mode: string }>(queryKeys.chat("c1"))
        ?.permission_mode,
    ).toBe("default");
  });
});
