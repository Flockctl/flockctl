import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Dispatcher,
  type Notifiable,
} from "@/lib/notification-dispatcher";
import { LeaderElection } from "@/lib/leader-election";
import { routeForNotification } from "@/lib/notification-click-router";
import {
  DEFAULT_PREFS,
  type NotificationPrefs,
} from "@/lib/notification-prefs";

/**
 * M15 — click-to-navigate for chat_assistant_final notifications.
 *
 * Companion to `notification-dispatcher-chatreply-routing.test.ts` (which
 * pins the per-category gate that decides whether the OS notification is
 * even constructed). This file pins the click → navigation contract:
 *
 *   1. The dispatcher's existing onclick wiring (window.focus + close +
 *      bus emit) fires for chatReply just like it does for the four M14
 *      categories. We do NOT add a chatReply-special branch in the
 *      dispatcher itself — symmetry with the existing cases is the whole
 *      point.
 *
 *   2. `routeForNotification` returns `/chats/${chatId}#message-${messageId}`
 *      for a chatReply Notifiable carrying both fields. The `#message-…`
 *      fragment is emitted unconditionally — chat-detail surfaces that
 *      don't yet read it ignore the fragment; surfaces that do (or that
 *      will, in a follow-up slice) scroll the assistant message into view.
 *      No scroll code is added in this task.
 *
 *   3. Graceful degradation: with `chatId` only (no `messageId`), the
 *      route is the bare `/chats/${chatId}`. With neither field, the
 *      router falls back to `/attention` — same convention as every
 *      other routing branch.
 */

// --- Notification fake ------------------------------------------------------

interface FakeNotification {
  title: string;
  opts?: NotificationOptions;
  closed: boolean;
  onclose: ((this: FakeNotification) => void) | null;
  onclick: ((this: FakeNotification, ev: Event) => void) | null;
  close(): void;
}

let constructed: FakeNotification[];

function installNotification(): void {
  constructed = [];
  const NotificationCtor = function (
    this: FakeNotification,
    title: string,
    opts?: NotificationOptions,
  ) {
    this.title = title;
    this.opts = opts;
    this.closed = false;
    this.onclose = null;
    this.onclick = null;
    this.close = function (this: FakeNotification) {
      if (this.closed) return;
      this.closed = true;
      try {
        this.onclose?.call(this);
      } catch {
        // mirrors the dispatcher's swallow on close()
      }
    };
    constructed.push(this);
    return this;
  } as unknown as { permission: string };
  (NotificationCtor as unknown as { permission: string }).permission =
    "granted";
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: NotificationCtor,
  });
}

function uninstallNotification(): void {
  Reflect.deleteProperty(window, "Notification");
}

// --- LeaderElection stub ----------------------------------------------------

class StubLeader extends EventTarget {
  isLeader(): boolean {
    return true;
  }
  start(): void {
    /* no-op for unit tests — the real LeaderElection touches BroadcastChannel */
  }
  stop(): void {
    /* no-op */
  }
}

function makeDispatcher(
  prefs: Partial<NotificationPrefs> = {},
): Dispatcher {
  const live: NotificationPrefs = {
    ...DEFAULT_PREFS,
    enabled: true,
    onChatReply: true,
    ...prefs,
  };
  return new Dispatcher(
    () => live,
    (k) => k,
    new StubLeader() as unknown as LeaderElection,
  );
}

beforeEach(() => {
  installNotification();
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    writable: true,
    value: true,
  });
});

afterEach(() => {
  uninstallNotification();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. routeForNotification — chatReply branch
// ---------------------------------------------------------------------------

describe("routeForNotification — chatReply", () => {
  it("routes chatReply with chatId + messageId to /chats/{chatId}#message-{messageId}", () => {
    const n: Notifiable = {
      category: "chatReply",
      key: "chat_reply:chat-1:msg-7",
      title: "Assistant replied",
      chatId: "chat-1",
      messageId: "msg-7",
    };
    expect(routeForNotification(n)).toBe("/chats/chat-1#message-msg-7");
  });

  it("falls back to bare /chats/{chatId} when messageId is missing (graceful degradation)", () => {
    // Symmetric with the task-terminal `taskId`-only fallback. A click
    // payload that carries the parent chat but not the specific message
    // still lands the user on the chat detail; the hash is the polish.
    const n: Notifiable = {
      category: "chatReply",
      key: "chat_reply:chat-1:?",
      title: "Assistant replied",
      chatId: "chat-1",
    };
    expect(routeForNotification(n)).toBe("/chats/chat-1");
  });

  it("falls back to /attention when chatId is missing", () => {
    // Mirrors the task_terminal-without-taskId branch and the
    // attention-without-item branch — a malformed payload never strands
    // the user on a 404.
    const n: Notifiable = {
      category: "chatReply",
      key: "chat_reply:?:?",
      title: "Assistant replied",
    };
    expect(routeForNotification(n)).toBe("/attention");
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatcher onclick wiring — chatReply payload survives the bus round-trip
// ---------------------------------------------------------------------------

describe("Dispatcher.fire — chatReply onclick wiring", () => {
  it("clicking a chat_assistant_final notification calls window.focus(), closes the notification, and emits the chatReply payload on the bus", () => {
    const d = makeDispatcher();
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    const seen: Notifiable[] = [];
    d.addEventListener("notification-click", (ev) =>
      seen.push((ev as CustomEvent<Notifiable>).detail),
    );

    const payload: Notifiable = {
      category: "chatReply",
      key: "chat_reply:chat-9:msg-42",
      title: "Assistant replied",
      chatId: "chat-9",
      messageId: "msg-42",
    };
    d.fire(payload);

    expect(constructed).toHaveLength(1);
    const note = constructed[0]!;
    expect(typeof note.onclick).toBe("function");
    expect(note.closed).toBe(false);

    // Simulate the OS click.
    note.onclick!.call(note, new Event("click"));

    // Symmetry with the four M14 cases: focus → close → emit. No
    // chatReply-special branch in the dispatcher.
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(note.closed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.category).toBe("chatReply");
    expect(seen[0]?.chatId).toBe("chat-9");
    expect(seen[0]?.messageId).toBe("msg-42");
    // The same Notifiable reference flows through the bus — the
    // routing payload must not be reshaped along the way.
    expect(seen[0]).toBe(payload);

    focusSpy.mockRestore();
  });

  it("end-to-end: routeForNotification on the bus payload yields /chats/{chatId}#message-{messageId}", () => {
    // Verifies the contract that downstream `useNotificationClickRouter`
    // relies on: feeding the bus payload back through
    // `routeForNotification` produces exactly the URL the user expects
    // to land on. We don't mount a router here — the
    // notification-click-router.test.tsx file already pins the
    // bus → navigate bridge for non-chatReply categories, and the
    // routing function is pure.
    const d = makeDispatcher();
    let routed: string | null = null;
    d.addEventListener("notification-click", (ev) => {
      routed = routeForNotification(
        (ev as CustomEvent<Notifiable>).detail,
      );
    });

    d.fire({
      category: "chatReply",
      key: "chat_reply:chat-x:msg-y",
      title: "Assistant replied",
      chatId: "chat-x",
      messageId: "msg-y",
    });

    expect(constructed).toHaveLength(1);
    constructed[0]!.onclick!.call(constructed[0]!, new Event("click"));

    expect(routed).toBe("/chats/chat-x#message-msg-y");
  });
});
