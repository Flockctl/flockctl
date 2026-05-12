import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";

/**
 * Slice 24-02 T03 — `useViewportLiveness` contract pins.
 *
 * Verifies:
 *   - Hook signature `(rowRef, chatId) => { isStreaming }` and initial value.
 *   - IntersectionObserver is constructed with `threshold: 0` and observes
 *     the ref's element.
 *   - WS subscription is gated on visibility:
 *       * not visible → `useWebSocket` invoked with `enabled: false`,
 *       * visible → `useWebSocket` invoked with `enabled: true`.
 *   - `session_started` / `session_ended` frames flip `isStreaming`.
 *   - Off-viewport resets `isStreaming` to false.
 *   - Unmount disconnects the observer.
 */

// ---- mocks ----------------------------------------------------------------

type IntersectionCallback = (
  entries: Array<{ isIntersecting: boolean; target: Element }>,
) => void;

interface FakeObserver {
  callback: IntersectionCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnected: boolean;
  fire: (isIntersecting: boolean) => void;
}

const observerInstances: FakeObserver[] = [];

class FakeIntersectionObserver {
  callback: IntersectionCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionCallback, opts?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = opts;
    observerInstances.push({
      callback: cb,
      options: opts,
      observed: this.observed,
      disconnected: false,
      fire: (isIntersecting: boolean) => {
        this.callback([
          {
            isIntersecting,
            target: this.observed[0] ?? document.createElement("div"),
          },
        ]);
      },
    });
    // Mirror disconnected onto the last entry on disconnect (see below).
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
    const last = observerInstances[observerInstances.length - 1];
    if (last) last.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// `useWebSocket` is captured via a vi.mock so we can assert the `enabled`
// flag flips with viewport visibility AND drive `onMessage` ourselves
// without spinning up a real socket.
type WSCall = {
  path: string;
  enabled: boolean | undefined;
  onMessage: ((msg: { type: string; chatId?: string }) => void) | undefined;
};
const wsCalls: WSCall[] = [];

vi.mock("@/lib/ws", () => ({
  useWebSocket: (opts: WSCall) => {
    wsCalls.push(opts);
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

// Import AFTER the mock so the module under test resolves to the stub.
import { useViewportLiveness } from "@/lib/use-viewport-liveness";

// ---- setup ---------------------------------------------------------------

beforeEach(() => {
  observerInstances.length = 0;
  wsCalls.length = 0;
  // Install the fake observer on `window`/`globalThis` BEFORE each test.
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  vi.clearAllMocks();
});

// Helper: build a ref object pre-populated with a real DOM element so
// the IntersectionObserver effect actually invokes `observe`.
function refWithElement() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ref = createRef<HTMLDivElement>();
  // ref.current is read-only at the type level; cast through `unknown` to
  // pre-populate it so the IntersectionObserver effect has an element to
  // observe on first render.
  (ref as unknown as { current: HTMLDivElement }).current = el;
  return { ref, el };
}

// ---- tests ---------------------------------------------------------------

describe("useViewportLiveness", () => {
  it("exposes { isStreaming: false } before any intersection event fires", () => {
    const { ref } = refWithElement();
    const { result } = renderHook(() =>
      useViewportLiveness(ref, "chat-1"),
    );

    expect(result.current).toEqual({ isStreaming: false });
  });

  it("constructs an IntersectionObserver with threshold:0 and observes the ref's element", () => {
    const { ref, el } = refWithElement();
    renderHook(() => useViewportLiveness(ref, "chat-1"));

    expect(observerInstances).toHaveLength(1);
    const obs = observerInstances[0]!;
    expect(obs.options).toEqual({ threshold: 0 });
    expect(obs.observed).toEqual([el]);
  });

  it("does NOT open a WS subscription before the row enters the viewport", () => {
    const { ref } = refWithElement();
    renderHook(() => useViewportLiveness(ref, "chat-1"));

    // useWebSocket is still called (it's a hook), but with enabled:false
    // — no socket is constructed in that branch.
    expect(wsCalls.length).toBeGreaterThan(0);
    const last = wsCalls[wsCalls.length - 1]!;
    expect(last.enabled).toBe(false);
  });

  it("opens the per-chat WS subscription when the row enters the viewport", () => {
    const { ref } = refWithElement();
    renderHook(() => useViewportLiveness(ref, "chat-42"));

    act(() => {
      observerInstances[0]!.fire(true);
    });

    const last = wsCalls[wsCalls.length - 1]!;
    expect(last.enabled).toBe(true);
    expect(last.path).toBe("/ws/ui/chats/chat-42/events");
  });

  it("closes the subscription when the row leaves the viewport", () => {
    const { ref } = refWithElement();
    renderHook(() => useViewportLiveness(ref, "chat-42"));

    act(() => observerInstances[0]!.fire(true));
    expect(wsCalls[wsCalls.length - 1]!.enabled).toBe(true);

    act(() => observerInstances[0]!.fire(false));
    expect(wsCalls[wsCalls.length - 1]!.enabled).toBe(false);
  });

  it("flips isStreaming on session_started / session_ended frames while visible", () => {
    const { ref } = refWithElement();
    const { result } = renderHook(() =>
      useViewportLiveness(ref, "chat-42"),
    );

    act(() => observerInstances[0]!.fire(true));

    // Most recent useWebSocket call's onMessage is the live handler.
    const send = (frame: { type: string; chatId?: string }) =>
      wsCalls[wsCalls.length - 1]!.onMessage?.(frame);

    act(() => send({ type: "session_started", chatId: "chat-42" }));
    expect(result.current.isStreaming).toBe(true);

    act(() => send({ type: "session_ended", chatId: "chat-42" }));
    expect(result.current.isStreaming).toBe(false);
  });

  it("ignores frames for a different chatId (cross-chat fanout safety)", () => {
    const { ref } = refWithElement();
    const { result } = renderHook(() =>
      useViewportLiveness(ref, "chat-42"),
    );

    act(() => observerInstances[0]!.fire(true));
    act(() =>
      wsCalls[wsCalls.length - 1]!.onMessage?.({
        type: "session_started",
        chatId: "chat-999",
      }),
    );

    expect(result.current.isStreaming).toBe(false);
  });

  it("resets isStreaming when the row scrolls off-viewport", () => {
    const { ref } = refWithElement();
    const { result } = renderHook(() =>
      useViewportLiveness(ref, "chat-42"),
    );

    act(() => observerInstances[0]!.fire(true));
    act(() =>
      wsCalls[wsCalls.length - 1]!.onMessage?.({
        type: "session_started",
        chatId: "chat-42",
      }),
    );
    expect(result.current.isStreaming).toBe(true);

    act(() => observerInstances[0]!.fire(false));
    expect(result.current.isStreaming).toBe(false);
  });

  it("disconnects the observer on unmount", () => {
    const { ref } = refWithElement();
    const { unmount } = renderHook(() =>
      useViewportLiveness(ref, "chat-42"),
    );

    expect(observerInstances[0]!.disconnected).toBe(false);
    unmount();
    expect(observerInstances[0]!.disconnected).toBe(true);
  });
});
