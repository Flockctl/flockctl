/**
 * useAttentionNotifications — bridges the live attention inbox into the
 * notification dispatcher.
 *
 * Mounts once at the app shell (see `AttentionNotificationsRunner` below
 * and the `<NotificationDispatcherProvider>` wiring in `ui/src/main.tsx`).
 * Every time `useAttention()` produces a fresh `data` reference, the hook
 *
 *   1. Runs the *bidirectional* diff against the previous snapshot via
 *      `diffAttentionForNotificationsBidirectional`, returning both new
 *      arrivals and the keys of rows that disappeared.
 *   2. For each genuinely new item, calls `dispatcher.fire({ … })` once.
 *   3. For each removed key, calls `dispatcher.resolveByKey(key)` so the
 *      OS notification for an already-resolved row is dismissed
 *      automatically (the user approved/answered from the UI, the API,
 *      or another browser tab — we don't care which).
 *
 * The dispatcher already runs the permission/prefs/leader/dedup gates; this
 * hook owns the upstream "what's actually new / what's gone" question and
 * the self-poke suppression rule (see `isFocusedOnSameEntity`).
 *
 * Mount-time semantics — first run sets the baseline so an app that boots
 * with N already-pending attention items does NOT fire N notifications.
 * Subsequent diffs go through normally. The first call passes
 * `prevRef.current === null`, which the bidirectional diff collapses to
 * `{ added: [], removedKeys: [] }`; the ref then flips null → items and
 * later runs see real prev/next pairs.
 *
 * Loading-state guard — `useAttention` returns `items: []` while the
 * underlying React Query is still loading, which would establish an empty
 * baseline and then fire for everything that lands in the first real
 * payload. The hook waits for `isLoading === false` before touching
 * `prevRef`, so the baseline is always set from a real server response,
 * not the React Query default.
 *
 * Cross-tab handle ownership: `resolveByKey` only closes notifications
 * whose handles are in *this tab's* dispatcher registry. If the previous
 * leader tab opened the notification and was then demoted, this tab
 * (now leader) has no handle to close — the previous leader's
 * notification expires at the OS default (5–10s depending on platform).
 * Documented as an accepted edge case; the cost of broadcasting handle
 * ownership across tabs (the Notification API doesn't expose stable
 * handle IDs) outweighs the benefit.
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import type { AttentionItem } from "@/lib/api/attention";
import {
  attentionItemKey,
  diffAttentionForNotificationsBidirectional,
  type NotifiableCategory,
} from "@/lib/notification-dispatcher";
import { useNotificationDispatcher } from "@/lib/contexts/notification-dispatcher-context";

import enLocale from "@/locales/en.json";

import { useAttention } from "./attention";

const T = enLocale.notifications;

/**
 * Maps an inbox row to the dispatcher's `NotifiableCategory`. Permission
 * prompts are bucketed under `approval` because they share the same
 * "user must act before the agent continues" UX class — the master
 * `onApprovalNeeded` toggle is the single switch users expect to control
 * both flavours.
 */
function categoryFor(item: AttentionItem): NotifiableCategory {
  switch (item.kind) {
    case "task_approval":
    case "chat_approval":
    case "task_permission":
    case "chat_permission":
      return "approval";
    case "task_question":
    case "chat_question":
      return "question";
  }
}

/**
 * Stable dedup key fed to the dispatcher's gate-5 check. Delegates to
 * the exported `attentionItemKey` so the diff, the registry, and the
 * fire() key all share a single source of truth — drift here would
 * orphan handles in `dispatcher.handles` forever.
 */
const keyFor = attentionItemKey;

/**
 * Title shown in the OS notification. Pulled from the locale category
 * labels so a future translation slice can feed `T` from a hook without a
 * call-site change. The row's own `title` (when present — only the
 * `*_approval` kinds carry one) is shoved into the body so users see
 * something distinguishing past the category banner.
 */
function buildTitleAndBody(item: AttentionItem): {
  title: string;
  body?: string;
} {
  const category = categoryFor(item);
  switch (category) {
    case "approval": {
      const title = T.cat.approval;
      // Permission prompts intentionally omit the row title (tool args
      // can leak secrets — see `src/services/attention.ts`); fall back to
      // the tool name for those.
      let body: string | undefined;
      if (item.kind === "task_approval" || item.kind === "chat_approval") {
        body = item.title;
      } else if (
        item.kind === "task_permission" ||
        item.kind === "chat_permission"
      ) {
        body = item.tool;
      }
      return body ? { title, body } : { title };
    }
    case "question": {
      const title = T.cat.question;
      // `question` is always present on agent_questions rows.
      const body =
        item.kind === "task_question" || item.kind === "chat_question"
          ? item.question
          : undefined;
      return body ? { title, body } : { title };
    }
    default:
      // Exhaustiveness fallback. `categoryFor` only ever returns
      // "approval" / "question" today, but the dispatcher's
      // NotifiableCategory union also includes done / failed / blocked /
      // chatReply. If a future inbox kind starts mapping to one of the
      // task-status categories, we still emit *something* rather than
      // silently dropping the notification. `chatReply` is intentionally
      // excluded — chat replies never reach the attention pipeline (they
      // come off the WS via the chat-reply runner in slice 01), so an
      // inbox row carrying that category would be a programmer error and
      // should fall through to the generic title.
      if (
        category === "done" ||
        category === "failed" ||
        category === "blocked"
      ) {
        return { title: T.cat[category] };
      }
      return { title: T.cat.approval };
  }
}

/**
 * Self-poke suppression: don't fire a notification when the user is
 * already staring at the entity that produced it.
 *
 *   - `hasFocus === false` (background tab) → never suppress; the OS
 *     notification IS the call to action.
 *   - `task_*` items match `/tasks/{taskId}` exactly.
 *   - `chat_*` items match `/chats/{chatId}` exactly.
 *
 * Anything else falls through to "fire", including foregrounded but
 * unrelated routes (e.g. user is on `/dashboard` when a chat approval
 * lands — they should still get pinged).
 *
 * Exported for unit testing — the hook does not need it externally.
 */
export function isFocusedOnSameEntity(
  item: AttentionItem,
  pathname: string,
  hasFocus: boolean,
): boolean {
  if (!hasFocus) return false;
  switch (item.kind) {
    case "task_approval":
    case "task_permission":
    case "task_question":
      return pathname === `/tasks/${item.task_id}`;
    case "chat_approval":
    case "chat_permission":
    case "chat_question":
      return pathname === `/chats/${item.chat_id}`;
  }
}

/**
 * Subscribes to `useAttention` and forwards every freshly-arrived inbox
 * row into the notification dispatcher.
 *
 * Returns nothing — the hook is fire-and-forget; the only observable
 * effect is the OS notification it triggers via the dispatcher.
 *
 * Mount once at the React-tree root via `<AttentionNotificationsRunner />`
 * so the diff baseline lives per-tab (not per-route): re-mounting under a
 * route would reset `prevRef.current` to `null` on every navigation and
 * silently swallow notifications for rows that arrived during the
 * unmount/remount window.
 */
export function useAttentionNotifications(): void {
  const { items, isLoading } = useAttention();
  const prevRef = useRef<AttentionItem[] | null>(null);
  const dispatcher = useNotificationDispatcher();
  const location = useLocation();

  useEffect(() => {
    // Wait for the first real server response. While React Query is
    // still loading, useAttention surfaces `items: []` — capturing that
    // as the baseline would mis-fire for every row in the first real
    // payload.
    if (isLoading) return;
    // No provider mounted (unit tests, SSR) → nothing to fire into. We
    // still leave prevRef untouched so a later mount of a real
    // dispatcher under the same hook instance doesn't replay backlog.
    if (!dispatcher) return;

    const { added, removedKeys } = diffAttentionForNotificationsBidirectional(
      prevRef.current,
      items,
    );
    // Update the baseline BEFORE any side-effects so a synchronous
    // re-entry (paranoid, but cheap insurance) sees the new state.
    prevRef.current = items;

    // Resolve disappearances first. Doing this before fire() means a
    // pathological "row vanished and re-appeared in the same poll" stays
    // a no-op for the registry (close → fire constructs a fresh handle)
    // rather than leaking the old handle.
    for (const key of removedKeys) {
      dispatcher.resolveByKey(key);
    }

    if (added.length === 0) return;

    const hasFocus =
      typeof document !== "undefined" ? document.hasFocus() : false;

    for (const item of added) {
      if (isFocusedOnSameEntity(item, location.pathname, hasFocus)) continue;
      const { title, body } = buildTitleAndBody(item);
      dispatcher.fire({
        category: categoryFor(item),
        key: keyFor(item),
        title,
        body,
        source: "attention",
        // Carry the originating row through to the click-router so a
        // user click navigates to the matching task / chat detail page.
        // The dispatcher itself never inspects this field.
        item,
      });
    }
    // location.pathname is intentionally a dep — pathname changes
    // shouldn't refire (prevRef is updated each run, so the diff is
    // empty), but we want the suppression check to read the *current*
    // route on the next genuine items change.
  }, [items, isLoading, dispatcher, location.pathname]);
}

/**
 * Mountable wrapper. The hook returns nothing renderable, but the app
 * needs to compose it inside the React tree so that `useAttention` (which
 * depends on `QueryClientProvider`) and `useNotificationDispatcher` (which
 * depends on `NotificationDispatcherProvider`) are both in scope. Sits
 * next to `<FaviconBadgeRunner />` in `ui/src/main.tsx`.
 */
export function AttentionNotificationsRunner(): null {
  useAttentionNotifications();
  return null;
}
