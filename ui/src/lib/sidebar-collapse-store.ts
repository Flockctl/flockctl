import { useSyncExternalStore } from "react";

/**
 * Which sidebar nav groups the user has collapsed, stored in localStorage so
 * the choice survives reloads. Device-local by design — the collapsed set is a
 * personal UI preference and isn't worth syncing across devices.
 *
 * Shape: `{ [groupId]: true }` where presence of `true` means "collapsed".
 * Absent / `false` means "open", which is the default for any new group.
 */

const STORAGE_KEY = "flockctl_sidebar_collapsed";
type CollapseMap = Record<string, boolean>;

function load(): CollapseMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CollapseMap) : {};
  } catch {
    return {};
  }
}

let cache: CollapseMap = load();
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

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function isGroupCollapsed(groupId: string): boolean {
  return cache[groupId] === true;
}

export function setGroupCollapsed(groupId: string, collapsed: boolean): void {
  const current = cache[groupId] === true;
  if (current === collapsed) return;
  cache = { ...cache, [groupId]: collapsed };
  persist();
  emit();
}

export function toggleGroupCollapsed(groupId: string): void {
  setGroupCollapsed(groupId, !isGroupCollapsed(groupId));
}

/** Test-only reset. Not exported from any barrel; imported directly by tests. */
export function __resetSidebarCollapseStoreForTests(): void {
  cache = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Reactive hook — re-renders the caller whenever the group's state flips. */
export function useGroupCollapsed(groupId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isGroupCollapsed(groupId),
    () => false,
  );
}
