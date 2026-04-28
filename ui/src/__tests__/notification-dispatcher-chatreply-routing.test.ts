import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatcher, type Notifiable } from "@/lib/notification-dispatcher";
import { LeaderElection } from "@/lib/leader-election";
import {
  DEFAULT_PREFS,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

/**
 * M15 / slice 02 / task 02 — chat-reply routing in the dispatcher.
 *
 * This file pins ONLY the dispatcher's per-category gate for the new
 * `chatReply` category. It deliberately does NOT cover focus suppression
 * or attention-conflict suppression — those rules live in slice 01's
 * upstream runner and have their own dedicated test surface. Keeping the
 * scope tight here means a regression in suppression semantics cannot
 * mask a regression in pure category routing (and vice versa).
 *
 * What we assert:
 *   1. With `onChatReply: false` (the DEFAULT_PREFS value), `fire()` for
 *      a `chatReply` event short-circuits at the category gate — no
 *      `Notification` is constructed.
 *   2. With `onChatReply: true`, browser permission `granted`, and the
 *      tab as leader, exactly one `Notification` is constructed.
 *   3. Other categories ("approval", "done", …) are unaffected — no
 *      cross-talk through the new map entry.
 */

// --- LeaderElection stub -----------------------------------------------------
//
// Mirrors the stub used in `notification-dispatcher.test.ts`. The real
// LeaderElection couples to BroadcastChannel; for fire()-gate tests we
// only need `.isLeader()` and the EventTarget surface so the cast in
// `makeDispatcher` compiles.

class StubLeader extends EventTarget {
  private flag: boolean;
  constructor(initial: boolean) {
    super();
    this.flag = initial;
  }
  isLeader(): boolean {
    return this.flag;
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
      if (this.closed) return;
      this.closed = true;
      try {
        this.onclose?.call(this);
      } catch {
        // mirrors dispatcher swallow on close()
      }
    };
    constructed.push(this);
    return this;
  } as unknown as { permission: string };
  (NotificationCtor as unknown as { permission: string }).permission =
    permission;
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
}): { d: Dispatcher; leader: StubLeader } {
  const prefs: NotificationPrefs = { ...DEFAULT_PREFS, ...(opts.prefs ?? {}) };
  const live = prefs;
  const leader = new StubLeader(opts.isLeader ?? true);
  const d = new Dispatcher(
    () => live,
    (k) => k,
    leader as unknown as LeaderElection,
  );
  return { d, leader };
}

const chatReplyEvent = (over: Partial<Notifiable> = {}): Notifiable => ({
  category: "chatReply",
  // Stable per-(chat, message) dedup key, matching the convention the
  // upstream runner is expected to emit. Mirrors the `task_terminal:…:…`
  // shape used by the task-terminal hook so the dedup window behaves
  // identically across categories.
  key: "chat_reply:chat-1:msg-1",
  title: "Chat reply",
  ...over,
});

// --- lifecycle --------------------------------------------------------------

beforeEach(() => {
  setSecureContext(true);
  installNotification("granted");
});

afterEach(() => {
  uninstallNotification();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dispatcher — chatReply category routing", () => {
  it("drops a chatReply fire when onChatReply is false (category gate)", () => {
    // `onChatReply: false` is the DEFAULT_PREFS value, but we set it
    // explicitly so the test does not depend on a future default flip.
    // Master switch is on so we are not accidentally short-circuiting at
    // the master gate one step earlier.
    const { d } = makeDispatcher({
      prefs: { enabled: true, onChatReply: false },
      isLeader: true,
    });
    d.fire(chatReplyEvent());
    expect(constructed).toHaveLength(0);
  });

  it("fires exactly one Notification when onChatReply is true, permission granted, and tab is leader", () => {
    const { d } = makeDispatcher({
      prefs: { enabled: true, onChatReply: true },
      isLeader: true,
    });
    d.fire(chatReplyEvent({ title: "Assistant replied" }));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Assistant replied");
    // Tag is the dedup key — verifies the routing path through fire()
    // populated the `tag` option, i.e. the chatReply category passed
    // through the same gates as the existing five categories rather than
    // taking a special-case branch.
    expect(constructed[0]?.opts?.tag).toBe("chat_reply:chat-1:msg-1");
  });

  it("does not affect routing of other categories", () => {
    // Cross-talk guard: turning chatReply on should not turn other
    // categories on, and turning chatReply off should not turn other
    // categories off. Two fires; only the one whose category is on
    // should land.
    const { d } = makeDispatcher({
      prefs: {
        enabled: true,
        onChatReply: false,
        onApprovalNeeded: true,
      },
      isLeader: true,
    });
    d.fire(chatReplyEvent({ key: "chat_reply:c:m" }));
    d.fire({
      category: "approval",
      key: "task_approval:42",
      title: "Approval needed",
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Approval needed");
  });
});
