import { useSyncExternalStore } from "react";

/**
 * cmdk-store — open/close + query state for the ⌘K command palette.
 *
 * Vanilla pub/sub backed by `useSyncExternalStore`, mirroring
 * `code-mode/tab-store.ts` so we don't drag a state-management
 * dependency into the bundle for what is essentially a boolean and
 * a string.
 *
 * The store is intentionally global — the keyboard listener mounted
 * by `<NewShell />` writes here, the `<CmdK />` overlay reads. Any
 * component anywhere in the tree can `cmdkStore.open()` to surface
 * the palette without needing prop drilling or a context.
 */

export interface CmdkState {
  open: boolean;
  /** Current search query — drives the result filter. */
  query: string;
}

const listeners = new Set<() => void>();
let state: CmdkState = { open: false, query: "" };
let snapshot: CmdkState = state;

function emit() {
  // Fresh reference so identity-equality consumers see the change.
  snapshot = { ...state };
  for (const fn of listeners) fn();
}

export const cmdkStore = {
  open() {
    if (state.open) return;
    state = { ...state, open: true };
    emit();
  },
  close() {
    if (!state.open) return;
    // Reset query so the palette doesn't pre-filter on next open.
    // Power users can reopen and start typing fresh.
    state = { open: false, query: "" };
    emit();
  },
  toggle() {
    state = state.open ? { open: false, query: "" } : { ...state, open: true };
    emit();
  },
  setQuery(q: string) {
    if (state.query === q) return;
    state = { ...state, query: q };
    emit();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): CmdkState {
    return snapshot;
  },
  __resetForTests() {
    state = { open: false, query: "" };
    snapshot = state;
    emit();
  },
};

export function useCmdkState(): CmdkState {
  return useSyncExternalStore(cmdkStore.subscribe, cmdkStore.getSnapshot, cmdkStore.getSnapshot);
}
