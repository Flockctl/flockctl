import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueMessage,
  removeFromQueue,
  dequeueHead,
  clearQueue,
  reorderQueue,
  getQueue,
  peekHead,
  getAllChatsWithQueue,
  registerActiveChat,
  isChatActive,
  markDrainInFlight,
  isDrainInFlight,
  subscribeChatQueueStore,
  __resetChatQueueStoreForTests,
} from "@/lib/chat-queue-store";
import type { ChatMessageCreate } from "@/lib/types";

const baseData: ChatMessageCreate = { content: "hi" };

beforeEach(() => {
  __resetChatQueueStoreForTests();
});

describe("chat-queue-store — module-level queue", () => {
  it("enqueueMessage returns a unique id and the entry is visible via getQueue", () => {
    const id = enqueueMessage("c-1", baseData);
    expect(id).toMatch(/^queued-/);
    const queue = getQueue("c-1");
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(id);
    expect(queue[0]!.data.content).toBe("hi");
    expect(queue[0]!.chatId).toBe("c-1");
  });

  it("each enqueue produces a distinct id even when called within the same millisecond", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(enqueueMessage("c-1", { content: `msg-${i}` }));
    }
    // 50 unique ids — the in-process counter prevents collisions even when
    // Date.now() returns the same value for back-to-back calls.
    expect(ids.size).toBe(50);
    expect(getQueue("c-1")).toHaveLength(50);
  });

  it("queues for different chats are isolated", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-2", { content: "b" });
    expect(getQueue("c-1")).toHaveLength(1);
    expect(getQueue("c-2")).toHaveLength(1);
    expect(getQueue("c-1")[0]!.data.content).toBe("a");
    expect(getQueue("c-2")[0]!.data.content).toBe("b");
  });

  it("getQueue returns a stable empty-array sentinel for unknown chats", () => {
    // Stable reference matters — `useSyncExternalStore` re-renders on every
    // snapshot change, so an empty queue must serialise to the SAME array
    // each call or the hook would loop. Two reads on a never-touched chat
    // must return the same reference.
    const a = getQueue("never-seen");
    const b = getQueue("never-seen");
    expect(a).toBe(b);
    expect(a).toHaveLength(0);
  });

  it("removeFromQueue drops a single entry across all chats by id", () => {
    enqueueMessage("c-1", { content: "a" });
    const idB = enqueueMessage("c-2", { content: "b" });
    enqueueMessage("c-2", { content: "c" });

    removeFromQueue(idB);

    expect(getQueue("c-1")).toHaveLength(1);
    expect(getQueue("c-2")).toHaveLength(1);
    expect(getQueue("c-2")[0]!.data.content).toBe("c");
  });

  it("removeFromQueue with an unknown id is a silent no-op", () => {
    enqueueMessage("c-1", { content: "a" });
    removeFromQueue("queued-does-not-exist");
    expect(getQueue("c-1")).toHaveLength(1);
  });

  it("dequeueHead pops FIFO and removes the chat slot when the queue becomes empty", () => {
    enqueueMessage("c-1", { content: "first" });
    enqueueMessage("c-1", { content: "second" });

    const head1 = dequeueHead("c-1");
    expect(head1?.data.content).toBe("first");
    expect(getQueue("c-1")).toHaveLength(1);

    const head2 = dequeueHead("c-1");
    expect(head2?.data.content).toBe("second");
    expect(getQueue("c-1")).toHaveLength(0);

    // Empty slot is cleaned out — third dequeue returns null without
    // resurrecting an empty array.
    const head3 = dequeueHead("c-1");
    expect(head3).toBeNull();
  });

  it("dequeueHead on an unknown chat returns null", () => {
    expect(dequeueHead("never-seen")).toBeNull();
  });

  it("clearQueue empties one chat's slot only", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });
    enqueueMessage("c-2", { content: "c" });

    clearQueue("c-1");

    expect(getQueue("c-1")).toHaveLength(0);
    expect(getQueue("c-2")).toHaveLength(1);
  });

  it("clearQueue on an empty chat is a silent no-op", () => {
    expect(() => clearQueue("c-empty")).not.toThrow();
    expect(getQueue("c-empty")).toHaveLength(0);
  });

  it("opts (projectId) is preserved end-to-end", () => {
    enqueueMessage("c-1", baseData, { projectId: "p-99" });
    const head = dequeueHead("c-1");
    expect(head?.opts).toEqual({ projectId: "p-99" });
  });

  it("__resetChatQueueStoreForTests wipes everything", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-2", { content: "b" });
    __resetChatQueueStoreForTests();
    expect(getQueue("c-1")).toHaveLength(0);
    expect(getQueue("c-2")).toHaveLength(0);
  });
});

describe("chat-queue-store — reorderQueue (DnD / keyboard reorder)", () => {
  // The reorder helper backs both the drag-and-drop handler and the
  // Alt+↑/↓ keyboard fallback in QueuedMessagesList. Behaviour pinned
  // here is what the UI relies on — every "reorder rejected" path must
  // surface as a `false` return so the component can skip the follow-on
  // visual side-effect (focus restoration, announcement, etc.).

  it("moves an entry from fromIndex to toIndex (down)", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });
    enqueueMessage("c-1", { content: "c" });
    enqueueMessage("c-1", { content: "d" });

    // Move "a" (head) down to position 2 → b, c, a, d
    expect(reorderQueue("c-1", 0, 2)).toBe(true);
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves an entry from fromIndex to toIndex (up)", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });
    enqueueMessage("c-1", { content: "c" });
    enqueueMessage("c-1", { content: "d" });

    // Move "d" (tail) to head → d, a, b, c
    expect(reorderQueue("c-1", 3, 0)).toBe(true);
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("preserves entry identity (id, opts) across a reorder", () => {
    const idA = enqueueMessage("c-1", { content: "a" }, { projectId: "p-1" });
    const idB = enqueueMessage("c-1", { content: "b" }, { projectId: "p-2" });

    reorderQueue("c-1", 0, 1);

    const queue = getQueue("c-1");
    // ids and opts must travel with the entries — the runner's
    // peekHead/removeFromQueue chain is keyed on `id`, so a reorder that
    // accidentally regenerated ids would silently drop the wrong entry
    // on next drain.
    expect(queue[0]!.id).toBe(idB);
    expect(queue[0]!.opts).toEqual({ projectId: "p-2" });
    expect(queue[1]!.id).toBe(idA);
    expect(queue[1]!.opts).toEqual({ projectId: "p-1" });
  });

  it("returns a fresh array reference so useSyncExternalStore re-renders", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });
    const before = getQueue("c-1");

    reorderQueue("c-1", 0, 1);

    // Identity check — the snapshot returned by `getQueue` / the
    // `useChatQueue` selector MUST change on a reorder, otherwise React
    // bails out and the chip order in the DOM goes stale. (The store
    // splices on a copy, not in-place, precisely for this reason.)
    expect(getQueue("c-1")).not.toBe(before);
  });

  it("returns false and is a no-op for out-of-bounds indices", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });

    expect(reorderQueue("c-1", -1, 0)).toBe(false);
    expect(reorderQueue("c-1", 0, -1)).toBe(false);
    expect(reorderQueue("c-1", 5, 0)).toBe(false);
    expect(reorderQueue("c-1", 0, 5)).toBe(false);
    // Order untouched.
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual(["a", "b"]);
  });

  it("returns false and is a no-op when fromIndex === toIndex", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });
    expect(reorderQueue("c-1", 0, 0)).toBe(false);
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual(["a", "b"]);
  });

  it("returns false on empty / single-entry queues (nothing to swap with)", () => {
    expect(reorderQueue("c-empty", 0, 0)).toBe(false);
    enqueueMessage("c-1", { content: "only" });
    expect(reorderQueue("c-1", 0, 0)).toBe(false);
    expect(getQueue("c-1")).toHaveLength(1);
  });

  it("rejects reorder while a drain is in flight (anti-race guard)", () => {
    enqueueMessage("c-1", { content: "head" });
    enqueueMessage("c-1", { content: "tail" });
    const releaseDrain = markDrainInFlight("c-1");

    // The drain has peeked the head and may have already POSTed it to
    // the daemon. Letting reorder land here would mean the user "moves"
    // an entry that's already been sent — a confusing ghost-pop in the
    // UI as soon as the drain returns and removeFromQueue lands.
    expect(reorderQueue("c-1", 0, 1)).toBe(false);
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual([
      "head",
      "tail",
    ]);

    releaseDrain();
    // After the drain releases, reorder is allowed again.
    expect(reorderQueue("c-1", 0, 1)).toBe(true);
    expect(getQueue("c-1").map((m) => m.data.content)).toEqual([
      "tail",
      "head",
    ]);
  });

  it("isolates reorder by chat — c-2's queue stays untouched", () => {
    enqueueMessage("c-1", { content: "a1" });
    enqueueMessage("c-1", { content: "b1" });
    enqueueMessage("c-2", { content: "a2" });
    enqueueMessage("c-2", { content: "b2" });

    reorderQueue("c-1", 0, 1);

    expect(getQueue("c-1").map((m) => m.data.content)).toEqual(["b1", "a1"]);
    expect(getQueue("c-2").map((m) => m.data.content)).toEqual(["a2", "b2"]);
  });

  it("notifies subscribers on a successful reorder, not on a rejected one", () => {
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-1", { content: "b" });

    let calls = 0;
    const unsub = subscribeChatQueueStore(() => {
      calls += 1;
    });

    reorderQueue("c-1", 0, 1);
    expect(calls).toBe(1);

    // No-op call (same indices) MUST NOT emit — otherwise hovering a
    // dragged item over its original slot would trigger needless re-
    // renders for every mouse-move that lands on the same row.
    reorderQueue("c-1", 0, 0);
    expect(calls).toBe(1);

    // Out-of-bounds → no emit.
    reorderQueue("c-1", 99, 0);
    expect(calls).toBe(1);

    // Rejected by drain marker → no emit FROM REORDER. (Note that
    // `markDrainInFlight` itself emits on the first flag, so we
    // snapshot the count immediately *after* `markDrainInFlight`
    // returns; a successful-emit-from-the-mark would otherwise inflate
    // `calls` and mask whatever reorder did or didn't do.)
    const release = markDrainInFlight("c-1");
    const callsAfterMark = calls;
    reorderQueue("c-1", 0, 1);
    expect(calls).toBe(callsAfterMark);
    release();

    unsub();
  });
});

describe("chat-queue-store — runner integration helpers", () => {
  // These helpers exist solely for the background runner; their contract
  // is what makes "send the head, only remove on success" possible
  // without a peek/pop race.

  it("peekHead returns the head WITHOUT removing it", () => {
    enqueueMessage("c-1", { content: "first" });
    enqueueMessage("c-1", { content: "second" });

    const head1 = peekHead("c-1");
    expect(head1?.data.content).toBe("first");
    // Same head still there after a peek.
    const head2 = peekHead("c-1");
    expect(head2?.data.content).toBe("first");
    expect(getQueue("c-1")).toHaveLength(2);
  });

  it("peekHead on an empty / unknown chat returns null", () => {
    expect(peekHead("never-seen")).toBeNull();
    enqueueMessage("c-1", { content: "x" });
    dequeueHead("c-1");
    expect(peekHead("c-1")).toBeNull();
  });

  it("getAllChatsWithQueue lists every chat with at least one entry", () => {
    expect(getAllChatsWithQueue()).toEqual([]);
    enqueueMessage("c-1", { content: "a" });
    enqueueMessage("c-2", { content: "b" });
    enqueueMessage("c-3", { content: "c" });
    expect(getAllChatsWithQueue().sort()).toEqual(["c-1", "c-2", "c-3"]);

    // Drain c-2 entirely → list should drop it.
    dequeueHead("c-2");
    expect(getAllChatsWithQueue().sort()).toEqual(["c-1", "c-3"]);

    // clearQueue drops too.
    clearQueue("c-1");
    expect(getAllChatsWithQueue()).toEqual(["c-3"]);
  });

  it("registerActiveChat refcounts mounts (StrictMode-safe)", () => {
    expect(isChatActive("c-1")).toBe(false);

    const r1 = registerActiveChat("c-1");
    expect(isChatActive("c-1")).toBe(true);

    const r2 = registerActiveChat("c-1");
    expect(isChatActive("c-1")).toBe(true);

    r1();
    // Refcount = 1 — still active.
    expect(isChatActive("c-1")).toBe(true);

    r2();
    // Refcount = 0 — inactive.
    expect(isChatActive("c-1")).toBe(false);

    // Disposers are idempotent.
    r1();
    r2();
    expect(isChatActive("c-1")).toBe(false);
  });

  it("registerActiveChat for different chats keeps each marker independent", () => {
    const releaseA = registerActiveChat("c-1");
    const releaseB = registerActiveChat("c-2");
    expect(isChatActive("c-1")).toBe(true);
    expect(isChatActive("c-2")).toBe(true);

    releaseA();
    expect(isChatActive("c-1")).toBe(false);
    expect(isChatActive("c-2")).toBe(true);

    releaseB();
    expect(isChatActive("c-2")).toBe(false);
  });

  it("markDrainInFlight returns idempotent disposers — single source of truth across hook + runner", () => {
    expect(isDrainInFlight("c-1")).toBe(false);

    const r1 = markDrainInFlight("c-1");
    expect(isDrainInFlight("c-1")).toBe(true);

    // Calling the disposer twice is a no-op.
    r1();
    r1();
    expect(isDrainInFlight("c-1")).toBe(false);
  });

  it("markDrainInFlight isolates per chat", () => {
    const release1 = markDrainInFlight("c-1");
    expect(isDrainInFlight("c-1")).toBe(true);
    expect(isDrainInFlight("c-2")).toBe(false);

    const release2 = markDrainInFlight("c-2");
    expect(isDrainInFlight("c-1")).toBe(true);
    expect(isDrainInFlight("c-2")).toBe(true);

    release1();
    expect(isDrainInFlight("c-1")).toBe(false);
    expect(isDrainInFlight("c-2")).toBe(true);

    release2();
    expect(isDrainInFlight("c-2")).toBe(false);
  });

  it("__resetChatQueueStoreForTests wipes inFlight markers too", () => {
    markDrainInFlight("c-1");
    markDrainInFlight("c-2");
    expect(isDrainInFlight("c-1")).toBe(true);
    expect(isDrainInFlight("c-2")).toBe(true);

    __resetChatQueueStoreForTests();

    expect(isDrainInFlight("c-1")).toBe(false);
    expect(isDrainInFlight("c-2")).toBe(false);
  });
});
