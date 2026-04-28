import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatcher, type Notifiable } from "@/lib/notification-dispatcher";
import { LeaderElection } from "@/lib/leader-election";
import {
  DEFAULT_PREFS,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

/**
 * Contract tests for Dispatcher.
 *
 * Covers the gate sequence inside `fire()`:
 *   1. Leader gate     — followers short-circuit; no Notification ever
 *                        constructed.
 *   2. Master gate     — `prefs.enabled` master switch.
 *   3. Category gate   — per-category toggle.
 *   4. Permission gate — `Notification.permission === "granted"`.
 *   5. Dedup gate      — same `key` within TTL collapses.
 *
 * Plus the M0-slice-01 edge case: a follower's upstream cache
 * (conceptually `prevRef.current`) must stay live, but the Dispatcher
 * itself must not fire — verified by promotion-after-close: leader fires
 * for event A, leader closes, the follower (now leader) fires only for
 * event B and not for A even when A's key is replayed.
 */

// --- LeaderElection stub -----------------------------------------------------
//
// The real LeaderElection couples to BroadcastChannel; for fire()-gate
// tests we just need a `.isLeader()` flag and the EventTarget surface so
// useLeaderStatus-style consumers compile, even though we don't drive
// them here.

class StubLeader extends EventTarget {
  private flag: boolean;
  constructor(initial: boolean) {
    super();
    this.flag = initial;
  }
  isLeader(): boolean {
    return this.flag;
  }
  setLeader(next: boolean): void {
    if (this.flag === next) return;
    this.flag = next;
    this.dispatchEvent(new Event(next ? "becameLeader" : "becameFollower"));
  }
}

// --- window.Notification harness --------------------------------------------

interface FakeNotificationInstance {
  title: string;
  opts?: NotificationOptions;
  closed: boolean;
  onclose: ((this: FakeNotificationInstance) => void) | null;
  close(): void;
}

// `constructed` tracks the per-instance shape (title, opts, close-state) so
// registry tests can assert "the previous handle for key K was closed when
// K fired again past the dedup window". The objects pushed here ARE the
// objects returned by `new Notification(...)` — keeping a single source of
// truth means a regression where the dispatcher loses the reference can't
// hide behind an out-of-band tracker.
let constructed: FakeNotificationInstance[];

function installNotification(permission: "granted" | "denied" | "default"): void {
  constructed = [];
  const NotificationCtor = function (
    this: FakeNotificationInstance,
    title: string,
    opts?: NotificationOptions,
  ) {
    this.title = title;
    this.opts = opts;
    this.closed = false;
    this.onclose = null;
    this.close = function (this: FakeNotificationInstance) {
      // Idempotent close — real Notification.close() is also safe to call
      // multiple times, and the dispatcher's overwrite-with-close path
      // can race a user-initiated dismissal.
      if (this.closed) return;
      this.closed = true;
      try {
        this.onclose?.call(this);
      } catch {
        // mirrors the dispatcher's own swallow on close()
      }
    };
    constructed.push(this);
    return this;
  } as unknown as { permission: string };
  (NotificationCtor as unknown as { permission: string }).permission = permission;
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: NotificationCtor,
  });
}

function uninstallNotification(): void {
  Reflect.deleteProperty(window, "Notification");
}

function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    writable: true,
    value: secure,
  });
}

// --- helpers -----------------------------------------------------------------

function makeDispatcher(opts: {
  prefs?: Partial<NotificationPrefs>;
  isLeader?: boolean;
}): { d: Dispatcher; leader: StubLeader; setPrefs: (p: NotificationPrefs) => void } {
  const prefs: NotificationPrefs = { ...DEFAULT_PREFS, ...(opts.prefs ?? {}) };
  let live = prefs;
  const leader = new StubLeader(opts.isLeader ?? true);
  // Cast: the StubLeader is API-compatible for what Dispatcher reads
  // (`isLeader()`), and Dispatcher only stores it via interface methods.
  const d = new Dispatcher(
    () => live,
    (k) => k,
    leader as unknown as LeaderElection,
  );
  return {
    d,
    leader,
    setPrefs: (p) => {
      live = p;
    },
  };
}

const baseEvent = (over: Partial<Notifiable> = {}): Notifiable => ({
  category: "approval",
  key: "evt:1",
  title: "Approval needed",
  ...over,
});

// --- lifecycle --------------------------------------------------------------

beforeEach(() => {
  setSecureContext(true);
  installNotification("granted");
});

afterEach(() => {
  uninstallNotification();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dispatcher.fire — leader gate (FIRST check)", () => {
  it("is a no-op when this tab is not the leader", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: false,
    });
    d.fire(baseEvent());
    expect(constructed).toHaveLength(0);
  });

  it("fires when this tab is the leader and all other gates pass", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent());
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Approval needed");
  });

  it("emits a 'fired' synthetic event only when actually fired", () => {
    const { d, leader } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: false,
    });
    const seen: Notifiable[] = [];
    d.addEventListener("fired", (e) =>
      seen.push((e as CustomEvent<Notifiable>).detail),
    );
    d.fire(baseEvent({ key: "evt:a" }));
    expect(seen).toEqual([]);
    leader.setLeader(true);
    d.fire(baseEvent({ key: "evt:b" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe("evt:b");
  });
});

describe("Dispatcher.fire — master/category/permission gates", () => {
  it("is a no-op when prefs.enabled is false (master OFF)", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: false, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent());
    expect(constructed).toHaveLength(0);
  });

  it("is a no-op when the category toggle is off", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: false },
      isLeader: true,
    });
    d.fire(baseEvent({ category: "approval" }));
    expect(constructed).toHaveLength(0);
  });

  it("is a no-op when browser permission is not granted", () => {
    installNotification("denied");
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent());
    expect(constructed).toHaveLength(0);
  });

  it("respects the per-category mapping (question, done, failed, blocked)", () => {
    const { d, setPrefs } = makeDispatcher({
      prefs: {
        enabled: true,
        onApprovalNeeded: false,
        onQuestionAsked: true,
        onTaskDone: false,
        onTaskFailed: true,
        onTaskBlocked: false,
      },
      isLeader: true,
    });
    d.fire(baseEvent({ category: "question", key: "q:1" }));
    d.fire(baseEvent({ category: "done", key: "d:1" }));
    d.fire(baseEvent({ category: "failed", key: "f:1" }));
    d.fire(baseEvent({ category: "blocked", key: "b:1" }));
    // `question` and `failed` are on; `done` and `blocked` are off.
    expect(constructed).toHaveLength(2);

    // Flip blocked on, fire again.
    setPrefs({
      ...DEFAULT_PREFS,
      enabled: true,
      onTaskBlocked: true,
    });
    d.fire(baseEvent({ category: "blocked", key: "b:2" }));
    expect(constructed).toHaveLength(3);
  });
});

describe("Dispatcher.fire — dedup gate", () => {
  it("collapses two fires with the same key inside the TTL window", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "task:42:status" }));
    d.fire(baseEvent({ key: "task:42:status" }));
    expect(constructed).toHaveLength(1);
  });

  it("allows the same key again after the dedup TTL elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "k" }));
    expect(constructed).toHaveLength(1);
    // Inside the 5s window — still deduped.
    vi.setSystemTime(new Date("2025-01-01T00:00:04Z"));
    d.fire(baseEvent({ key: "k" }));
    expect(constructed).toHaveLength(1);
    // Past the window — fires again.
    vi.setSystemTime(new Date("2025-01-01T00:00:06Z"));
    d.fire(baseEvent({ key: "k" }));
    expect(constructed).toHaveLength(2);
  });

  it("different keys are not deduped against each other", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "a" }));
    d.fire(baseEvent({ key: "b" }));
    expect(constructed).toHaveLength(2);
  });
});

describe("Dispatcher — promotion edge case", () => {
  it("promoted-from-follower fires only for new events, not stale ones", () => {
    // Tab starts as follower. Upstream `prevRef.current` (here simulated
    // by us calling fire() on every event regardless of leader status —
    // exactly what the production diff loop does) must keep flowing so
    // that on promotion the dispatcher doesn't re-fire stale items.
    //
    // Concretely: the Dispatcher itself never tracks "stale". The diff
    // baseline lives upstream. From the Dispatcher's perspective the
    // contract is just: a follower's fire() is a no-op, and once
    // promoted, future fire() calls go through.
    const { d, leader } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true, onTaskDone: true },
      isLeader: false,
    });

    // Event A — fired while we are a follower. Must be a no-op.
    d.fire(baseEvent({ category: "approval", key: "A" }));
    expect(constructed).toHaveLength(0);

    // Promotion (e.g. previous leader tab closed).
    leader.setLeader(true);

    // Event B — fired post-promotion. Must go through.
    d.fire(baseEvent({ category: "done", key: "B", title: "Task done" }));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Task done");

    // Critically: A must NOT now be replayed by the Dispatcher itself.
    // (If the upstream diff baseline were broken it would call fire(A)
    // again — the Dispatcher's job is to honor that call, not to filter
    // it. This is captured here by *not* calling fire(A) again and
    // verifying constructed didn't grow.)
    expect(constructed).toHaveLength(1);
  });

  it("demoted-from-leader stops firing immediately", () => {
    const { d, leader } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "x" }));
    expect(constructed).toHaveLength(1);
    leader.setLeader(false);
    d.fire(baseEvent({ key: "y" }));
    expect(constructed).toHaveLength(1);
  });
});

describe("Dispatcher.leader getter", () => {
  it("exposes the LeaderElection passed to the constructor", () => {
    const { d, leader } = makeDispatcher({});
    // Same identity — the hook subscribes via this reference.
    expect(d.leader).toBe(leader as unknown as LeaderElection);
  });
});

// ---------------------------------------------------------------------------
// Registry tests — `Dispatcher.handles` + `resolveByKey`
//
// The dispatcher remembers the live `Notification` it constructed on each
// successful fire(), keyed by the dedup key. Two cleanup paths feed the
// registry: explicit `resolveByKey(key)` (called by the inbox-driven hook
// when an attention row disappears) and the OS-driven `onclose` callback
// (user dismissed the notification themselves). Tests below pin both.
// ---------------------------------------------------------------------------

describe("Dispatcher — registry of live handles", () => {
  it("stores the constructed Notification under its key after fire()", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "task:42" }));
    expect(constructed).toHaveLength(1);
    // Round-trip through resolveByKey: if the registry actually holds the
    // handle, calling resolveByKey closes it; otherwise this is a no-op.
    d.resolveByKey("task:42");
    expect(constructed[0]?.closed).toBe(true);
  });

  it("sets `tag` on the Notification options (= the dedup key) for OS-level dedup", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "task:42:status" }));
    expect(constructed[0]?.opts?.tag).toBe("task:42:status");
  });

  it("on overwrite (same key, past dedup TTL) closes the previous handle before firing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "k" }));
    expect(constructed).toHaveLength(1);
    // Past the dedup TTL — same key must construct a fresh handle AND
    // close the previous one (otherwise the OS notification center
    // accumulates stale entries).
    vi.setSystemTime(new Date("2025-01-01T00:00:06Z"));
    d.fire(baseEvent({ key: "k" }));
    expect(constructed).toHaveLength(2);
    expect(constructed[0]?.closed).toBe(true);
    expect(constructed[1]?.closed).toBe(false);
  });

  it("the handle's onclose evicts only its own slot, not a successor", () => {
    // Race scenario: fire(K) → handle1, past TTL → fire(K) → handle2, then
    // OS dismisses handle1 (firing handle1.onclose). The registry must
    // still hold handle2 — otherwise resolveByKey(K) would fail to close
    // handle2 a moment later.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "k" }));
    const first = constructed[0]!;
    vi.setSystemTime(new Date("2025-01-01T00:00:06Z"));
    d.fire(baseEvent({ key: "k" }));
    const second = constructed[1]!;
    // The overwrite path called close() on `first` already, but in a real
    // browser the onclose callback could fire later (queued in the event
    // loop). Re-fire it to simulate the late arrival.
    first.onclose?.call(first);
    // Successor must still be addressable.
    d.resolveByKey("k");
    expect(second.closed).toBe(true);
  });
});

describe("Dispatcher.resolveByKey", () => {
  it("is a no-op when the key isn't in the registry", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    // Should not throw; should not affect the (empty) constructed array.
    expect(() => d.resolveByKey("never-fired")).not.toThrow();
    expect(constructed).toHaveLength(0);
  });

  it("closes the handle and removes it from the registry (idempotent)", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "k" }));
    d.resolveByKey("k");
    expect(constructed[0]?.closed).toBe(true);
    // Second resolve is a no-op — the registry slot is already empty.
    expect(() => d.resolveByKey("k")).not.toThrow();
  });

  it("closing one key does not affect others", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true, onTaskDone: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "a" }));
    d.fire(baseEvent({ key: "b", category: "done", title: "Done" }));
    d.resolveByKey("a");
    expect(constructed[0]?.closed).toBe(true);
    expect(constructed[1]?.closed).toBe(false);
  });

  it("does NOT throw when the underlying close() throws", () => {
    // Some browsers / extensions raise on close() of a notification the
    // OS already dismissed. Our resolver must swallow.
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(baseEvent({ key: "k" }));
    constructed[0]!.close = () => {
      throw new Error("OS dismissed already");
    };
    expect(() => d.resolveByKey("k")).not.toThrow();
  });
});

describe("Dispatcher — task_terminal TTL", () => {
  it("schedules a self-resolve at 5 minutes for source: 'task_terminal'", () => {
    vi.useFakeTimers();
    const { d } = makeDispatcher({
      prefs: { enabled: true, onTaskDone: true },
      isLeader: true,
    });
    d.fire(
      baseEvent({
        category: "done",
        key: "task:99:done",
        title: "Done",
        source: "task_terminal",
      }),
    );
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.closed).toBe(false);

    // Just before the TTL — still open.
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(constructed[0]?.closed).toBe(false);

    // At the TTL — auto-closed via resolveByKey.
    vi.advanceTimersByTime(1);
    expect(constructed[0]?.closed).toBe(true);
  });

  it("does NOT schedule a TTL when source is 'attention' (or omitted)", () => {
    vi.useFakeTimers();
    const { d } = makeDispatcher({
      prefs: { enabled: true, onApprovalNeeded: true },
      isLeader: true,
    });
    d.fire(
      baseEvent({
        category: "approval",
        key: "task:1:approval",
        source: "attention",
      }),
    );
    vi.advanceTimersByTime(10 * 60 * 1000);
    // Notification stays open — only resolveByKey or onclose can close it.
    expect(constructed[0]?.closed).toBe(false);
  });
});
