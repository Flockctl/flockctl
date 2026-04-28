/**
 * Notification dispatcher.
 *
 * The single choke-point through which every desktop-notification request
 * flows. Each `fire()` call walks a fixed gate sequence and constructs a
 * `Notification` only if every gate passes:
 *
 *   1. Leader gate     — only the leader tab actually fires. Followers
 *                        short-circuit here. This is the *first* check by
 *                        design: leader status is the cheapest answer and
 *                        the most authoritative no-op signal. Followers
 *                        keep their React Query / diff caches warm via
 *                        whatever upstream produced the `Notifiable`, but
 *                        nothing past this line runs in a follower tab.
 *   2. Master gate     — `prefs.enabled` master switch.
 *   3. Category gate   — per-category toggle (`onApprovalNeeded`, …).
 *   4. Permission gate — browser `Notification.permission === "granted"`.
 *   5. Dedup gate      — same `key` within a short TTL collapses to one
 *                        notification. Stops a rapid stream of identical
 *                        events (e.g. fan-out from a websocket replay)
 *                        from spamming the OS notification center.
 *
 * The dispatcher does not own its inputs. Prefs, translation, and leader
 * election are injected so the same class can be unit-tested without
 * mounting React, and so production code can swap a real LeaderElection
 * for a stub in environments where it doesn't apply (Storybook, SSR).
 */

import type { AttentionItem } from "@/lib/api/attention";
import type { LeaderElection } from "@/lib/leader-election";
import type { NotificationPrefs } from "@/lib/notification-prefs";
import { getStatus } from "@/lib/notification-permission";

export type NotifiableCategory =
  | "approval"
  | "question"
  | "done"
  | "failed"
  | "blocked"
  | "chatReply";

export interface Notifiable {
  /** Category — maps 1:1 to the per-category prefs flag. */
  category: NotifiableCategory;
  /** Stable identifier for dedup. Same key fired twice within the TTL is
   *  collapsed to one notification. Pick something that makes sense for
   *  the upstream event (e.g. `"task:123:status"`). */
  key: string;
  /** Title shown in the OS notification. */
  title: string;
  /** Optional body text. */
  body?: string;
  /** Optional URL to open when the user clicks the notification. The
   *  dispatcher does not currently wire click → navigation; this is
   *  passed through for callers that want to set it on the resulting
   *  `Notification` themselves via the "fired" event. */
  url?: string;
  /** Origin of this notification. Drives auto-close TTL: terminal task
   *  notifications ("done"/"failed") are not naturally resolved by an
   *  inbox row disappearing the way attention items are, so we
   *  artificially close them after a fixed window so they don't sit
   *  forever in the OS notification center. Absence is treated as
   *  "attention" (no TTL). */
  source?: "attention" | "task_terminal";
  /**
   * Routing payload — used by `routeForNotification` (see
   * `notification-click-router.ts`) to decide which SPA route to navigate
   * to when the user clicks the OS notification.
   *
   *   - For `source: "attention"` callers: pass the originating
   *     `AttentionItem`; the router reads `kind` + `task_id` / `chat_id`.
   *   - For `source: "task_terminal"` callers: pass `taskId` directly
   *     (no inbox row exists for this category).
   *
   * Absence falls back to `/attention` so a malformed payload never
   * leaves the user stranded mid-click.
   */
  item?: AttentionItem;
  taskId?: string;
  /**
   * Chat-reply routing payload. Used by `routeForNotification` for the
   * `chatReply` category (the WebSocket `chat_assistant_final` event):
   * the click should land the user on the chat detail with the new
   * assistant message scrolled into view.
   *
   *   - `chatId` is the parent chat the assistant message belongs to;
   *     navigation lands on `/chats/${chatId}`.
   *   - `messageId` is appended as a hash fragment (`#message-${id}`)
   *     so the existing chat-detail deep-link-to-message scroll
   *     behaviour can pick it up. Adding the hash here is a no-op for
   *     chat detail surfaces that don't (yet) read it — the path
   *     itself still resolves cleanly.
   *
   * Absence of `chatId` falls back to `/attention`, mirroring every
   * other routing branch in `notification-click-router.ts`.
   */
  chatId?: string;
  messageId?: string;
}

/** Translation function. Keys are dot-paths into the locale tree. */
export type TranslateFn = (key: string) => string;

const CATEGORY_PREF: Record<NotifiableCategory, keyof NotificationPrefs> = {
  approval: "onApprovalNeeded",
  question: "onQuestionAsked",
  done: "onTaskDone",
  failed: "onTaskFailed",
  blocked: "onTaskBlocked",
  // Slice 02 of M15: route the WebSocket `chat_assistant_final` event onto
  // the `chatReply` category, gated by the `onChatReply` pref. The dispatcher
  // itself is event-kind-agnostic — the upstream hook that observes the WS
  // frame translates `kind: "chat_assistant_final"` into `category:
  // "chatReply"` before calling `fire()`. Suppression rules (focus,
  // attention conflict) are layered on by the chat-reply runner in slice 01;
  // the dispatcher's job here is only to honour the per-category gate.
  chatReply: "onChatReply",
};

const DEDUP_TTL_MS = 5_000;
/**
 * Auto-close window for `source: "task_terminal"` notifications. Terminal
 * task events (done / failed) don't have an inbox row that disappears, so
 * the bidirectional inbox diff would never call `resolveByKey` for them;
 * without an explicit timer they'd sit in the OS notification center
 * indefinitely. Five minutes matches the longest "I just stepped away"
 * window users actually pay attention to in practice.
 */
const TASK_TERMINAL_TTL_MS = 5 * 60 * 1000;

export class Dispatcher extends EventTarget {
  // Map<dedupKey, expireAt-ms>. We sweep on each fire() rather than running
  // a setInterval — keeps the dispatcher zero-cost when idle.
  private recent = new Map<string, number>();
  /**
   * Live `Notification` handles indexed by their dedup key. Populated on
   * every successful `fire()` and drained by `resolveByKey()` (called by
   * the upstream attention diff when the originating row disappears) or
   * by the `onclose` callback (user dismissed it manually). Keeping the
   * map small is an explicit goal — naturally bounded by the size of the
   * inbox + a handful of in-flight terminal notifications.
   */
  private handles = new Map<string, Notification>();
  private readonly getPrefs: () => NotificationPrefs;
  // `t` is held for future use (localised titles/bodies driven by category
  // alone). Currently callers pass already-translated strings, but the
  // signature is kept so a later slice can move that logic in here
  // without a constructor break.
  private readonly t: TranslateFn;
  private readonly _leader: LeaderElection;

  constructor(
    getPrefs: () => NotificationPrefs,
    t: TranslateFn,
    leader: LeaderElection,
  ) {
    super();
    this.getPrefs = getPrefs;
    this.t = t;
    this._leader = leader;
  }

  /** Read-only access to the LeaderElection so React hooks (and only
   *  hooks) can subscribe to becameLeader / becameFollower events.
   *  Imperative callers should never need this — `fire()` already gates
   *  on it internally. */
  get leader(): LeaderElection {
    return this._leader;
  }

  fire(n: Notifiable): void {
    // Gate 1: leader-first. A follower tab walks no further; the dispatch
    // is a true no-op (no Notification constructed, no events emitted).
    if (!this._leader.isLeader()) return;

    // Gate 2: master switch.
    const prefs = this.getPrefs();
    if (!prefs.enabled) return;

    // Gate 3: per-category toggle.
    const prefKey = CATEGORY_PREF[n.category];
    if (!prefs[prefKey]) return;

    // Gate 4: browser permission.
    if (getStatus() !== "granted") return;

    // Gate 5: dedup. Sweep the dedup map opportunistically to keep memory
    // bounded; the loop is O(n) over the small set of keys still inside
    // their TTL window.
    const now = Date.now();
    for (const [k, expireAt] of this.recent) {
      if (expireAt <= now) this.recent.delete(k);
    }
    if (this.recent.has(n.key)) return;
    this.recent.set(n.key, now + DEDUP_TTL_MS);

    // Overwrite-with-close: if a previous handle for this key is still
    // live, close it before constructing the replacement. The dedup gate
    // above means we only reach this line outside the dedup window — i.e.
    // the previous fire was long enough ago that an OS-level redraw is
    // expected. Without this, the OS notification center can pile up
    // multiple identical entries when a slow event keeps re-firing past
    // the dedup TTL; `tag` deduplicates rendering, but Safari (and some
    // Linux notification daemons) still keep the older instance "live"
    // for our purposes — explicit close() is the only portable signal.
    const prevHandle = this.handles.get(n.key);
    if (prevHandle) {
      try {
        prevHandle.close();
      } catch {
        // close() can throw on a notification the OS already dismissed;
        // swallowing is safe — we're about to drop the reference anyway.
      }
      this.handles.delete(n.key);
    }

    // All gates passed — construct the OS notification.
    try {
      // `Notification` is the global constructor; we've already verified
      // permission === "granted" above, but the call can still throw in
      // weird browser configurations (private mode, content-blocking
      // extensions). Swallow so a malformed Notifiable can't take down
      // whatever upstream code called fire().
      const NotifCtor = (window as unknown as {
        Notification: typeof Notification;
      }).Notification;
      // `tag` is the OS-level dedup key. Browsers collapse same-tag
      // notifications into a single in-place update rather than stacking
      // — orthogonal to our internal handle map (which exists so we can
      // proactively close on resolve / TTL).
      const opts: NotificationOptions = { tag: n.key };
      if (n.body) opts.body = n.body;
      const notification = new NotifCtor(n.title, opts);
      // The unit-test fake constructor doesn't return a real object, so
      // `notification` may be undefined or a plain `{}`. Guard before
      // wiring lifecycle handlers.
      if (notification && typeof notification === "object") {
        try {
          (notification as Notification).onclose = () => {
            // Only delete if we still own this slot — a later fire() may
            // have overwritten it, in which case the handler firing for
            // the old handle must NOT evict the new one.
            if (this.handles.get(n.key) === notification) {
              this.handles.delete(n.key);
            }
          };
        } catch {
          // Some test fakes intentionally make onclose unsettable; not a
          // problem — the registry just won't auto-clean for that handle,
          // and the upstream resolver (or process exit) will cover it.
        }
        // Wire the click bus. The OS-fired `click` callback runs OUTSIDE
        // any React tree (it's the platform notification daemon, not the
        // browser event loop the SPA owns), so we can't `useNavigate` from
        // inside the dispatcher. Instead, the dispatcher re-emits the
        // payload as a `notification-click` event on its own EventTarget;
        // a thin React hook (`useNotificationClickRouter`) listens to that
        // bus and performs the navigation. Keeping the dispatcher
        // router-unaware preserves its testability — the unit suite never
        // has to mount react-router-dom to exercise click semantics.
        try {
          (notification as Notification).onclick = () => {
            // Best-effort: focus the tab so the navigation is visible
            // even when Flockctl was hidden behind another window. Both
            // calls can throw under restrictive permission configs (the
            // user-activation gate fluctuates between browsers); each is
            // wrapped because partial success is still better than
            // bailing entirely on the click.
            try {
              window.focus();
            } catch {
              // intentional swallow — see comment above.
            }
            try {
              (notification as Notification).close();
            } catch {
              // close() can throw on a notification the OS already
              // dismissed (race between user action and click). The
              // registry's onclose handler still runs.
            }
            this.dispatchEvent(
              new CustomEvent("notification-click", { detail: n }),
            );
          };
        } catch {
          // Some test fakes intentionally make onclick unsettable; the
          // bus simply won't fire for them. Acceptable — those tests
          // exercise a path that doesn't depend on click routing.
        }
        this.handles.set(n.key, notification);
      }

      if (n.source === "task_terminal") {
        // Schedule a self-close at the terminal TTL. setTimeout is used
        // (not the dedup map's expiry sweep) because the TTL is much
        // longer than the dedup window and we want it tracked
        // independently of further fire() calls — even if no one ever
        // calls fire() again, the notification still goes away.
        setTimeout(() => this.resolveByKey(n.key), TASK_TERMINAL_TTL_MS);
      }

      // Fire a synthetic event so observers (tests, future click-to-navigate
      // wiring) can react without inspecting the OS notification center.
      this.dispatchEvent(new CustomEvent("fired", { detail: n }));
    } catch (err) {
      console.warn("[notification-dispatcher] failed to construct", err);
    }
    // Reference `t` so TS doesn't warn unused-private-field. Removing the
    // field would be a constructor break; keeping it cheap until used.
    void this.t;
  }

  /**
   * Close the live notification associated with `key`, if any. Called by
   * the inbox-driven hook for every key in `removedKeys` from the
   * bidirectional diff (the row disappeared from `/attention` →
   * the user has resolved the underlying request elsewhere → the OS
   * notification is now stale and should be dismissed). No-op if the
   * key isn't currently in the registry. Safe to call from any context.
   */
  resolveByKey(key: string): void {
    const handle = this.handles.get(key);
    if (!handle) return;
    this.handles.delete(key);
    try {
      handle.close();
    } catch {
      // see comment in fire() for why close() can throw.
    }
  }
}

// ---------------------------------------------------------------------------
// Pure diff helper — used by the inbox-driven notification pipeline.
//
// Computes "items present in `next` that weren't in `prev`" using a stable
// per-item key (kind + id). Title / body changes on the same logical row
// are NOT treated as new attention; only fresh keys count. The function is
// intentionally pure: no module-scope cache, no deep-equal — Set lookup on
// keys is O(n+m) and trivially correct.
//
// First-call semantics: when `prev === null`, the caller has no baseline
// yet (e.g. the React hook just mounted). Returning `next` here would fire
// a notification storm for whatever was already in the inbox at mount
// time, so we collapse the first call to []. The hook flips its ref from
// null → []; subsequent calls then diff normally.
//
// Note: `prev === []` (empty but not null) is a real observation — "we saw
// the list and it was empty" — so a `[] → [item]` transition does fire.
// ---------------------------------------------------------------------------

/**
 * Stable per-item key used by both the inbox diff and the dispatcher's
 * handle registry. Exported because the inbox-driven hook needs to fire()
 * with a key that matches what `removedKeys` returns from the
 * bidirectional diff — using a different convention on either side would
 * leave handles orphaned in the registry forever.
 */
export function attentionItemKey(item: AttentionItem): string {
  switch (item.kind) {
    case "task_approval":
    case "task_permission":
      return `${item.kind}:${item.task_id}`;
    case "chat_approval":
    case "chat_permission":
      return `${item.kind}:${item.chat_id}`;
    case "task_question":
    case "chat_question":
      return `${item.kind}:${item.request_id}`;
    default:
      // Exhaustiveness fallback. Unreachable while the union above covers
      // every backend kind, but cheap to keep so a future kind doesn't
      // silently key-collide on `undefined`.
      return `unknown:${JSON.stringify(item)}`;
  }
}

// Internal alias kept for symmetry with the original implementation.
const keyOf = attentionItemKey;

/**
 * Bidirectional diff: returns BOTH new arrivals (`added`) and the keys of
 * rows that disappeared since the last poll (`removedKeys`). The hook
 * uses `added` to fire fresh notifications and `removedKeys` to resolve
 * (close) handles for inbox rows the user has cleared — including from a
 * different surface like the API or another tab.
 *
 * Same first-call semantics as `diffAttentionForNotifications`: `prev ===
 * null` produces the empty result on both sides so a fresh mount with a
 * non-empty inbox neither fires a storm nor (worse) immediately resolves
 * notifications that were left over from a previous tab.
 */
export function diffAttentionForNotificationsBidirectional(
  prev: AttentionItem[] | null,
  next: AttentionItem[],
): { added: AttentionItem[]; removedKeys: string[] } {
  if (prev === null) return { added: [], removedKeys: [] };
  // Build prev as a Map (not just a Set) so the structure is amenable to
  // future growth (e.g. tracking last-seen titles to detect "changed"
  // items) without a second pass — the contract today is membership-only.
  const prevByKey = new Map<string, AttentionItem>(
    prev.map((i) => [keyOf(i), i] as const),
  );
  const nextKeys = new Set(next.map(keyOf));
  const added = next.filter((item) => !prevByKey.has(keyOf(item)));
  const removedKeys: string[] = [];
  for (const k of prevByKey.keys()) {
    if (!nextKeys.has(k)) removedKeys.push(k);
  }
  return { added, removedKeys };
}

/**
 * Returns the items in `next` whose key (kind + id) is not in `prev`.
 * When `prev === null` (first call), returns [] — establishes the
 * baseline without firing notifications for pre-existing inbox entries.
 *
 * Thin wrapper over the bidirectional diff. Kept as a separate export so
 * the M0 callsites that only care about additions don't have to deal
 * with `removedKeys`.
 */
export function diffAttentionForNotifications(
  prev: AttentionItem[] | null,
  next: AttentionItem[],
): AttentionItem[] {
  return diffAttentionForNotificationsBidirectional(prev, next).added;
}
