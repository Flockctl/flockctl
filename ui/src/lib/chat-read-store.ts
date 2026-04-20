import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Per-chat "last read at" timestamps, stored in localStorage. The chat list
 * compares a chat's `updated_at` against this value to decide whether to show
 * an "unread" indicator. Device-local — deliberately not synced across
 * devices for now; upgrading to a server-backed `last_read_at` column would
 * replace this module's storage without touching callers.
 */

const STORAGE_KEY = "flockctl_chat_last_read";
type ReadMap = Record<string, string>;

function load(): ReadMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ReadMap) : {};
  } catch {
    return {};
  }
}

let cache: ReadMap = load();
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // storage full / disabled — in-memory cache still works for this session
  }
}

export function getLastRead(chatId: string): string | null {
  return cache[chatId] ?? null;
}

export function markChatRead(chatId: string, at: string = new Date().toISOString()): void {
  const prev = cache[chatId];
  // Never move the pointer backwards — avoids re-marking unread if an older
  // timestamp is passed in by mistake.
  if (prev && prev >= at) return;
  cache = { ...cache, [chatId]: at };
  persist();
  emit();
}

export function isChatUnread(chatId: string, updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const lastRead = cache[chatId];
  if (!lastRead) return true;
  return updatedAt > lastRead;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Reactive read of the full map. Use sparingly — prefer `useChatUnread`. */
export function useChatReadMap(): ReadMap {
  return useSyncExternalStore(subscribe, () => cache, () => cache);
}

/** Subscribes to changes for a single chat and returns unread state. */
export function useChatUnread(chatId: string, updatedAt: string | null | undefined): boolean {
  const [unread, setUnread] = useState(() => isChatUnread(chatId, updatedAt));
  useEffect(() => {
    const compute = () => setUnread(isChatUnread(chatId, updatedAt));
    compute();
    return subscribe(compute);
  }, [chatId, updatedAt]);
  return unread;
}
