import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Stub the network layer. `streamMessage` returns a controllable
// ReadableStream so each test can drive "SSE arrives" / "SSE finishes"
// deterministically rather than racing a real fetch.
const streamSpies: {
  streamMessage: ReturnType<typeof vi.fn>;
  cancelChatRun: ReturnType<typeof vi.fn>;
  controllers: ReadableStreamDefaultController<Uint8Array>[];
} = {
  streamMessage: vi.fn(),
  cancelChatRun: vi.fn(),
  controllers: [],
};

vi.mock("@/lib/api", () => ({
  streamMessage: (...args: unknown[]) =>
    (streamSpies.streamMessage as unknown as (...a: unknown[]) => unknown)(...args),
  cancelChatRun: (...args: unknown[]) =>
    (streamSpies.cancelChatRun as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { useChatStream } from "@/lib/hooks/chat-stream";

function makeStreamResponse() {
  // Each call produces a fresh controllable stream so we can push SSE lines
  // and close it from the test. The hook reads via
  // `res.body.getReader().read()` so we just plug this into `res.body`.
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  streamSpies.controllers.push(ctrl);
  return {
    ok: true,
    status: 200,
    body,
  } as unknown as Response;
}

function pushSSE(ctrl: ReadableStreamDefaultController<Uint8Array>, obj: unknown) {
  const enc = new TextEncoder();
  ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n`));
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
  streamSpies.streamMessage.mockReset();
  streamSpies.cancelChatRun.mockReset();
  // `cancelChatRun` is fire-and-forget but the hook calls `.catch` on its
  // return value — default to a resolved promise so tests that invoke
  // `cancelStream` don't trip `TypeError: undefined.catch`.
  streamSpies.cancelChatRun.mockResolvedValue(undefined);
  streamSpies.controllers = [];
});

describe("useChatStream — queue drain", () => {
  it("enqueueMessage appends to queuedMessages while a turn is already streaming", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });

    // Start a turn so isStreaming flips true and the drain effect stays
    // dormant. enqueueing against a busy stream is the path the UI actually
    // hits — empty-queue-while-idle would drain immediately, which is tested
    // by the auto-drain case below.
    act(() => {
      void result.current.startStream("c-1", { content: "first" });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.enqueueMessage("c-1", { content: "follow-up" });
    });

    expect(result.current.queuedMessages).toHaveLength(1);
    expect(result.current.queuedMessages[0]!.data.content).toBe("follow-up");
    // The queued entry does NOT call the network itself — drain only fires
    // once the current turn ends.
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
  });

  it("auto-drains the next queued message after the current turn finishes", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });

    // Kick off the first stream directly so we own the controller.
    act(() => {
      void result.current.startStream("c-1", { content: "first" });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);

    // Queue a follow-up while the first stream is still open.
    act(() => {
      result.current.enqueueMessage("c-1", { content: "second" });
    });
    expect(result.current.queuedMessages).toHaveLength(1);
    // Only the first stream is in flight so far.
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);

    // Finish the first stream: push `done` and close.
    const [ctrl0] = streamSpies.controllers;
    await act(async () => {
      pushSSE(ctrl0!, { done: true });
      ctrl0!.close();
    });

    // Drain effect fires once isStreaming flips back to false, popping the
    // queued item and calling streamMessage a second time with its payload.
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(2);
    });
    expect(result.current.queuedMessages).toHaveLength(0);
    const [, secondBody] = streamSpies.streamMessage.mock.calls[1]!;
    expect((secondBody as { content: string }).content).toBe("second");
  });

  it("cancelStream does not clear the queue — Esc aborts the current turn only", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });

    act(() => {
      void result.current.startStream("c-1", { content: "first" });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    act(() => {
      result.current.enqueueMessage("c-1", { content: "queued-A" });
      result.current.enqueueMessage("c-1", { content: "queued-B" });
    });
    expect(result.current.queuedMessages).toHaveLength(2);

    // User presses Stop. The fetch is aborted AND the backend is told to
    // cancel the session. Our mock body is not wired to the AbortSignal, so
    // we also close the controller to simulate the server side dropping the
    // stream — that matches real fetch semantics: abort closes the body
    // reader, the hook's loop breaks, and `finally` runs.
    const [ctrl0] = streamSpies.controllers;
    await act(async () => {
      result.current.cancelStream("c-1");
      ctrl0!.close();
    });

    // Backend cancel was dispatched with the current chat.
    expect(streamSpies.cancelChatRun).toHaveBeenCalledWith("c-1");

    // Drain picks up the next item (queued-A), but queued-B remains in the
    // queue waiting for the subsequent turn to end.
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(2);
    });
    const contents = result.current.queuedMessages.map((m) => m.data.content);
    expect(contents).toEqual(["queued-B"]);
  });

  it("removeFromQueue drops a specific entry without touching the rest", () => {
    const { Wrapper } = wrap();
    // streamMessage is not needed — we never start a stream here, but the
    // mount-time drain effect will try to dequeue the first entry the moment
    // we enqueue. We stub the response as an immediately-closed stream so
    // the drain doesn't throw.
    streamSpies.streamMessage.mockImplementation(() => {
      const res = makeStreamResponse();
      // Close immediately so the reader loop exits without processing events.
      const ctrl = streamSpies.controllers[streamSpies.controllers.length - 1];
      ctrl!.close();
      return res;
    });

    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });

    let idA = "";
    let idB = "";
    let idC = "";
    act(() => {
      idA = result.current.enqueueMessage("c-1", { content: "A" });
      idB = result.current.enqueueMessage("c-1", { content: "B" });
      idC = result.current.enqueueMessage("c-1", { content: "C" });
    });

    // The drain effect pops the head (idA) automatically. B and C remain.
    expect(
      result.current.queuedMessages.map((m) => m.id),
    ).toEqual([idB, idC]);

    act(() => {
      result.current.removeFromQueue(idB);
    });
    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([idC]);
    // idA was never explicitly in the queue after drain, so removing it is
    // a no-op that keeps idC intact.
    act(() => {
      result.current.removeFromQueue(idA);
    });
    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([idC]);
  });
});
