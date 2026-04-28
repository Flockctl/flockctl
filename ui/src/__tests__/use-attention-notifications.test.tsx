import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { AttentionItem } from "@/lib/api/attention";
import { Dispatcher, type Notifiable } from "@/lib/notification-dispatcher";
import { LeaderElection } from "@/lib/leader-election";
import {
  AttentionNotificationsRunner,
  isFocusedOnSameEntity,
} from "@/lib/hooks/use-attention-notifications";
import {
  NotificationDispatcherProvider,
  useNotificationDispatcher,
} from "@/lib/contexts/notification-dispatcher-context";
import { DEFAULT_PREFS, type NotificationPrefs } from "@/lib/notification-prefs";

/**
 * Contract tests for `useAttentionNotifications`.
 *
 * The hook is a thin pump:
 *   - subscribes to `useAttention()`,
 *   - diffs against its previous snapshot via the bidirectional helper,
 *   - calls `dispatcher.fire(...)` per genuinely new item, unless the
 *     user is already on the entity's detail route in a focused tab,
 *   - calls `dispatcher.resolveByKey(...)` for rows that disappeared so
 *     a stale OS notification gets dismissed automatically.
 *
 * The dispatcher is the integration boundary; tests inject a real
 * Dispatcher with a stubbed leader (always leader) and stubbed prefs
 * (master + every category ON) so the only gates being exercised are
 * the hook's own — diff baseline, isLoading guard, and the self-poke
 * suppression rule.
 */

// --- useAttention mock (must come before any import of the hook) -----------
//
// React doesn't re-render a tree when out-of-band state changes — we have
// to push the new attention snapshot through a real subscription so the
// hook's parent component is invalidated. `useSyncExternalStore` is the
// idiomatic surface for that: setAttention() bumps a version counter and
// notifies subscribers; the mock'd useAttention reads through it so the
// returned `items` reference flips on every snapshot replacement.

import { useSyncExternalStore } from "react";

const { attentionStore } = vi.hoisted(() => {
  const state = {
    snapshot: {
      items: [] as unknown[],
      isLoading: false,
    },
    subscribers: new Set<() => void>(),
  };
  return {
    attentionStore: {
      get: () => state.snapshot,
      set: (next: { items: unknown[]; isLoading: boolean }) => {
        state.snapshot = next;
        state.subscribers.forEach((cb) => cb());
      },
      subscribe: (cb: () => void) => {
        state.subscribers.add(cb);
        return () => state.subscribers.delete(cb);
      },
    },
  };
});

vi.mock("@/lib/hooks/attention", () => ({
  useAttention: () => {
    const snap = useSyncExternalStore(
      attentionStore.subscribe,
      attentionStore.get,
      attentionStore.get,
    );
    return {
      items: snap.items,
      total: snap.items.length,
      isLoading: snap.isLoading,
      error: null,
      connectionState: "open" as const,
    };
  },
}));

function setAttention(next: { items: AttentionItem[]; isLoading: boolean }): void {
  attentionStore.set(next as { items: unknown[]; isLoading: boolean });
}

// --- LeaderElection stub ----------------------------------------------------

class StubLeader extends EventTarget {
  isLeader(): boolean {
    return true;
  }
  start(): void {
    /* no-op for unit tests */
  }
  stop(): void {
    /* no-op */
  }
}

// --- window.Notification harness -------------------------------------------

let constructed: Array<{ title: string; body?: string; tag?: string }>;

function installNotification(): void {
  constructed = [];
  // The dispatcher always sets `tag` and conditionally `body`; record
  // both so payload-shape tests can assert against either.
  const fake = function NotificationCtor(
    this: Record<string, unknown>,
    title: string,
    opts?: NotificationOptions,
  ) {
    constructed.push({ title, body: opts?.body, tag: opts?.tag });
    // Return `this` implicitly so the dispatcher's onclose-wiring branch
    // sees a truthy object and can attach the lifecycle handler.
  } as unknown as { permission: string };
  fake.permission = "granted";
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: fake,
  });
}

// Earlier suites in this project (e.g. server-store) install their own
// localStorage stub and never restore it; jsdom's default may also be
// gone by the time this file runs. Reinstall a deterministic mock per
// test so file-order doesn't change behaviour.
let storageStore: Record<string, string>;
const stubStorage = {
  getItem: (k: string) => (k in storageStore ? storageStore[k] : null),
  setItem: (k: string, v: string) => {
    storageStore[k] = v;
  },
  removeItem: (k: string) => {
    delete storageStore[k];
  },
  clear: () => {
    storageStore = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  storageStore = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: stubStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: stubStorage,
    configurable: true,
    writable: true,
  });
  // jsdom defaults `isSecureContext` to false; the dispatcher's
  // permission gate (via getStatus) folds that into "insecure-context"
  // which fails the gate and silently no-ops every fire(). Force-true
  // for the duration of the test so the gate evaluates the (granted)
  // Notification.permission stub instead.
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    writable: true,
    value: true,
  });
  installNotification();
  setAttention({ items: [], isLoading: false });
  // Master + every category ON so the hook's gating shows through.
  const fullPrefs: NotificationPrefs = {
    ...DEFAULT_PREFS,
    enabled: true,
    onApprovalNeeded: true,
    onQuestionAsked: true,
    onTaskBlocked: true,
    onTaskFailed: true,
    onTaskDone: true,
  };
  window.localStorage.setItem(
    "flockctl.notifications.v1",
    JSON.stringify(fullPrefs),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "Notification");
});

// --- helpers ----------------------------------------------------------------

function taskApproval(taskId: string, title = "Approve me"): AttentionItem {
  return {
    kind: "task_approval",
    task_id: taskId,
    project_id: "p1",
    title,
    since: "2026-01-01T00:00:00Z",
  };
}

function chatApproval(chatId: string, title = "Chat approval"): AttentionItem {
  return {
    kind: "chat_approval",
    chat_id: chatId,
    project_id: "p1",
    title,
    since: "2026-01-01T00:00:00Z",
  };
}

function taskQuestion(requestId: string, taskId = "t1"): AttentionItem {
  return {
    kind: "task_question",
    request_id: requestId,
    task_id: taskId,
    project_id: "p1",
    question: "Pick one",
    multi_select: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeDispatcher(): Dispatcher {
  const election = new StubLeader() as unknown as LeaderElection;
  return new Dispatcher(
    () => {
      const raw = window.localStorage.getItem("flockctl.notifications.v1");
      if (!raw) return DEFAULT_PREFS;
      try {
        return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
      } catch {
        return DEFAULT_PREFS;
      }
    },
    (k) => k,
    election,
  );
}

/**
 * Render the runner under a MemoryRouter at `pathname`, with a
 * NotificationDispatcherProvider injecting the supplied (or freshly
 * built) dispatcher. Returns a `flush` helper that triggers a re-render
 * inside `act()` so the hook's effect picks up the updated attention
 * state set via `setAttention`.
 */
function mountAt(
  pathname: string,
  opts: { dispatcher?: Dispatcher; extra?: React.ReactNode } = {},
): { flush: () => void; unmount: () => void; dispatcher: Dispatcher } {
  const dispatcher = opts.dispatcher ?? makeDispatcher();
  const tree = (
    <MemoryRouter initialEntries={[pathname]}>
      <NotificationDispatcherProvider dispatcher={dispatcher}>
        {opts.extra}
        <AttentionNotificationsRunner />
      </NotificationDispatcherProvider>
    </MemoryRouter>
  );
  const utils = render(tree);
  // `flush` is a no-op alias kept for call-site readability — the
  // useSyncExternalStore-backed mock pushes updates synchronously when
  // setAttention() runs, so once the test calls setAttention() the React
  // tree has already been notified inside an act() boundary by the
  // store's subscriber callback. Wrapping in act() guards against a
  // future bump of React forcing async dispatch.
  return {
    flush: () => {
      act(() => {
        // Read+write the snapshot is a cheap way to flush any pending
        // effects without producing a state diff (the snapshot reference
        // is unchanged, so subscribers are still notified but
        // useSyncExternalStore short-circuits on equal snapshots).
        attentionStore.set(attentionStore.get());
      });
    },
    unmount: utils.unmount,
    dispatcher,
  };
}

// ---------------------------------------------------------------------------
// Tests — isFocusedOnSameEntity (pure function)
// ---------------------------------------------------------------------------

describe("isFocusedOnSameEntity", () => {
  it("returns false when the tab does not have focus (background tab)", () => {
    expect(isFocusedOnSameEntity(taskApproval("42"), "/tasks/42", false)).toBe(
      false,
    );
  });

  it("matches /tasks/{taskId} for task_approval, task_permission, task_question", () => {
    const t = taskApproval("42");
    expect(isFocusedOnSameEntity(t, "/tasks/42", true)).toBe(true);
    expect(isFocusedOnSameEntity(t, "/tasks/41", true)).toBe(false);
    expect(isFocusedOnSameEntity(t, "/tasks", true)).toBe(false);
    expect(
      isFocusedOnSameEntity(
        {
          kind: "task_permission",
          task_id: "9",
          project_id: "p",
          request_id: "r",
          tool: "Bash",
          since: "2026-01-01T00:00:00Z",
        },
        "/tasks/9",
        true,
      ),
    ).toBe(true);
    expect(isFocusedOnSameEntity(taskQuestion("r1", "9"), "/tasks/9", true)).toBe(
      true,
    );
  });

  it("matches /chats/{chatId} for chat_approval", () => {
    const c = chatApproval("7");
    expect(isFocusedOnSameEntity(c, "/chats/7", true)).toBe(true);
    expect(isFocusedOnSameEntity(c, "/chats/8", true)).toBe(false);
  });

  it("returns false on unrelated routes (e.g. /dashboard)", () => {
    expect(isFocusedOnSameEntity(taskApproval("42"), "/dashboard", true)).toBe(
      false,
    );
    expect(isFocusedOnSameEntity(chatApproval("7"), "/dashboard", true)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — useAttentionNotifications (via AttentionNotificationsRunner)
// ---------------------------------------------------------------------------

describe("useAttentionNotifications — baseline & loading guard", () => {
  it("does not fire on first render even when the inbox is non-empty (mount-storm guard)", () => {
    setAttention({
      items: [taskApproval("1"), chatApproval("2"), taskQuestion("q1")],
      isLoading: false,
    });
    mountAt("/dashboard");
    expect(constructed).toHaveLength(0);
  });

  it("does not capture an empty baseline while React Query is still loading", () => {
    // Initial: loading. Hook waits.
    setAttention({ items: [], isLoading: true });
    const { flush } = mountAt("/dashboard");
    expect(constructed).toHaveLength(0);

    // First real payload arrives — would have been a "storm" if the
    // loading-state items=[] had been captured as the baseline.
    setAttention({
      items: [taskApproval("1"), taskApproval("2")],
      isLoading: false,
    });
    flush();
    expect(constructed).toHaveLength(0);
  });

  it("fires only for genuinely new items on subsequent updates", () => {
    setAttention({ items: [taskApproval("1")], isLoading: false });
    const { flush } = mountAt("/dashboard");
    expect(constructed).toHaveLength(0);

    // Add a new item — fires once.
    setAttention({
      items: [taskApproval("1"), chatApproval("2")],
      isLoading: false,
    });
    flush();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.body).toBe("Chat approval");
    // The OS-level dedup tag carries the dispatcher key, which is what
    // `resolveByKey` and the inbox diff agree on.
    expect(constructed[0]?.tag).toBe("chat_approval:2");
  });

  it("does not refire on a refetch that returns the same items", () => {
    setAttention({ items: [taskApproval("1")], isLoading: false });
    const { flush } = mountAt("/dashboard");
    setAttention({ items: [taskApproval("1")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(0);
  });

  it("does not duplicate a notification when an item resolves and disappears", () => {
    setAttention({ items: [taskApproval("1")], isLoading: false });
    const { flush } = mountAt("/dashboard");
    expect(constructed).toHaveLength(0);

    // Item drops out of the inbox — diff returns added=[], no fire.
    setAttention({ items: [], isLoading: false });
    flush();
    expect(constructed).toHaveLength(0);
  });
});

describe("useAttentionNotifications — self-poke suppression", () => {
  it("does NOT fire when the focused route is the matching task detail page", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/tasks/42");
    setAttention({ items: [taskApproval("42")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(0);
  });

  it("DOES fire when the focused route is a DIFFERENT task than the new item", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/tasks/41");
    setAttention({ items: [taskApproval("42")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(1);
  });

  it("DOES fire even when on the matching route IF the tab is unfocused (background)", () => {
    // The OS notification IS the call to action when the tab is in the
    // background — suppression only kicks in when the user is actively
    // looking at the page that produced the event.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/tasks/42");
    setAttention({ items: [taskApproval("42")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(1);
  });

  it("matches chat_approval's chat_id against /chats/{id}", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/chats/7");
    setAttention({ items: [chatApproval("7")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(0);
  });

  it("fires for the items NOT matching the current route while suppressing the matching one", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/tasks/42");
    setAttention({
      items: [taskApproval("42"), chatApproval("99")],
      isLoading: false,
    });
    flush();
    // The /tasks/42 row is suppressed; the chat_approval still fires.
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.body).toBe("Chat approval");
  });
});

describe("useAttentionNotifications — payload shape", () => {
  it("uses the approval category title for task_approval rows", () => {
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/dashboard");
    setAttention({
      items: [taskApproval("1", "Specific row title")],
      isLoading: false,
    });
    flush();
    expect(constructed).toHaveLength(1);
    // Title comes from the locale category label.
    expect(constructed[0]?.title).toBe("Approval needed");
    // Row title (when present) lands in the body so the user sees what
    // the row was about past the category banner.
    expect(constructed[0]?.body).toBe("Specific row title");
  });

  it("uses the question category title for task_question rows", () => {
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/dashboard");
    setAttention({ items: [taskQuestion("q1", "5")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe("Agent asked a question");
    expect(constructed[0]?.body).toBe("Pick one");
  });

  it("tags every notification with attention_item_key for cross-tab dedup", () => {
    setAttention({ items: [], isLoading: false });
    const { flush } = mountAt("/dashboard");
    setAttention({ items: [taskApproval("42")], isLoading: false });
    flush();
    expect(constructed[0]?.tag).toBe("task_approval:42");
  });
});

describe("useAttentionNotifications — dispatcher integration", () => {
  it("walks through the dispatcher (so its 'fired' event observers see the notifiable)", () => {
    setAttention({ items: [], isLoading: false });

    const fired: Notifiable[] = [];
    const dispatcher = makeDispatcher();
    dispatcher.addEventListener("fired", (e) =>
      fired.push((e as CustomEvent<Notifiable>).detail),
    );

    const { flush } = mountAt("/dashboard", { dispatcher });
    setAttention({ items: [taskApproval("42")], isLoading: false });
    flush();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.category).toBe("approval");
    expect(fired[0]?.key).toBe("task_approval:42");
  });

  it("calls dispatcher.resolveByKey for rows that disappear from the inbox", () => {
    // Mount with a single attention row — establishes baseline.
    setAttention({ items: [taskApproval("42")], isLoading: false });
    const dispatcher = makeDispatcher();
    const resolveSpy = vi.spyOn(dispatcher, "resolveByKey");
    const { flush } = mountAt("/dashboard", { dispatcher });
    expect(resolveSpy).not.toHaveBeenCalled();

    // Row goes away (user approved from another surface). The hook
    // should ask the dispatcher to dismiss the dangling notification.
    setAttention({ items: [], isLoading: false });
    flush();
    expect(resolveSpy).toHaveBeenCalledWith("task_approval:42");
  });

  it("does not call resolveByKey on the very first poll (no baseline yet)", () => {
    setAttention({ items: [taskApproval("1")], isLoading: false });
    const dispatcher = makeDispatcher();
    const resolveSpy = vi.spyOn(dispatcher, "resolveByKey");
    mountAt("/dashboard", { dispatcher });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("uses the live dispatcher from context (provider plumbing smoke test)", () => {
    // Defensive against a regression where the runner stops calling
    // useNotificationDispatcher and silently does nothing. The probe
    // proves the same dispatcher reference threaded through the
    // provider is the one driving fire().
    let viaContext: ReturnType<typeof useNotificationDispatcher> = null;
    function Probe(): null {
      viaContext = useNotificationDispatcher();
      return null;
    }
    setAttention({ items: [], isLoading: false });
    const dispatcher = makeDispatcher();
    const { flush } = mountAt("/dashboard", { dispatcher, extra: <Probe /> });
    expect(viaContext).toBe(dispatcher);

    setAttention({ items: [taskApproval("99")], isLoading: false });
    flush();
    expect(constructed).toHaveLength(1);
  });
});
