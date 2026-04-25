import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket, WebSocketClient, ConnectionState } from "@/lib/ws";
import {
  setActiveServerId,
  setServerMap,
  LOCAL_SERVER_ID,
} from "@/lib/server-store";

/**
 * Unit coverage for the server-switch + WS-reconnect contract. Two pieces
 * of behavior are exercised:
 *
 *   1. `WebSocketClient` closes its underlying socket on `close()` and does
 *      NOT schedule a reconnect after `close()` (the disposed flag wins).
 *   2. `useWebSocket` subscribes to `subscribeActiveServerId` via
 *      `useSyncExternalStore`, so calling `setActiveServerId(...)` from
 *      anywhere tears down the current socket (pointed at the old server)
 *      and opens a fresh one against the new loopback tunnel URL. No token
 *      is ever appended — the SSH tunnel terminates at the remote daemon's
 *      loopback interface, which does not require HTTP auth.
 *
 * A minimal `WebSocket` stub is installed on `globalThis` so jsdom can
 * host the hook without a real network.
 */

class StubSocket {
  static instances: StubSocket[] = [];
  url: string;
  readyState: number = 0; // CONNECTING
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    StubSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    // Mirror real WebSocket: fire onclose synchronously for tests.
    this.onclose?.(new CloseEvent("close"));
  }

  send(_data: string): void {
    /* noop */
  }

  // Helpers for tests — not part of the DOM contract.
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
}

// Guarantee a functional localStorage regardless of what other test files
// in the same Vitest worker may have done to the global (server-store.test.ts
// swaps in a stub and can leak into shared workers).
function installLocalStorage() {
  const store: Record<string, string> = {};
  const stub = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  StubSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof StubSocket }).WebSocket = StubSocket;
  installLocalStorage();
  setServerMap([]);
});

afterEach(() => {
  // Reset active server to local so leaking state doesn't affect other suites.
  setActiveServerId(LOCAL_SERVER_ID);
});

describe("WebSocketClient", () => {
  it("opens a socket on connect() with the provided URL", () => {
    const client = new WebSocketClient({ url: "ws://x/y", reconnect: false });
    client.connect();
    expect(StubSocket.instances).toHaveLength(1);
    expect(StubSocket.instances[0]!.url).toBe("ws://x/y");
    expect(client.state).toBe(ConnectionState.CONNECTING);
  });

  it("close() closes the socket and marks the client disposed (no reconnect)", () => {
    const client = new WebSocketClient({
      url: "ws://x/y",
      reconnect: true,
      reconnectDelay: 10,
    });
    client.connect();
    const first = StubSocket.instances[0]!;

    client.close();
    expect(first.closed).toBe(true);
    expect(client.state).toBe(ConnectionState.CLOSED);

    // Simulate the onclose firing after dispose — should NOT schedule a new
    // socket because `disposed` is set.
    first.onclose?.(new CloseEvent("close"));
    expect(StubSocket.instances).toHaveLength(1);
  });

  it("transitions to OPEN when the socket opens", () => {
    const client = new WebSocketClient({ url: "ws://x/y", reconnect: false });
    client.connect();
    StubSocket.instances[0]!.simulateOpen();
    expect(client.state).toBe(ConnectionState.OPEN);
    client.close();
  });
});

describe("useWebSocket reconnects on active-server change", () => {
  it("tears down the old socket and opens a new one when the active server changes", async () => {
    // Start with local server — loopback address, no auth query string.
    setActiveServerId(LOCAL_SERVER_ID);
    // Pre-register the remote's tunnel port so getApiBaseUrl()/getWsBaseUrl()
    // can assemble http://127.0.0.1:<port> / ws://127.0.0.1:<port> once the
    // active-server subscription fires.
    setServerMap([{ id: "remote-1", tunnelPort: 48321 }]);

    const { unmount } = renderHook(() =>
      useWebSocket({ path: "/ws/worker", enabled: true, reconnect: false }),
    );

    expect(StubSocket.instances).toHaveLength(1);
    const firstUrl = StubSocket.instances[0]!.url;
    expect(firstUrl).toMatch(/\/ws\/worker$/);
    expect(firstUrl).not.toContain("token=");

    // Switch to the remote server. The hook must close the old socket and
    // open a new one bound to the tunnel's loopback port. No token query
    // string — the tunnel is transparent to HTTP/WS auth.
    await act(async () => {
      setActiveServerId("remote-1");
    });

    expect(StubSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(StubSocket.instances[0]!.closed).toBe(true);
    const lastUrl = StubSocket.instances.at(-1)!.url;
    expect(lastUrl).toBe("ws://127.0.0.1:48321/ws/worker");
    expect(lastUrl).not.toContain("token=");

    unmount();
  });

  it("closes the socket and does not reopen when enabled flips to false", () => {
    setActiveServerId(LOCAL_SERVER_ID);

    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useWebSocket({ path: "/ws/worker", enabled, reconnect: false }),
      { initialProps: { enabled: true } },
    );

    expect(StubSocket.instances).toHaveLength(1);
    const first = StubSocket.instances[0]!;

    rerender({ enabled: false });
    expect(first.closed).toBe(true);
    // No extra socket opened while disabled.
    expect(StubSocket.instances).toHaveLength(1);

    unmount();
  });
});
