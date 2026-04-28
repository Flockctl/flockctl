import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import type { AttentionItem } from "@/lib/api/attention";
import {
  Dispatcher,
  type Notifiable,
} from "@/lib/notification-dispatcher";
import { LeaderElection } from "@/lib/leader-election";
import { routeForNotification } from "@/lib/notification-click-router";
import { useNotificationClickRouter } from "@/lib/hooks/use-notification-click-router";
import { NotificationDispatcherProvider } from "@/lib/contexts/notification-dispatcher-context";
import { DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notification-prefs";

/**
 * Tests for the notification click → SPA route bridge:
 *
 *   1. `routeForNotification` — pure mapping. Each branch (terminal /
 *      task_*  / chat_* / fallback) is pinned independently because the
 *      router config is the source of truth for route strings, and a
 *      drift here lands users on a 404 silently.
 *
 *   2. Dispatcher.onclick wiring — the dispatcher attaches an `onclick`
 *      that closes the notification, focuses the window, and emits a
 *      `notification-click` event on its own EventTarget bus. Tests
 *      drive the click via the test-fake's onclick, then assert on
 *      bus emissions, close state, and window.focus invocation.
 *
 *   3. `useNotificationClickRouter` — subscribes to the bus and
 *      navigates. Tests render a tiny <MemoryRouter> tree, fire the
 *      bus event manually, and assert the location changed.
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
  (NotificationCtor as unknown as { permission: string }).permission = "granted";
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: NotificationCtor,
  });
}

function uninstallNotification(): void {
  Reflect.deleteProperty(window, "Notification");
}

// --- LeaderElection stub ---------------------------------------------------

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

function makeDispatcher(): Dispatcher {
  const prefs: NotificationPrefs = { ...DEFAULT_PREFS, enabled: true };
  return new Dispatcher(
    () => prefs,
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
// 1. routeForNotification — pure mapping
// ---------------------------------------------------------------------------

describe("routeForNotification", () => {
  it("routes a task_terminal notification to /tasks/{taskId}", () => {
    const n: Notifiable = {
      category: "done",
      key: "task_terminal:42:done",
      title: "Task completed",
      source: "task_terminal",
      taskId: "42",
    };
    expect(routeForNotification(n)).toBe("/tasks/42");
  });

  it("falls back to /attention when a task_terminal payload is missing taskId", () => {
    const n: Notifiable = {
      category: "done",
      key: "task_terminal:?:done",
      title: "Task completed",
      source: "task_terminal",
    };
    expect(routeForNotification(n)).toBe("/attention");
  });

  it("routes task_approval / task_permission / task_question to /tasks/{task_id}", () => {
    // Pair each item with its expected task_id explicitly so narrowing
    // on the discriminated union doesn't fight the for-loop iterator.
    const cases: Array<[AttentionItem, string]> = [
      [
        {
          kind: "task_approval",
          task_id: "11",
          project_id: "p1",
          title: "T",
          since: "2025-01-01",
        },
        "11",
      ],
      [
        {
          kind: "task_permission",
          task_id: "12",
          project_id: "p1",
          request_id: "r1",
          tool: "bash",
          since: "2025-01-01",
        },
        "12",
      ],
      [
        {
          kind: "task_question",
          request_id: "r2",
          task_id: "13",
          project_id: "p1",
          question: "?",
          multi_select: false,
          created_at: "2025-01-01",
        },
        "13",
      ],
    ];
    for (const [item, expectedId] of cases) {
      const n: Notifiable = {
        category: "approval",
        key: "k",
        title: "t",
        source: "attention",
        item,
      };
      expect(routeForNotification(n)).toBe(`/tasks/${expectedId}`);
    }
  });

  it("routes chat_approval / chat_permission / chat_question to /chats/{chat_id}", () => {
    const cases: Array<[AttentionItem, string]> = [
      [
        {
          kind: "chat_approval",
          chat_id: "21",
          project_id: "p1",
          title: "T",
          since: "2025-01-01",
        },
        "21",
      ],
      [
        {
          kind: "chat_permission",
          chat_id: "22",
          project_id: "p1",
          request_id: "r1",
          tool: "bash",
          since: "2025-01-01",
        },
        "22",
      ],
      [
        {
          kind: "chat_question",
          request_id: "r3",
          chat_id: "23",
          project_id: "p1",
          question: "?",
          multi_select: false,
          created_at: "2025-01-01",
        },
        "23",
      ],
    ];
    for (const [item, expectedId] of cases) {
      const n: Notifiable = {
        category: "approval",
        key: "k",
        title: "t",
        source: "attention",
        item,
      };
      expect(routeForNotification(n)).toBe(`/chats/${expectedId}`);
    }
  });

  it("falls back to /attention when neither item nor taskId is present", () => {
    const n: Notifiable = {
      category: "approval",
      key: "k",
      title: "t",
      source: "attention",
    };
    expect(routeForNotification(n)).toBe("/attention");
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatcher onclick + click bus
// ---------------------------------------------------------------------------

describe("Dispatcher.fire — onclick wiring", () => {
  it("attaches an onclick that closes the notification and emits notification-click on the bus", () => {
    const d = makeDispatcher();
    const seen: Notifiable[] = [];
    d.addEventListener("notification-click", (ev) =>
      seen.push((ev as CustomEvent<Notifiable>).detail),
    );

    const payload: Notifiable = {
      category: "approval",
      key: "task_approval:99",
      title: "Approval needed",
      source: "attention",
      item: {
        kind: "task_approval",
        task_id: "99",
        project_id: "p",
        title: "T",
        since: "2025",
      },
    };
    d.fire(payload);

    expect(constructed).toHaveLength(1);
    const note = constructed[0]!;
    expect(typeof note.onclick).toBe("function");
    expect(note.closed).toBe(false);

    // Simulate the OS click.
    note.onclick!.call(note, new Event("click"));

    expect(note.closed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe("task_approval:99");
    // The detail is the same Notifiable reference fire() received — the
    // bus must not lose the routing payload along the way.
    expect(seen[0]?.item).toBe(payload.item);
  });

  it("calls window.focus on click, swallowing throws", () => {
    const d = makeDispatcher();
    const focusSpy = vi
      .spyOn(window, "focus")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    const payload: Notifiable = {
      category: "approval",
      key: "k",
      title: "t",
      source: "attention",
    };
    d.fire(payload);
    const note = constructed[0]!;
    // Even when window.focus throws, the click handler still emits on
    // the bus and closes the notification — the try/catch around
    // focus() must not abort the rest of the handler.
    let busFired = false;
    d.addEventListener("notification-click", () => {
      busFired = true;
    });
    note.onclick!.call(note, new Event("click"));
    expect(focusSpy).toHaveBeenCalled();
    expect(busFired).toBe(true);
    expect(note.closed).toBe(true);
    focusSpy.mockRestore();
  });

  it("each fired notification keeps its own payload (closure isolation)", () => {
    const d = makeDispatcher();
    const seen: string[] = [];
    d.addEventListener("notification-click", (ev) =>
      seen.push((ev as CustomEvent<Notifiable>).detail.key),
    );
    d.fire({
      category: "approval",
      key: "k:a",
      title: "A",
      source: "attention",
    });
    d.fire({
      category: "approval",
      key: "k:b",
      title: "B",
      source: "attention",
    });
    expect(constructed).toHaveLength(2);
    // Click the second one first — the bus must dispatch B's payload,
    // not A's.
    constructed[1]!.onclick!.call(constructed[1]!, new Event("click"));
    constructed[0]!.onclick!.call(constructed[0]!, new Event("click"));
    expect(seen).toEqual(["k:b", "k:a"]);
  });
});

// ---------------------------------------------------------------------------
// 3. useNotificationClickRouter — bus → navigate
// ---------------------------------------------------------------------------

function CurrentLocation({ tap }: { tap: (path: string) => void }) {
  const loc = useLocation();
  tap(loc.pathname);
  return null;
}

function withProviders(children: ReactNode, dispatcher: Dispatcher) {
  return (
    <MemoryRouter initialEntries={["/dashboard"]}>
      <NotificationDispatcherProvider dispatcher={dispatcher}>
        <Routes>
          <Route path="*" element={children} />
        </Routes>
      </NotificationDispatcherProvider>
    </MemoryRouter>
  );
}

function ClickRouterHarness({ tap }: { tap: (path: string) => void }) {
  useNotificationClickRouter();
  return <CurrentLocation tap={tap} />;
}

describe("useNotificationClickRouter", () => {
  it("navigates to the route returned by routeForNotification on click bus event", () => {
    const d = makeDispatcher();
    const paths: string[] = [];
    render(withProviders(<ClickRouterHarness tap={(p) => paths.push(p)} />, d));

    // Baseline path from MemoryRouter.
    expect(paths.at(-1)).toBe("/dashboard");

    act(() => {
      d.dispatchEvent(
        new CustomEvent("notification-click", {
          detail: {
            category: "approval",
            key: "k",
            title: "t",
            source: "attention",
            item: {
              kind: "task_approval",
              task_id: "55",
              project_id: "p",
              title: "T",
              since: "2025",
            },
          } satisfies Notifiable,
        }),
      );
    });

    expect(paths.at(-1)).toBe("/tasks/55");
  });

  it("removes its bus listener on unmount (no navigation after teardown)", () => {
    const d = makeDispatcher();
    const paths: string[] = [];
    const { unmount } = render(
      withProviders(<ClickRouterHarness tap={(p) => paths.push(p)} />, d),
    );
    expect(paths.at(-1)).toBe("/dashboard");
    unmount();

    // After unmount, even an event on the bus must be a no-op — there
    // is no React tree to navigate, and we cleaned up the listener.
    // We can only assert indirectly: no throws, and constructing the
    // event doesn't crash on a torn-down navigator.
    expect(() => {
      d.dispatchEvent(
        new CustomEvent("notification-click", {
          detail: {
            category: "approval",
            key: "k",
            title: "t",
            source: "task_terminal",
            taskId: "9",
          } satisfies Notifiable,
        }),
      );
    }).not.toThrow();
  });

  it("end-to-end: fire() → click → bus → navigate", () => {
    const d = makeDispatcher();
    const paths: string[] = [];
    render(
      withProviders(<ClickRouterHarness tap={(p) => paths.push(p)} />, d),
    );

    act(() => {
      d.fire({
        // `failed` is on by default in DEFAULT_PREFS, so the master /
        // category gates pass without per-test pref tweaks. The
        // routing path is identical to "done" — we're exercising
        // task_terminal source, not the category mapping here.
        category: "failed",
        key: "task_terminal:777:failed",
        title: "Task failed",
        source: "task_terminal",
        taskId: "777",
      });
    });
    expect(constructed).toHaveLength(1);

    act(() => {
      constructed[0]!.onclick!.call(
        constructed[0]!,
        new Event("click"),
      );
    });

    expect(paths.at(-1)).toBe("/tasks/777");
  });
});
