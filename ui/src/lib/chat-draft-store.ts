import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-chat composer draft text, kept in memory for the lifetime of the tab.
 *
 * `ChatConversation` is remounted on every chat switch (the parent passes
 * `key={selectedChatId}`), so a plain `useState("")` inside the component
 * would wipe the textarea whenever the user clicks another chat. Stashing
 * the draft in a module-level map keyed by chat id lets each chat keep its
 * own unsent text until it's either sent (the composer calls `setDraft(id,
 * "")`) or the tab closes.
 *
 * Deliberately NOT persisted to localStorage — drafts can contain sensitive
 * prompts, and a stale draft surviving a browser restart is more surprising
 * than helpful.
 */

// Sentinel used when the conversation has no chat id yet (new-chat flow).
// The composer is usually disabled in that state, but keeping the key stable
// means if that ever changes, drafts won't silently collide with a real id.
export const NEW_CHAT_DRAFT_KEY = "__new__";

// ─── Bounded growth (audit-round-5) ───
//
// Empty values are evicted on save, but typing into many chats over
// a long session can accumulate entries indefinitely. 256 keys is far
// more than any real workflow needs; oldest-eviction on overflow keeps
// the cache warm for the chats the operator is actually toggling
// between.
const MAX_DRAFT_ENTRIES = 256;
const drafts = new Map<string, string>();
const subscribers = new Set<() => void>();

function evictOldestDraftIfFull(): void {
  if (drafts.size < MAX_DRAFT_ENTRIES) return;
  const oldest = drafts.keys().next().value;
  if (oldest !== undefined) drafts.delete(oldest);
}

function emit(): void {
  for (const fn of subscribers) fn();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function getDraft(chatId: string | null | undefined): string {
  const key = chatId ?? NEW_CHAT_DRAFT_KEY;
  return drafts.get(key) ?? "";
}

export function setDraft(chatId: string | null | undefined, value: string): void {
  const key = chatId ?? NEW_CHAT_DRAFT_KEY;
  const prev = drafts.get(key) ?? "";
  if (prev === value) return;
  if (value === "") {
    drafts.delete(key);
  } else {
    // Evict oldest entry FIRST so the new key doesn't bypass the cap
    // when it's a fresh insertion at-capacity.
    if (!drafts.has(key)) evictOldestDraftIfFull();
    drafts.set(key, value);
  }
  emit();
}

export function clearDraft(chatId: string | null | undefined): void {
  setDraft(chatId, "");
}

/**
 * React hook shaped like `useState<string>` but backed by the module-level
 * draft map. The returned value stays in sync across every mount of the
 * chat view, so toggling between chats preserves each one's unsent text.
 */
export function useChatDraft(
  chatId: string | null | undefined,
): [string, (next: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => getDraft(chatId),
    () => getDraft(chatId),
  );
  const setValue = useCallback(
    (next: string) => {
      setDraft(chatId, next);
    },
    [chatId],
  );
  return [value, setValue];
}
