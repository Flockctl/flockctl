import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// API surface the runner depends on. Stubbed at the module level so each
// test can drive every code path deterministically; the runner's own
// `setInterval` safety-net is unaffected (we only use `tick` directly,
// invoked from inside an `act`-equivalent flush).
const apiSpies: {
  streamMessage: ReturnType<typeof vi.fn>;
  fetchChat: ReturnType<typeof vi.fn>;
  cancelChatRun: ReturnType<typeof vi.fn>;
} = {
  streamMessage: vi.fn(),
  fetchChat: vi.fn(),
  cancelChatRun: vi.fn(),
};

vi.mock("@/lib/api", () => ({
  streamMessage: (...args: unknown[]) =>
    (apiSpies.streamMessage as unknown as (...a: unknown[]) => unknown)(...args),
  fetchChat: (...args: unknown[]) =>
    (apiSpies.fetchChat as unknown as (...a: unknown[]) => unknown)(...args),
  cancelChatRun: (...args: unknown[]) =>
    (apiSpies.cancelChatRun as unknown as (...a: unknown[]) => unknown)(...args),
}));

import {
  enqueueMessage,
  getQueue,
  registerActiveChat,
  __resetChatQueueStoreForTests,
} from "@/lib/chat-queue-store";
import {
  startChatQueueRunner,
  __resetChatQueueRunnerForTests,
  __tickChatQueueRunnerForTests,
} from "@/lib/chat-queue-runner";
import { queryKeys } from "@/lib/hooks/core";
import type { ChatDetailResponse } from "@/lib/types";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function fakeChat(chatId: string, isRunning: boolean): ChatDetailResponse {
  return {
    id: chatId,
    project_id: null,
    workspace_id: null,
    title: `Chat ${chatId}`,
    permission_mode: null,
    model: null,
    ai_provider_key_id: null,
    is_running: isRunning,
    thinking_enabled: true,
    effort: null,
    messages: [],
    created_at: "2026-04-22T00:00:00Z",
    updated_at: "2026-04-22T00:00:00Z",
  } as unknown as ChatDetailResponse;
}

/**
 * Build a Response-like object with a controllable SSE body so we can
 * resolve `streamMessage` immediately AND let the runner's `drainBody`
 * complete in the same microtask. Without close()-ing the controller
 * the runner would await `reader.read()` forever.
 */
function makeStreamOk(): Response {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      // Close on next microtask so the runner sees `done=true` immediately.
      queueMicrotask(() => ctrl.close());
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

beforeEach(() => {
  apiSpies.streamMessage.mockReset();
  apiSpies.fetchChat.mockReset();
  __resetChatQueueStoreForTests();
  __resetChatQueueRunnerForTests();
});

afterEach(() => {
  __resetChatQueueRunnerForTests();
});

describe("chat-queue-runner — drains background queues", () => {
  it("sends the head of an inactive chat's queue and removes it on success", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "background-prompt" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    const [calledChatId, body] = apiSpies.streamMessage.mock.calls[0]!;
    expect(calledChatId).toBe("c-1");
    expect((body as { content: string }).content).toBe("background-prompt");
    // Entry was removed from the queue only after the server returned 2xx.
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("SKIPS chats that have a mounted hook (the hook drains itself)", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    // Simulate `useChatStream` for c-1 mounted on screen.
    const release = registerActiveChat("c-1");

    enqueueMessage("c-1", { content: "hands-off" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    // Runner stayed out of the way — entry is still queued for the hook.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    expect(getQueue("c-1")).toHaveLength(1);

    // After the hook unmounts, the runner takes over.
    release();
    await __tickChatQueueRunnerForTests();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("SKIPS chats whose is_running flag is true in cache (after re-verify confirms)", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    // Re-verify path: a cached `is_running=true` is NOT trusted on its
    // own — the runner re-fetches to confirm, because the most common
    // cause of cached `true` is `useChatStream`'s optimistic update which
    // is never flipped back to `false` if the user navigated away
    // before `session_ended` arrived (the WS handler that flips it
    // unmounts with the chat-events hook). The fresh GET tells the
    // truth: server-side, the turn is still running.
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, true),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", true));

    enqueueMessage("c-1", { content: "queued-while-busy" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.fetchChat).toHaveBeenCalledWith("c-1");
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    expect(getQueue("c-1")).toHaveLength(1);

    // The turn finishes server-side. Re-verify now returns is_running=false
    // — runner drains.
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    await __tickChatQueueRunnerForTests();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("REGRESSION (stale cache): re-verifies cached is_running=true via fresh fetch and drains once it's actually false", async () => {
    // Reproducer for the most common stale-cache scenario:
    //   1. User on chat A → useChatStream sets `is_running=true` in
    //      QueryCache via the optimistic update at startStream entry.
    //   2. User navigates away → useChatEventStream unmounts → no WS
    //      handler is around to flip `is_running=false` when the
    //      `session_ended` frame arrives.
    //   3. The chat's row in cache is stuck `true`.
    //   4. Without re-verification, the runner would see the stuck
    //      `true` and skip every tick forever, leaving the queue
    //      effectively dead until the user manually reopens the chat.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      // Backend reports the actual truth: the turn already ended.
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", true));

    enqueueMessage("c-1", { content: "should-drain-anyway" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    // The runner re-fetched the chat row even though the cache said
    // `is_running=true`, saw the fresh `false`, and drained the entry.
    expect(apiSpies.fetchChat).toHaveBeenCalledWith("c-1");
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("trusts cached is_running=false WITHOUT re-fetching (single-tenant invariant)", async () => {
    // Single-tenant means no other client could have started a turn
    // we don't know about. Cached `false` is therefore safe to trust;
    // re-fetching every tick would burn HTTP for no gain.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "trust-the-cache" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.fetchChat).not.toHaveBeenCalled();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION (deleted chat): clears the queue when fetchChat returns 404", async () => {
    // If the chat row is gone, retrying forever would burn ticks +
    // HTTP. The runner detects 404 and drops the entire queue for
    // that chatId.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async () => {
      throw new Error("HTTP 404 Not Found");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();

    enqueueMessage("c-zombie", { content: "to-the-void" });
    enqueueMessage("c-zombie", { content: "and-this-too" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.fetchChat).toHaveBeenCalledWith("c-zombie");
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    // Queue wiped. Runner is now idle for this chat — next tick won't
    // even fetchChat.
    expect(getQueue("c-zombie")).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("falls back to fetchChat when the chat isn't cached", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    // No setQueryData — the runner must reach for the API.

    enqueueMessage("c-99", { content: "first-time-seeing-this-chat" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.fetchChat).toHaveBeenCalledWith("c-99");
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-99")).toHaveLength(0);
    // The fresh chat row was seeded into the cache so subsequent ticks
    // don't issue duplicate GETs.
    expect(qc.getQueryData(queryKeys.chat("c-99"))).toBeDefined();
  });

  it("LEAVES the entry in the queue on transient 5xx (will retry next tick)", async () => {
    apiSpies.streamMessage.mockImplementation(
      () => ({ ok: false, status: 503, body: null }) as unknown as Response,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "transient-fail" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    // 5xx is transient — entry MUST stay queued for retry.
    expect(getQueue("c-1")).toHaveLength(1);
    expect(getQueue("c-1")[0]!.data.content).toBe("transient-fail");

    warnSpy.mockRestore();
  });

  it("LEAVES the entry in the queue on 429 (rate-limit is transient)", async () => {
    // 429 is the one 4xx code that's transient — daemon's rate-limit
    // backs off and recovers. Treating it as permanent would drop the
    // user's prompt during a brief throttle.
    apiSpies.streamMessage.mockImplementation(
      () => ({ ok: false, status: 429, body: null }) as unknown as Response,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "rate-limited" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(getQueue("c-1")).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("DROPS the head on permanent 4xx (401 — auth expired)", async () => {
    // 401 means the request will never succeed unmodified — retrying
    // forever would burn HTTP and cluster logs. Drop the head; the
    // user surfaces the auth issue via the rest of the UI.
    apiSpies.streamMessage.mockImplementation(
      () => ({ ok: false, status: 401, body: null }) as unknown as Response,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "auth-busted" });
    enqueueMessage("c-1", { content: "next-up" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    // Head dropped; second entry remains for the next tick.
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual(["next-up"]);

    warnSpy.mockRestore();
  });

  it("DROPS the head on permanent 4xx (403 — forbidden)", async () => {
    apiSpies.streamMessage.mockImplementation(
      () => ({ ok: false, status: 403, body: null }) as unknown as Response,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "forbidden" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(getQueue("c-1")).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("DROPS the head on permanent 4xx (400 — bad payload)", async () => {
    // 400 typically means the payload (model id, key id, content) is
    // structurally rejected. No amount of retrying will fix that.
    apiSpies.streamMessage.mockImplementation(
      () => ({ ok: false, status: 400, body: null }) as unknown as Response,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "malformed" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(getQueue("c-1")).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("LEAVES the entry in the queue when streamMessage throws (network error)", async () => {
    apiSpies.streamMessage.mockImplementation(() => {
      throw new TypeError("Failed to fetch");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "lossless" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-1")).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it("drains multiple chats in parallel — each chat picks its own head", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));
    qc.setQueryData(queryKeys.chat("c-2"), fakeChat("c-2", false));

    enqueueMessage("c-1", { content: "in-c1" });
    enqueueMessage("c-2", { content: "in-c2" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    // Two distinct chats each got exactly one POST, in parallel.
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(2);
    const chatIds = apiSpies.streamMessage.mock.calls.map(([id]) => id).sort();
    expect(chatIds).toEqual(["c-1", "c-2"]);
    expect(getQueue("c-1")).toHaveLength(0);
    expect(getQueue("c-2")).toHaveLength(0);
  });

  it("invalidates chat-list and chat-detail queries after a successful background drain", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    enqueueMessage("c-1", { content: "trigger-invalidations" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    const calledKeys = invalidateSpy.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is { queryKey: unknown[] } =>
        typeof arg === "object" && arg !== null && "queryKey" in arg,
      )
      .map((arg) => JSON.stringify(arg.queryKey));
    // The runner invalidates chats list + chat(c-1) + entityChat after a
    // successful drain so any open sidebar / detail view picks up the
    // new persisted rows on the next render.
    expect(calledKeys).toContain(JSON.stringify(queryKeys.chats));
    expect(calledKeys).toContain(JSON.stringify(queryKeys.chat("c-1")));
    expect(calledKeys).toContain(JSON.stringify(["entityChat"]));
  });

  it("processes queued entries one at a time per chat (sequential drain)", async () => {
    // Multiple entries for the same chat must NOT all fire in parallel —
    // backend would reject (or worse, race) two concurrent turns. Two
    // ticks are needed because each drain only pops one head.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "first" });
    enqueueMessage("c-1", { content: "second" });
    enqueueMessage("c-1", { content: "third" });
    startChatQueueRunner(qc);

    // Each tick drains one entry; the runner's `finally → scheduleTick`
    // chains the next one, so by the time the microtasks settle the
    // queue should be empty.
    await __tickChatQueueRunnerForTests();
    // Drain microtasks scheduled by `finally` recursively.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await __tickChatQueueRunnerForTests();
    }

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(3);
    const order = apiSpies.streamMessage.mock.calls.map(
      ([, body]) => (body as { content: string }).content,
    );
    expect(order).toEqual(["first", "second", "third"]);
    expect(getQueue("c-1")).toHaveLength(0);
  });
});

describe("chat-queue-runner — integration scenarios", () => {
  // End-to-end exercises that simulate the actual user-flow handoff
  // between `useChatStream` (when the chat is on screen) and the
  // background runner (when the user is elsewhere). These tests use
  // `registerActiveChat` directly rather than rendering React because
  // the cooperation contract is defined by `isChatActive` — the hook's
  // useEffect just calls that helper, so we can simulate the same
  // transitions without paying the React render tax.

  it("hook→runner takeover: queue dispatched while user is on the chat is left to the hook; on unmount runner picks up the rest", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    // User opens chat A → useChatStream mounted → registerActiveChat.
    const releaseHook = registerActiveChat("c-1");

    // Three queued items pile up while the agent is busy with a
    // previous turn (simulated here as queue state — the actual hook
    // would drain them sequentially via its drain effect).
    enqueueMessage("c-1", { content: "from-hook-1" });
    enqueueMessage("c-1", { content: "from-hook-2" });
    enqueueMessage("c-1", { content: "from-hook-3" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    // Runner is hands-off — hook owns the chat.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    expect(getQueue("c-1")).toHaveLength(3);

    // Hook drains the head itself (simulated: tests for hook drain
    // are in chat-stream.test.tsx — here we just remove one entry
    // by id to mimic the resulting state) — the queue shrinks.
    const queueSnapshot = getQueue("c-1");
    const firstHeadId = queueSnapshot[0]!.id;
    const { removeFromQueue } = await import("@/lib/chat-queue-store");
    removeFromQueue(firstHeadId);
    await __tickChatQueueRunnerForTests();
    // Still hands-off — hook is mounted.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();

    // User navigates away → hook unmounts → release.
    releaseHook();
    await __tickChatQueueRunnerForTests();
    // Drain second head…
    await __tickChatQueueRunnerForTests();
    // …and the third one (sequential — runner's `finally → scheduleTick`
    // chains them).
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await __tickChatQueueRunnerForTests();
    }

    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(2);
    const sent = apiSpies.streamMessage.mock.calls.map(
      ([, body]) => (body as { content: string }).content,
    );
    expect(sent).toEqual(["from-hook-2", "from-hook-3"]);
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("user-returns mid-drain: runner finishes its current send, hook takes over the rest", async () => {
    // Open-ended scenario: runner is mid-drain (drainBody pending) when
    // the user navigates back to the chat. The active-chat marker flips
    // BACK to true, but the runner's current send completes naturally —
    // the next tick sees `isChatActive=true` and stays out of the way,
    // leaving the remaining entries to the now-mounted hook.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "first" });
    enqueueMessage("c-1", { content: "second" });
    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();
    // First entry sent in the background.
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);

    // User returns mid-drain.
    const releaseHook = registerActiveChat("c-1");
    // Next tick — runner sees activeChat=true and skips.
    await __tickChatQueueRunnerForTests();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    // Second entry still queued, waiting for the hook.
    expect(getQueue("c-1")).toHaveLength(1);

    releaseHook();
  });

  it("✕ button race: removeFromQueue between peek and send is honored — entry is NOT sent", async () => {
    // Reproducer for the race the `stillHead.id !== head.id` re-check
    // defends against. Sequence:
    //   1. Runner peeks head (id=H1).
    //   2. Runner awaits fetchChat (yielding back to the event loop).
    //   3. The user clicks ✕ on the H1 chip → removeFromQueue(H1).
    //   4. Runner resumes after the await — naive code would send
    //      H1 anyway. The re-check spots it's gone and bails.
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    let resolveFetch!: (v: ChatDetailResponse) => void;
    apiSpies.fetchChat.mockImplementation(
      () =>
        new Promise<ChatDetailResponse>((r) => {
          resolveFetch = r;
        }),
    );
    const qc = makeQueryClient();
    // Cache says running so the runner takes the slow re-verify path
    // (where the await on fetchChat gives us a window to remove the
    // entry).
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", true));

    const headId = enqueueMessage("c-1", { content: "user-changed-mind" });
    startChatQueueRunner(qc);
    // Kick off a tick that will pause inside fetchChat.
    const tickPromise = __tickChatQueueRunnerForTests();

    // Simulate the user clicking ✕ before the runner resumes.
    const { removeFromQueue } = await import("@/lib/chat-queue-store");
    removeFromQueue(headId);

    // Now let the fetch resolve — runner re-checks peekHead, sees it's
    // gone, bails without sending.
    resolveFetch(fakeChat("c-1", false));
    await tickPromise;

    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("REGRESSION: shared inFlight ledger blocks runner while hook's startStream is sending", async () => {
    // The hook and runner must coordinate against a SINGLE source of
    // truth so a hook send-in-flight (which marks `inFlightDrains`)
    // doesn't leave a window where the runner sees the chat as idle
    // and dispatches a parallel turn for the same chatId. This test
    // simulates the hook holding the marker — runner must skip even
    // though the hook isn't a "registered active chat".
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "hook-is-sending" });

    // Simulate the hook's startStream having just claimed the marker
    // but not yet finished. NOTE: we deliberately do NOT call
    // `registerActiveChat` — the point of this test is that the
    // ledger alone is sufficient.
    const { markDrainInFlight } = await import("@/lib/chat-queue-store");
    const releaseHookFlight = markDrainInFlight("c-1");

    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();

    // Runner saw the in-flight marker and bailed.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();
    expect(getQueue("c-1")).toHaveLength(1);

    // Hook finishes — releases the marker. Now the runner can take
    // over (e.g. user navigated away mid-send, hook's `finally`
    // released the marker, runner's next tick picks up).
    releaseHookFlight();
    await __tickChatQueueRunnerForTests();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);
    expect(getQueue("c-1")).toHaveLength(0);
  });

  it("inFlight guard: a second tick during an in-flight drain does NOT double-send", async () => {
    // Even if scheduleTick fires repeatedly while a drain is in flight
    // (e.g. a burst of qc.invalidate calls), the `inFlight` Set keeps
    // each chatId to one outgoing request at a time.
    let resolveStream!: (v: Response) => void;
    apiSpies.streamMessage.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveStream = r;
        }),
    );
    apiSpies.fetchChat.mockImplementation(async (chatId: string) =>
      fakeChat(chatId, false),
    );
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    enqueueMessage("c-1", { content: "lonely" });
    startChatQueueRunner(qc);
    const firstTick = __tickChatQueueRunnerForTests();
    // Concurrent ticks while the first is paused inside streamMessage —
    // the inFlight Set should make each one a no-op.
    await __tickChatQueueRunnerForTests();
    await __tickChatQueueRunnerForTests();
    await __tickChatQueueRunnerForTests();
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);

    // Resolve and clean up.
    resolveStream(makeStreamOk());
    await firstTick;
  });
});

describe("chat-queue-store — active-chat refcount", () => {
  // The runner relies on `isChatActive` to know when to stay out of the
  // way. The refcount semantic matters because StrictMode double-mounts
  // every effect in dev — without refcounting, the brief unmount between
  // mount #1 and mount #2 would let the runner sneak a duplicate drain in.
  it("registerActiveChat returns idempotent disposers", async () => {
    apiSpies.streamMessage.mockImplementation(() => makeStreamOk());
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.chat("c-1"), fakeChat("c-1", false));

    const r1 = registerActiveChat("c-1");
    const r2 = registerActiveChat("c-1");
    enqueueMessage("c-1", { content: "double-registered" });

    startChatQueueRunner(qc);
    await __tickChatQueueRunnerForTests();
    // Two registrations → still active → runner skips.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();

    r1();
    await __tickChatQueueRunnerForTests();
    // One disposer fired → still 1 reference → runner still skips.
    expect(apiSpies.streamMessage).not.toHaveBeenCalled();

    r2();
    await __tickChatQueueRunnerForTests();
    // Both gone → runner is free to drain.
    expect(apiSpies.streamMessage).toHaveBeenCalledTimes(1);

    // Calling a disposer twice is a no-op (matches the contract).
    r1();
    r2();
  });
});
