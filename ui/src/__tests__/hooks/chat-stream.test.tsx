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
import { __resetChatQueueStoreForTests } from "@/lib/chat-queue-store";

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
  // The queue lives in a module-level store now (so it survives the parent's
  // chat-switch remount), which means it also persists between tests unless
  // we reset it explicitly.
  __resetChatQueueStoreForTests();
});

describe("useChatStream — queue drain", () => {
  it("enqueueMessage appends to queuedMessages while a turn is already streaming", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

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

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

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

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

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
    // Hold serverBusy=true so the drain effect stays dormant and the queue
    // observably mirrors the enqueue order. (Without this gate the drain
    // pops every entry on the first idle render and the test can't
    // distinguish "removed" from "drained-and-streamed".)
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );

    let idA = "";
    let idB = "";
    let idC = "";
    act(() => {
      idA = result.current.enqueueMessage("c-1", { content: "A" });
      idB = result.current.enqueueMessage("c-1", { content: "B" });
      idC = result.current.enqueueMessage("c-1", { content: "C" });
    });

    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([idA, idB, idC]);

    act(() => {
      result.current.removeFromQueue(idB);
    });
    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([idA, idC]);
    // Removing a known id again is a silent no-op.
    act(() => {
      result.current.removeFromQueue(idB);
    });
    expect(result.current.queuedMessages.map((m) => m.id)).toEqual([idA, idC]);
  });
});

describe("useChatStream — regression: drain respects serverBusy (BUG #1)", () => {
  // Reproducer for the parallel-turn race that motivated this fix:
  //   1. SSE `done` arrives → isStreaming flips false.
  //   2. WS `session_ended` has not arrived yet → serverRunning still true.
  //   3. Old code (drain checked only `isStreaming`) popped the queue and
  //      called streamMessage again, opening a second concurrent turn on
  //      the same chat. The new gate is `!isStreaming && !serverBusy`, so
  //      the drain stays dormant until BOTH local fetch and the daemon
  //      report idle.
  it("does NOT drain while serverBusy is true even if isStreaming is false", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    // initialProps so the test can flip serverBusy mid-flight via rerender.
    const { result, rerender } = renderHook(
      ({ serverBusy }: { serverBusy: boolean }) =>
        useChatStream({ chatId: "c-1", serverBusy }),
      {
        wrapper: Wrapper,
        initialProps: { serverBusy: false },
      },
    );

    // Start a turn so the queue can be primed in a busy state.
    act(() => {
      void result.current.startStream("c-1", { content: "first" });
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    act(() => {
      result.current.enqueueMessage("c-1", { content: "queued" });
    });

    // Daemon flips serverBusy=true (e.g. WS session_started). User's local
    // SSE then completes — the BUG #1 window opens here.
    rerender({ serverBusy: true });
    const [ctrl0] = streamSpies.controllers;
    await act(async () => {
      pushSSE(ctrl0!, { done: true });
      ctrl0!.close();
    });

    // Wait long enough that any racing drain would have fired. The hook's
    // drain effect runs synchronously in render, so a `flushSync`-style
    // promise tick is enough to give it a chance.
    await act(async () => {
      await Promise.resolve();
    });

    // Critical assertion: streamMessage was NOT called a second time, the
    // queue still holds the entry.
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(result.current.queuedMessages).toHaveLength(1);

    // Now WS `session_ended` arrives — caller flips serverBusy back to false.
    rerender({ serverBusy: false });

    // Drain finally fires.
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(2);
    });
    expect(result.current.queuedMessages).toHaveLength(0);
  });
});

describe("useChatStream — regression: queue survives hook remount (BUG #2)", () => {
  // Before the fix, `queuedMessages` lived in a per-hook `useState`, so the
  // parent's `key={selectedChatId}` remount on every chat switch wiped any
  // pending prompts. The store-backed implementation keeps them in a
  // module-level map keyed by chatId, so a remount of the same chat sees the
  // same queue.
  it("queued messages persist when the hook is unmounted and remounted for the same chat", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    // First mount — start a turn, queue something, then unmount mid-flight
    // (matching the user navigating away while the agent is still working).
    const first = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );
    act(() => {
      first.result.current.enqueueMessage("c-1", { content: "queued-A" });
      first.result.current.enqueueMessage("c-1", { content: "queued-B" });
    });
    expect(first.result.current.queuedMessages).toHaveLength(2);

    first.unmount();

    // Remount under a fresh hook instance — the store should still hold the
    // two entries because they're keyed on chatId, not on the hook lifetime.
    const second = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );
    expect(second.result.current.queuedMessages.map((m) => m.data.content))
      .toEqual(["queued-A", "queued-B"]);
  });

  it("a different chatId sees an independent queue", () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const a = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );
    act(() => {
      a.result.current.enqueueMessage("c-1", { content: "in-c1" });
    });
    expect(a.result.current.queuedMessages).toHaveLength(1);

    const b = renderHook(
      () => useChatStream({ chatId: "c-2", serverBusy: true }),
      { wrapper: Wrapper },
    );
    // c-2's hook reads its own slot in the store — c-1's entry is invisible.
    expect(b.result.current.queuedMessages).toHaveLength(0);
  });
});

describe("useChatStream — regression: double-click guard (BUG #3)", () => {
  // Before the fix, a second `startStream` call in the same tick would race
  // the async `setIsStreaming(true)` from the first, hit the
  // `abortRef.current.abort()` branch, and silently drop the first prompt.
  // The fix flips `startingRef` synchronously at the top of `startStream`,
  // so a reentrant call routes the message into the queue instead of
  // aborting the in-flight start.
  it("two back-to-back startStream calls do NOT abort the first; second goes to queue", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    // Two calls, no awaits in between — exactly the double-click pattern
    // (also: the drain effect racing handleComposerSend on first paint).
    act(() => {
      void result.current.startStream("c-1", { content: "first" });
      void result.current.startStream("c-1", { content: "second" });
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    // streamMessage was called exactly once (the first call). The second
    // call hit the synchronous reentrancy guard and fell through to enqueue.
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    const [, firstBody] = streamSpies.streamMessage.mock.calls[0]!;
    expect((firstBody as { content: string }).content).toBe("first");

    // The second prompt is sitting in the queue waiting for the first to end.
    expect(result.current.queuedMessages).toHaveLength(1);
    expect(result.current.queuedMessages[0]!.data.content).toBe("second");

    // Finish the first stream — drain takes "second" off the queue and
    // sends it as the next turn.
    const [ctrl0] = streamSpies.controllers;
    await act(async () => {
      pushSSE(ctrl0!, { done: true });
      ctrl0!.close();
    });
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(2);
    });
    const [, secondBody] = streamSpies.streamMessage.mock.calls[1]!;
    expect((secondBody as { content: string }).content).toBe("second");
  });
});

describe("useChatStream — peek+remove pattern preserves entry on failure", () => {
  // Before this refactor the drain effect did `dequeueHead` synchronously
  // BEFORE calling `startStream`. If `streamMessage` then failed (5xx,
  // network blip, anything non-2xx), the entry was already gone from
  // the queue — silently dropping the user's prompt. The new pattern
  // peeks the head, calls `streamMessage`, and only removes from the
  // queue AFTER the server returned 2xx.

  it("REGRESSION: streamMessage non-ok response leaves the queued entry intact for retry", async () => {
    const { Wrapper } = wrap();
    // Server rejects with a 503 (transient). Body is null because the
    // response never opened a body for non-2xx.
    streamSpies.streamMessage.mockResolvedValue(
      { ok: false, status: 503, body: null } as unknown as Response,
    );

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.enqueueMessage("c-1", { content: "must-survive-failure" });
    });

    // Wait for the drain effect to finish its attempt.
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    });

    // Entry is STILL in the queue (failedHeadRef pinned, but queue intact)
    // — user can ✕→re-add to retry, or manually ⌘+Enter once the server
    // recovers and they switch chats and back.
    expect(result.current.queuedMessages).toHaveLength(1);
    expect(result.current.queuedMessages[0]!.data.content).toBe(
      "must-survive-failure",
    );
  });

  it("REGRESSION: streamMessage thrown error (network drop) leaves the entry intact", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.enqueueMessage("c-1", { content: "lossless" });
    });
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    });

    expect(result.current.queuedMessages).toHaveLength(1);
  });

  it("REGRESSION (infinite loop): a failed head is NOT re-attempted on the next render", async () => {
    // Without `failedHeadRef`, peek-without-remove would let the drain
    // effect re-fire on every render that touches `queuedMessages` —
    // and since the entry stays at the head, the same prompt would be
    // re-sent indefinitely. This test pins the guard.
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockResolvedValue(
      { ok: false, status: 503, body: null } as unknown as Response,
    );

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.enqueueMessage("c-1", { content: "no-replay" });
    });
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    });

    // Trigger any number of re-renders by enqueueing new entries. The
    // failed head MUST NOT re-fire, but a fresh head SHOULD on the
    // user's manual Send (which happens through enqueue here only as a
    // simulation of cache change).
    for (let i = 0; i < 5; i++) {
      // Force a re-render by adding & removing an entry — the queue
      // array reference changes, drain effect re-runs.
      let id = "";
      act(() => {
        id = result.current.enqueueMessage("c-1", { content: `noise-${i}` });
      });
      act(() => {
        result.current.removeFromQueue(id);
      });
    }

    // Still exactly one streamMessage call — the failed head did not
    // get re-tried.
    expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(result.current.queuedMessages).toHaveLength(1);
  });

  it("REGRESSION: clearing the failed head and adding a new one DOES drain the new head", async () => {
    // The flip side of the loop guard: once the user clears the failed
    // entry (via ✕), the next head must be a fresh attempt. The
    // failedHeadRef compares ids, so a new head id resets the gate.
    const { Wrapper } = wrap();
    let attempt = 0;
    streamSpies.streamMessage.mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(
          { ok: false, status: 503, body: null } as unknown as Response,
        );
      }
      return Promise.resolve(makeStreamResponse());
    });

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    let firstId = "";
    act(() => {
      firstId = result.current.enqueueMessage("c-1", { content: "fail" });
    });
    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    });
    expect(result.current.queuedMessages).toHaveLength(1);

    // User ✕-removes the failed head. Now add a fresh entry — it
    // should drain.
    act(() => {
      result.current.removeFromQueue(firstId);
      result.current.enqueueMessage("c-1", { content: "succeed" });
    });

    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(2);
    });
    // Drain the body so the test cleans up cleanly.
    const ctrl = streamSpies.controllers[streamSpies.controllers.length - 1];
    await act(async () => {
      pushSSE(ctrl!, { done: true });
      ctrl!.close();
    });
    await waitFor(() => {
      expect(result.current.queuedMessages).toHaveLength(0);
    });
  });

  it("successful streamMessage removes the queued entry (head pattern)", async () => {
    // Forward-positive test: when streamMessage returns 2xx, the entry
    // must be removed from the queue. Mirrors the runner's contract
    // (server accepted → queue dequeue, body drain after).
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1" }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.enqueueMessage("c-1", { content: "happy-path" });
    });

    await waitFor(() => {
      expect(streamSpies.streamMessage).toHaveBeenCalledTimes(1);
    });
    // Body still open — entry should already be gone (removed at the
    // moment of `res.ok` check, BEFORE the body drains).
    expect(result.current.queuedMessages).toHaveLength(0);

    // Tidy up.
    const ctrl = streamSpies.controllers[0];
    await act(async () => {
      pushSSE(ctrl!, { done: true });
      ctrl!.close();
    });
  });
});

describe("useChatStream — clearQueue (BUG #5)", () => {
  // The hook always exported `clearQueue`, but no UI hook called it before
  // the fix. The new chat-conversation "Clear all" button wires it up; this
  // test pins the behaviour at the hook layer regardless of where the call
  // comes from.
  it("clearQueue empties the current chat's queue", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const { result } = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.enqueueMessage("c-1", { content: "A" });
      result.current.enqueueMessage("c-1", { content: "B" });
      result.current.enqueueMessage("c-1", { content: "C" });
    });
    expect(result.current.queuedMessages).toHaveLength(3);

    act(() => {
      result.current.clearQueue();
    });
    expect(result.current.queuedMessages).toHaveLength(0);
  });

  it("clearQueue only touches the current chat — other chats keep their entries", async () => {
    const { Wrapper } = wrap();
    streamSpies.streamMessage.mockImplementation(() => makeStreamResponse());

    const a = renderHook(
      () => useChatStream({ chatId: "c-1", serverBusy: true }),
      { wrapper: Wrapper },
    );
    const b = renderHook(
      () => useChatStream({ chatId: "c-2", serverBusy: true }),
      { wrapper: Wrapper },
    );

    act(() => {
      a.result.current.enqueueMessage("c-1", { content: "in-c1" });
      b.result.current.enqueueMessage("c-2", { content: "in-c2" });
    });
    expect(a.result.current.queuedMessages).toHaveLength(1);
    expect(b.result.current.queuedMessages).toHaveLength(1);

    act(() => {
      a.result.current.clearQueue();
    });
    expect(a.result.current.queuedMessages).toHaveLength(0);
    expect(b.result.current.queuedMessages).toHaveLength(1);
  });
});
