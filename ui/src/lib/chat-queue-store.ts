import { useCallback, useSyncExternalStore } from "react";
import type { ChatMessageCreate } from "@/lib/types";
import { NEW_CHAT_DRAFT_KEY } from "@/lib/chat-draft-store";

/**
 * Per-chat queued-messages store, kept in memory for the lifetime of the tab.
 *
 * `ChatConversation` is remounted on every chat switch (the parent passes
 * `key={selectedChatId}`), so the queue used to live in `useChatStream`'s
 * component-local `useState`. That meant every navigation away wiped any
 * messages the user had lined up while the agent was still responding —
 * silently, with no indication the queued prompts had been dropped.
 *
 * This store mirrors `chat-draft-store` (text drafts) and
 * `chat-attachment-draft-store` (attachment chips): a module-level map keyed
 * by chat id, plus a tiny pub/sub so any mounted hook re-renders when the
 * queue for its chat changes. Result: queued messages survive chat switches
 * and fire as soon as their owning chat's turn ends, even after the user has
 * been browsing elsewhere in the meantime.
 *
 * Deliberately NOT persisted to localStorage — queued prompts may carry
 * sensitive context, and replaying them after a browser restart would
 * either resend on top of state the user no longer remembers ("did I send
 * that?") or be silently dropped if the chat has moved on. Tab-scoped
 * lifetime matches the existing draft stores.
 */

export interface QueuedChatMessage {
  /** Per-entry id so the UI can target a specific chip (e.g. ✕ button). */
  id: string;
  /** Chat the entry belongs to. Drain checks this against the live chatId. */
  chatId: string;
  /** Streaming-endpoint payload (content, model, key, attachments, etc.). */
  data: ChatMessageCreate;
  /** Forwarded so the eventual `startStream` invalidates the project tree. */
  opts?: { projectId?: string };
}

/** Shared empty-array sentinel so `useSyncExternalStore` returns a stable
 *  reference for chats with no queue and doesn't trigger a re-render on
 *  every read. */
const EMPTY: readonly QueuedChatMessage[] = Object.freeze([]);

const queues = new Map<string, QueuedChatMessage[]>();
const subscribers = new Set<() => void>();
// Tracks chatIds whose `useChatStream` instance is currently mounted. The
// background queue-runner uses this to decide whether to drain a chat's
// queue itself: if a hook is mounted for `chatId` (the user is looking at
// that chat right now) the hook handles its own drain, and the runner
// stays out of the way to avoid both racing for `dequeueHead`. When the
// last hook for `chatId` unmounts (the user navigated away), the runner
// takes over so the queue keeps draining in the background.
const activeChats = new Map<string, number>();
// Tracks chatIds with a drain currently in flight — owned EITHER by a
// mounted hook's `startStream` OR by the background runner's `drainOne`.
// Both check this set before kicking off their own send so the two
// can't accidentally double-send in the brief race window where the
// hook starts a turn (sets cache `is_running=true` optimistically) but
// the runner sees stale active-chat / cache state and tries to drain
// the same head. Living in the store lets both readers synchronise
// against a single source of truth.
const inFlightDrains = new Set<string>();
let counter = 0;

function emit(): void {
  for (const fn of subscribers) fn();
}

/**
 * Subscribe to queue-store changes. Notified on every push/pop/clear AND
 * on `registerActiveChat`/release transitions. The runner attaches via
 * this hook to re-evaluate which chats are eligible for a background
 * drain whenever any of those signals move.
 */
export function subscribeChatQueueStore(cb: () => void): () => void {
  return subscribe(cb);
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function keyFor(chatId: string | null | undefined): string {
  return chatId ?? NEW_CHAT_DRAFT_KEY;
}

export function getQueue(chatId: string | null | undefined): QueuedChatMessage[] {
  return queues.get(keyFor(chatId)) ?? (EMPTY as QueuedChatMessage[]);
}

/**
 * Read-only enumeration of chatIds with at least one queued message.
 * Used by the background runner to know which chats need a drain attempt.
 * The returned array is a snapshot — mutating it does not affect the store.
 */
export function getAllChatsWithQueue(): string[] {
  const result: string[] = [];
  for (const [chatId, list] of queues) {
    if (list.length > 0) result.push(chatId);
  }
  return result;
}

/**
 * Peek at the head of `chatId`'s queue WITHOUT removing it. The runner
 * uses this to look at the message it's about to send before committing
 * to a `streamMessage` call: if the network rejects the request, the
 * entry has to stay at the head for retry, which `dequeueHead` would
 * have prevented by popping it preemptively.
 */
export function peekHead(
  chatId: string | null | undefined,
): QueuedChatMessage | null {
  const list = queues.get(keyFor(chatId));
  if (!list || list.length === 0) return null;
  return list[0] ?? null;
}

/**
 * Append a message to the queue for `chatId` and return its generated id.
 * The id is stable across re-renders so callers can pass it back to
 * `removeFromQueue` to drop a specific entry without touching the rest.
 */
export function enqueueMessage(
  chatId: string,
  data: ChatMessageCreate,
  opts?: { projectId?: string },
): string {
  const id = `queued-${++counter}-${Date.now()}`;
  const key = keyFor(chatId);
  const prev = queues.get(key) ?? [];
  queues.set(key, [...prev, { id, chatId, data, opts }]);
  emit();
  return id;
}

/**
 * Drop a single entry by id. Searches across every chat's queue because
 * callers (e.g. the ✕ button on a queued chip) only know the entry id, not
 * which chat it belongs to. Cheap — there are usually 0–3 chats with a
 * non-empty queue at once.
 */
export function removeFromQueue(id: string): void {
  let changed = false;
  for (const [key, list] of queues) {
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) continue;
    changed = true;
    if (next.length === 0) {
      queues.delete(key);
    } else {
      queues.set(key, next);
    }
  }
  if (changed) emit();
}

/**
 * Pop the head of `chatId`'s queue. Returns the popped entry (or `null`
 * if the queue was empty). Used by the drain effect in `useChatStream`
 * to start the next turn as soon as the previous one ends.
 */
export function dequeueHead(
  chatId: string | null | undefined,
): QueuedChatMessage | null {
  const key = keyFor(chatId);
  const list = queues.get(key);
  if (!list || list.length === 0) return null;
  const [head, ...rest] = list;
  if (!head) return null;
  if (rest.length === 0) {
    queues.delete(key);
  } else {
    queues.set(key, rest);
  }
  emit();
  return head;
}

/** Empty the queue for a single chat. Backs the "Clear queue" button. */
export function clearQueue(chatId: string | null | undefined): void {
  const key = keyFor(chatId);
  if (!queues.has(key)) return;
  queues.delete(key);
  emit();
}

/**
 * Move an entry inside `chatId`'s queue from `fromIndex` to `toIndex`.
 * Backs the drag-and-drop and Alt+↑/↓ keyboard reorder in the queued-
 * messages list. Returns `true` on a successful reorder, `false` if the
 * call was rejected (drain in flight, indices out of bounds, no-op move,
 * or queue empty / single-entry).
 *
 * Drain race. Both `dequeueHead` (the hook's drain) and the runner's
 * `peekHead`-then-`removeFromQueue` operate on `list[0]`. If the user
 * drags a head out of position 0 while the runner is mid-`fetch`, the
 * runner's later `removeFromQueue(head.id)` would still target the
 * *original* head id — which has now moved to a new index — and silently
 * remove the wrong-by-position entry. Worse, the runner already submitted
 * that original head to the daemon, so the user-perceived "position 1"
 * (now whatever they dragged into position 0) NEVER actually runs first.
 *
 * The fix: refuse to reorder while `isDrainInFlight(chatId)` is true.
 * Drains are short (a single SSE handshake) and the UI surfaces an
 * `aria-disabled` state on the list during the window, so the user sees
 * the rejection rather than getting a silent inconsistency. Callers that
 * want to know whether the reorder landed should check the return value.
 */
export function reorderQueue(
  chatId: string | null | undefined,
  fromIndex: number,
  toIndex: number,
): boolean {
  if (isDrainInFlight(chatId)) return false;
  const key = keyFor(chatId);
  const list = queues.get(key);
  if (!list || list.length < 2) return false;
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= list.length ||
    toIndex < 0 ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return false;
  }
  // Splice in a fresh array — `list` is the same reference returned by
  // `getQueue`/`useChatQueue`, so mutating it in place would skip
  // `useSyncExternalStore`'s identity check and starve subscribers of a
  // re-render. (Same reasoning as `enqueueMessage`'s spread above.)
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return false;
  next.splice(toIndex, 0, moved);
  queues.set(key, next);
  emit();
  return true;
}

/**
 * React hook returning the live queue for a chat. Updates automatically
 * whenever any of `enqueueMessage`/`removeFromQueue`/`dequeueHead`/
 * `clearQueue` mutate this chat's slot — no per-component subscription
 * plumbing required.
 */
export function useChatQueue(
  chatId: string | null | undefined,
): QueuedChatMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => getQueue(chatId),
    () => getQueue(chatId),
  );
}

/** Stable callback wrapper around `removeFromQueue` for use in JSX handlers. */
export function useRemoveFromQueue(): (id: string) => void {
  return useCallback((id: string) => removeFromQueue(id), []);
}

/** Stable callback wrapper around `clearQueue` for use in JSX handlers. */
export function useClearQueue(
  chatId: string | null | undefined,
): () => void {
  return useCallback(() => clearQueue(chatId), [chatId]);
}

/**
 * Stable callback wrapper around `reorderQueue` for use in DnD / keyboard
 * handlers. Resolves to a function `(from, to) => boolean` so callers can
 * tell when a reorder was rejected (e.g. drain in flight) and skip any
 * follow-on UI side effects.
 */
export function useReorderQueue(
  chatId: string | null | undefined,
): (fromIndex: number, toIndex: number) => boolean {
  return useCallback(
    (from, to) => reorderQueue(chatId, from, to),
    [chatId],
  );
}

/**
 * Mark `chatId` as having a mounted `useChatStream` instance ("the user is
 * looking at this chat"). Returns the matching unregister callback —
 * always pair them inside a `useEffect` so a remount or chat switch
 * doesn't leak a stale active marker.
 *
 * Refcounted: a hook used twice for the same chatId (e.g. React
 * StrictMode's double-mount in dev) doesn't release the marker until
 * BOTH unregister callbacks have fired. This way the runner doesn't
 * briefly see the chat as inactive between StrictMode's mount → unmount
 * → remount cycle and start a duplicate drain.
 */
export function registerActiveChat(
  chatId: string | null | undefined,
): () => void {
  const key = keyFor(chatId);
  const prev = activeChats.get(key) ?? 0;
  activeChats.set(key, prev + 1);
  if (prev === 0) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = activeChats.get(key) ?? 0;
    if (cur <= 1) {
      activeChats.delete(key);
      emit();
    } else {
      activeChats.set(key, cur - 1);
    }
  };
}

/**
 * True when at least one `useChatStream` is currently mounted for
 * `chatId`. The background runner consults this to skip chats the user
 * is actively viewing — the mounted hook handles its own drain and we
 * don't want both racing for `dequeueHead`.
 */
export function isChatActive(chatId: string | null | undefined): boolean {
  return (activeChats.get(keyFor(chatId)) ?? 0) > 0;
}

/**
 * Mark `chatId` as having a drain in flight. Returns the matching
 * unmark callback — pair them tightly around the network request so a
 * thrown exception or early return still releases the marker. Used by
 * BOTH `useChatStream`'s `startStream` (when sending a queued head) and
 * by the runner's `drainOne` so the two coordinate against a single
 * source of truth.
 *
 * Idempotent: calling twice for the same chatId before unmark is fine —
 * the disposer is one-shot, so an extra `mark` followed by one disposer
 * leaves the marker set. Callers must release once per mark.
 */
export function markDrainInFlight(
  chatId: string | null | undefined,
): () => void {
  const key = keyFor(chatId);
  const wasMissing = !inFlightDrains.has(key);
  inFlightDrains.add(key);
  if (wasMissing) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (inFlightDrains.delete(key)) emit();
  };
}

/**
 * True when ANY drain is currently in flight for `chatId` — hook OR
 * runner. The runner skips chats with this flag set; the hook's drain
 * effect skips for the same reason.
 */
export function isDrainInFlight(
  chatId: string | null | undefined,
): boolean {
  return inFlightDrains.has(keyFor(chatId));
}

/**
 * Test helper — wipes every chat's queue + active-chat markers and
 * notifies subscribers. Used in `beforeEach` so the module-level state
 * doesn't leak between tests. Not part of the production API; exported
 * with a `__` prefix to make accidental imports stand out in code review.
 */
export function __resetChatQueueStoreForTests(): void {
  const hadAny =
    queues.size > 0 || activeChats.size > 0 || inFlightDrains.size > 0;
  queues.clear();
  activeChats.clear();
  inFlightDrains.clear();
  counter = 0;
  if (hadAny) emit();
}
