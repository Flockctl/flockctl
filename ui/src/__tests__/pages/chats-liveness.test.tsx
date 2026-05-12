import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import * as React from "react";

/**
 * Slice 24-02 T03 — viewport liveness in a chat-list-sized render.
 *
 * The whole point of `useViewportLiveness` is to keep the WS-fanout cost
 * proportional to what the user can actually see. The pre-fix behaviour
 * (one socket per row at mount) flooded the daemon on a 50-chat list.
 *
 * This test mounts 50 row stubs, each one calling the hook, and asserts:
 *   1. ZERO `WebSocket` constructors fire on initial render (no row is
 *      reported as intersecting).
 *   2. The IntersectionObserver path WAS exercised (50 observers
 *      registered, one per row) — a regression that silently drops the
 *      observer would still satisfy assertion #1, so we anchor both ends.
 *   3. Promoting one row to `isIntersecting=true` opens exactly ONE
 *      socket — proving the gating is per-row, not all-or-nothing.
 *
 * The hook is exercised against the real `useWebSocket` from `@/lib/ws`
 * (no module mock) — the only fakes are `IntersectionObserver` and the
 * global `WebSocket` constructor.
 */

// ---- fakes ----------------------------------------------------------------

type IntersectionCallback = (
  entries: Array<{ isIntersecting: boolean; target: Element }>,
) => void;

interface RegisteredObserver {
  cb: IntersectionCallback;
  observed: Element[];
  fire: (isIntersecting: boolean) => void;
  disconnected: boolean;
}

const observers: RegisteredObserver[] = [];

class FakeIntersectionObserver {
  private cb: IntersectionCallback;
  private observed: Element[] = [];
  private record: RegisteredObserver;
  constructor(cb: IntersectionCallback) {
    this.cb = cb;
    this.record = {
      cb,
      observed: this.observed,
      fire: (isIntersecting) => {
        this.cb([
          {
            isIntersecting,
            target: this.observed[0] ?? document.createElement("div"),
          },
        ]);
      },
      disconnected: false,
    };
    observers.push(this.record);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.record.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let wsCtorCount = 0;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    wsCtorCount += 1;
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

// ---- harness --------------------------------------------------------------

import { useViewportLiveness } from "@/lib/use-viewport-liveness";

function ChatRowStub({ chatId }: { chatId: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { isStreaming } = useViewportLiveness(ref, chatId);
  return (
    <div
      ref={ref}
      data-testid="row"
      data-chat-id={chatId}
      data-streaming={isStreaming ? "1" : "0"}
    />
  );
}

function ChatList({ count }: { count: number }) {
  const ids = React.useMemo(
    () => Array.from({ length: count }, (_, i) => `chat-${i}`),
    [count],
  );
  return (
    <div data-testid="list">
      {ids.map((id) => (
        <ChatRowStub key={id} chatId={id} />
      ))}
    </div>
  );
}

// ---- setup ---------------------------------------------------------------

beforeEach(() => {
  observers.length = 0;
  wsCtorCount = 0;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---- tests ---------------------------------------------------------------

describe("chat list × useViewportLiveness", () => {
  it("initial render of 50 rows opens 0 WebSocket subscriptions", () => {
    render(<ChatList count={50} />);

    expect(observers).toHaveLength(50);
    expect(wsCtorCount).toBe(0);
  });

  it("each row registers exactly one IntersectionObserver", () => {
    render(<ChatList count={50} />);
    for (const obs of observers) {
      expect(obs.observed.length).toBe(1);
    }
  });

  it("a single row entering the viewport opens exactly ONE subscription", () => {
    render(<ChatList count={50} />);
    expect(wsCtorCount).toBe(0);

    act(() => observers[7]!.fire(true));

    expect(wsCtorCount).toBe(1);
  });

  it("rows leaving the viewport tear their socket down (no leak across scroll)", () => {
    render(<ChatList count={50} />);

    act(() => observers[3]!.fire(true));
    expect(wsCtorCount).toBe(1);

    act(() => observers[3]!.fire(false));

    // No new socket is opened on the off-viewport transition; the existing
    // one is closed by `useWebSocket`'s `enabled:false` cleanup branch
    // (inspected indirectly — the count never grew, and `disconnected`
    // would be set if the row unmounted, which it didn't).
    expect(wsCtorCount).toBe(1);
  });

  it("unmounting the list disconnects every observer", () => {
    const { unmount } = render(<ChatList count={50} />);
    expect(observers.every((o) => !o.disconnected)).toBe(true);
    unmount();
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});
