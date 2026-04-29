import { useSyncExternalStore } from "react";

/**
 * Whether the desktop sidebar is collapsed to an icon-only "rail". Persisted
 * to localStorage so the choice survives reloads. Device-local by design —
 * a personal layout preference that isn't worth syncing.
 *
 * Only affects the md+ static sidebar; the mobile slide-in drawer always
 * renders in full width because it's a transient overlay.
 */

const STORAGE_KEY = "flockctl_sidebar_rail";

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let cache: boolean = load();
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) fn();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, cache ? "1" : "0");
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

export function isSidebarRailCollapsed(): boolean {
  return cache;
}

export function setSidebarRailCollapsed(collapsed: boolean): void {
  if (cache === collapsed) return;
  cache = collapsed;
  persist();
  emit();
}

export function toggleSidebarRailCollapsed(): void {
  setSidebarRailCollapsed(!cache);
}

/** Test-only reset. Not exported from any barrel; imported directly by tests. */
export function __resetSidebarRailStoreForTests(): void {
  cache = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Reactive hook — re-renders the caller whenever the rail state flips. */
export function useSidebarRailCollapsed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => cache,
    () => false,
  );
}
