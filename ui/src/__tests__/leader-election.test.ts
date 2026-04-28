import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderElection } from "@/lib/leader-election";

/**
 * Contract tests for LeaderElection.
 *
 * The class implements a tabId-ordered single-leader protocol over
 * BroadcastChannel. Tests use a fake BroadcastChannel that pumps messages
 * via queueMicrotask so we can drive the protocol with vitest fake timers
 * without any real cross-tab IPC.
 *
 * Cases covered:
 *   1. Fallback     — no BroadcastChannel global → tab becomes leader.
 *   2. Solo claim   — a single tab claims and wins after the 200ms window.
 *   3. Tie-break    — smallest tabId wins; the other becomes follower.
 *   4. Relinquish   — leader.stop() triggers a re-election.
 *   5. Dead leader  — silent leader is detected after >5s and replaced.
 *   6. Double leader — two leaders simultaneously: the larger tabId
 *                      demotes itself once it receives a heartbeat from
 *                      the smaller-tabId leader.
 *   7. Idempotency  — start()/stop() are safe to call multiple times;
 *                     duplicate becameLeader events are not emitted.
 */

// ---------------------------------------------------------------------------
// Fake BroadcastChannel
// ---------------------------------------------------------------------------

class FakeBroadcastChannel {
  static buses = new Map<string, Set<FakeBroadcastChannel>>();
  static reset(): void {
    FakeBroadcastChannel.buses.clear();
  }

  onmessage: ((e: MessageEvent) => void) | null = null;
  private closed = false;
  public name: string;

  constructor(name: string) {
    this.name = name;
    let bus = FakeBroadcastChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeBroadcastChannel.buses.set(name, bus);
    }
    bus.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const peers = FakeBroadcastChannel.buses.get(this.name);
    if (!peers) return;
    // Snapshot peers — peers may close during dispatch.
    for (const peer of [...peers]) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        if (peer.closed) return;
        peer.onmessage?.({ data } as MessageEvent);
      });
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.buses.get(this.name)?.delete(this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTab(tabId: string): {
  el: LeaderElection;
  events: string[];
} {
  const el = new LeaderElection();
  // Override the auto-generated UUID so tests can drive deterministic
  // tie-breaking ("01" < "02" < "03" lexicographically).
  (el as unknown as { tabId: string }).tabId = tabId;
  const events: string[] = [];
  el.addEventListener("becameLeader", () => events.push("leader"));
  el.addEventListener("becameFollower", () => events.push("follower"));
  return { el, events };
}

/** Advance N ms and let all queued microtasks settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const ORIGINAL_BC = (globalThis as { BroadcastChannel?: unknown })
  .BroadcastChannel;

beforeEach(() => {
  vi.useFakeTimers();
  FakeBroadcastChannel.reset();
  (globalThis as unknown as { BroadcastChannel: typeof FakeBroadcastChannel }).BroadcastChannel =
    FakeBroadcastChannel;
});

afterEach(() => {
  vi.useRealTimers();
  FakeBroadcastChannel.reset();
  if (ORIGINAL_BC === undefined) {
    delete (globalThis as Record<string, unknown>).BroadcastChannel;
  } else {
    (globalThis as Record<string, unknown>).BroadcastChannel = ORIGINAL_BC;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LeaderElection", () => {
  it("falls back to always-leader when BroadcastChannel is undefined", () => {
    delete (globalThis as Record<string, unknown>).BroadcastChannel;
    const { el, events } = makeTab("01");
    el.start();
    expect(el.isLeader()).toBe(true);
    expect(events).toEqual(["leader"]);
    el.stop();
  });

  it("a solo tab claims and becomes leader after the 200ms window", async () => {
    const { el, events } = makeTab("01");
    el.start();
    expect(el.isLeader()).toBe(false);
    await tick(199);
    expect(el.isLeader()).toBe(false);
    await tick(2);
    expect(el.isLeader()).toBe(true);
    expect(events).toEqual(["leader"]);
    el.stop();
  });

  it("smallest tabId wins when two tabs claim simultaneously", async () => {
    const a = makeTab("01");
    const b = makeTab("02");
    a.el.start();
    b.el.start();
    await tick(250);
    expect(a.el.isLeader()).toBe(true);
    expect(b.el.isLeader()).toBe(false);
    expect(a.events).toEqual(["leader"]);
    // Larger tabId never claimed, so no follower event should fire on B
    // (it transitioned directly from "uninitialized" → follower, which is
    // not a state change from isLeaderFlag=false).
    expect(b.events).toEqual([]);
    a.el.stop();
    b.el.stop();
  });

  it("smallest tabId wins regardless of start order", async () => {
    const b = makeTab("02");
    const a = makeTab("01");
    b.el.start();
    await tick(50);
    a.el.start();
    // Both are still inside their 200ms claim window — both should learn
    // about each other before deciding.
    await tick(250);
    expect(a.el.isLeader()).toBe(true);
    expect(b.el.isLeader()).toBe(false);
    a.el.stop();
    b.el.stop();
  });

  it("when leader stops, another tab takes over via relinquish", async () => {
    const a = makeTab("01");
    const b = makeTab("02");
    a.el.start();
    b.el.start();
    await tick(250);
    expect(a.el.isLeader()).toBe(true);
    expect(b.el.isLeader()).toBe(false);

    a.el.stop();
    // relinquish is delivered via microtask; B then attempts a fresh
    // claim with a 200ms window.
    await tick(250);
    expect(b.el.isLeader()).toBe(true);
    b.el.stop();
  });

  it("detects a silent (dead) leader after >5s and re-elects", async () => {
    const a = makeTab("01");
    a.el.start();
    await tick(250);
    expect(a.el.isLeader()).toBe(true);

    // B joins and becomes follower; it has just seen a heartbeat from A.
    const b = makeTab("02");
    b.el.start();
    await tick(250);
    expect(b.el.isLeader()).toBe(false);

    // Wait for B to have observed at least one heartbeat from A so
    // lastSeenLeaderAt > 0.
    await tick(1600);
    expect(b.el.isLeader()).toBe(false);

    // Now simulate A dying without sending relinquish: silence its
    // channel. We'll forcibly close A's channel from underneath it so
    // heartbeats stop being posted.
    (a.el as unknown as { channel: FakeBroadcastChannel }).channel?.close();
    (a.el as unknown as { channel: null }).channel = null;

    // 5s+ of silence should trigger B's deadcheck → claim → win.
    await tick(7000);
    expect(b.el.isLeader()).toBe(true);

    a.el.stop();
    b.el.stop();
  });

  it("a leader demotes when it sees a heartbeat from a smaller tabId", async () => {
    // Set up a leader (B = "02"), then inject a heartbeat from a
    // smaller-id phantom tab ("00"). B must demote itself — this is
    // the "tie-breaker still applies after election" guarantee that
    // protects against any transient double-leader window.
    const b = makeTab("02");
    b.el.start();
    await tick(250);
    expect(b.el.isLeader()).toBe(true);

    // Reach into the private message handler to simulate receipt of a
    // heartbeat from a tab with a smaller tabId. This bypasses the
    // proactive "respond to claim with heartbeat" path entirely so we
    // exercise *only* the post-election demotion branch.
    const onMsg = (
      b.el as unknown as {
        onMessage: (m: {
          type: "heartbeat";
          tabId: string;
          at: number;
        }) => void;
      }
    ).onMessage.bind(b.el);
    onMsg({ type: "heartbeat", tabId: "00", at: Date.now() });

    expect(b.el.isLeader()).toBe(false);
    expect(b.events).toEqual(["leader", "follower"]);

    b.el.stop();
  });

  it("a leader keeps the throne when it sees a heartbeat from a larger tabId", async () => {
    const a = makeTab("01");
    a.el.start();
    await tick(250);
    expect(a.el.isLeader()).toBe(true);

    const onMsg = (
      a.el as unknown as {
        onMessage: (m: {
          type: "heartbeat";
          tabId: string;
          at: number;
        }) => void;
      }
    ).onMessage.bind(a.el);
    onMsg({ type: "heartbeat", tabId: "99", at: Date.now() });

    expect(a.el.isLeader()).toBe(true);
    a.el.stop();
  });

  it("start() / stop() are idempotent and do not double-fire events", async () => {
    const { el, events } = makeTab("01");
    el.start();
    el.start(); // second start is a no-op
    await tick(250);
    expect(events.filter((e) => e === "leader").length).toBe(1);

    el.stop();
    el.stop(); // second stop is a no-op
    expect(el.isLeader()).toBe(false);
  });

  it("isLeader() reflects the last dispatched event", async () => {
    const a = makeTab("02");
    const b = makeTab("01");
    a.el.start();
    await tick(250);
    expect(a.el.isLeader()).toBe(true);

    b.el.start();
    // Smaller tabId issues a claim. A receives it and demotes.
    await tick(50);
    expect(a.el.isLeader()).toBe(false);
    await tick(200);
    expect(b.el.isLeader()).toBe(true);

    a.el.stop();
    b.el.stop();
  });

  it("exposes a stable tabId via the .id getter", () => {
    const { el } = makeTab("deterministic-id");
    expect(el.id).toBe("deterministic-id");
  });
});
