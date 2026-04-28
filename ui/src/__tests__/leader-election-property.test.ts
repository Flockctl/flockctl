import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaderElection } from "@/lib/leader-election";

/**
 * Property-style tests for LeaderElection.
 *
 * These tests do NOT use fast-check (not currently a UI dep) — instead
 * they run a deterministic seeded PRNG over many random scenarios and
 * assert protocol invariants:
 *
 *   I1. Convergence — after a quiet window, exactly one tab is leader.
 *   I2. Tie-break   — the leader's tabId is the lexicographic minimum
 *                     among the tabs that are still running.
 *   I3. Failover    — if the current leader stops, another tab becomes
 *                     leader within a bounded amount of time.
 *
 * Determinism is non-negotiable: each scenario uses a seeded PRNG and
 * vitest fake timers, so a failure can be replayed by re-running with
 * the same seed.
 */

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

// Mulberry32 — small, deterministic, seedable PRNG.
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function newTab(tabId: string): LeaderElection {
  const el = new LeaderElection();
  (el as unknown as { tabId: string }).tabId = tabId;
  return el;
}

/** Pad a number to a fixed-width string so lexicographic order matches
 *  numeric order. Avoids "10" < "2" surprises. */
function padId(n: number): string {
  return `tab-${n.toString().padStart(4, "0")}`;
}

/** Quiesce window long enough for any in-flight protocol activity to
 *  resolve. Two heartbeat intervals + the dead-leader threshold
 *  comfortably bound any open transition. */
const QUIESCE_MS = 8000;

async function quiesce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(QUIESCE_MS);
}

describe("LeaderElection — invariants under random scenarios", () => {
  it("I1+I2: any cohort of tabs converges to exactly one leader (smallest tabId)", async () => {
    // Run many seeds; each picks a random number of tabs and start order.
    for (let seed = 1; seed <= 25; seed++) {
      const rng = mkRng(seed);
      const tabCount = 2 + Math.floor(rng() * 4); // 2..5 tabs
      const ids = Array.from({ length: tabCount }, (_, i) => padId(i + 1));
      // Shuffle start order with Fisher–Yates.
      const startOrder = [...ids];
      for (let i = startOrder.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const a = startOrder[i]!;
        const b = startOrder[j]!;
        startOrder[i] = b;
        startOrder[j] = a;
      }

      const tabs = new Map<string, LeaderElection>();
      for (const id of startOrder) {
        const el = newTab(id);
        tabs.set(id, el);
        el.start();
        // Random small delay between starts (0..150ms) — stays inside
        // the 200ms claim window so cohort can converge in one round.
        await vi.advanceTimersByTimeAsync(Math.floor(rng() * 150));
      }

      await quiesce();

      const leaders = [...tabs.values()].filter((t) => t.isLeader());
      expect(
        leaders.length,
        `seed=${seed} ids=${ids.join(",")} should converge to 1 leader, got ${leaders.length}`,
      ).toBe(1);

      // The leader must be the lex-min of the live tabs.
      const expectedLeader = [...tabs.keys()].sort()[0];
      expect(leaders[0]!.id).toBe(expectedLeader);

      for (const t of tabs.values()) t.stop();
      FakeBroadcastChannel.reset();
    }
  });

  it("I3: when the current leader stops, a new leader emerges from the survivors", async () => {
    for (let seed = 100; seed <= 115; seed++) {
      const rng = mkRng(seed);
      const tabCount = 3 + Math.floor(rng() * 3); // 3..5 tabs
      const ids = Array.from({ length: tabCount }, (_, i) => padId(i + 1));

      const tabs = new Map<string, LeaderElection>();
      for (const id of ids) {
        const el = newTab(id);
        tabs.set(id, el);
        el.start();
      }
      await quiesce();

      const initialLeaders = [...tabs.values()].filter((t) => t.isLeader());
      expect(initialLeaders.length).toBe(1);
      const initialLeader = initialLeaders[0]!;

      // Stop the leader.
      initialLeader.stop();
      tabs.delete(initialLeader.id);

      await quiesce();

      const newLeaders = [...tabs.values()].filter((t) => t.isLeader());
      expect(
        newLeaders.length,
        `seed=${seed} survivors=${[...tabs.keys()].join(",")} should have 1 new leader`,
      ).toBe(1);
      // New leader = lex-min of survivors.
      const expected = [...tabs.keys()].sort()[0];
      expect(newLeaders[0]!.id).toBe(expected);

      for (const t of tabs.values()) t.stop();
      FakeBroadcastChannel.reset();
    }
  });

  it("I3b: surviving the death of multiple leaders in sequence", async () => {
    // 4 tabs, kill the leader twice in a row, ensure new leader each time.
    const ids = ["tab-0001", "tab-0002", "tab-0003", "tab-0004"];
    const tabs = new Map<string, LeaderElection>();
    for (const id of ids) {
      const el = newTab(id);
      tabs.set(id, el);
      el.start();
    }
    await quiesce();
    expect([...tabs.values()].filter((t) => t.isLeader()).map((t) => t.id))
      .toEqual(["tab-0001"]);

    // Kill tab-0001
    tabs.get("tab-0001")!.stop();
    tabs.delete("tab-0001");
    await quiesce();
    expect([...tabs.values()].filter((t) => t.isLeader()).map((t) => t.id))
      .toEqual(["tab-0002"]);

    // Kill tab-0002
    tabs.get("tab-0002")!.stop();
    tabs.delete("tab-0002");
    await quiesce();
    expect([...tabs.values()].filter((t) => t.isLeader()).map((t) => t.id))
      .toEqual(["tab-0003"]);

    for (const t of tabs.values()) t.stop();
  });
});
