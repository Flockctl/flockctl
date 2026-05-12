/**
 * Code-mode editor — pure tab state machine.
 *
 * This module is the reducer that backs the Code-mode editor's tab bar.
 * It is intentionally side-effect-free: `(state, event) -> state'`. The
 * Zustand store in `tab-store.ts` wires the reducer; React rendering and
 * keyboard handlers live in their own slices.
 *
 * **Why a pure reducer?**
 *
 *   1. The transition table in `tab-state-machine.test.ts` can be
 *      written as `[before, event, after]` triples and run through a
 *      single generated test loop — no React, no act(), no fakes.
 *   2. The store can be swapped out (Zustand today, something else
 *      tomorrow) without touching transition behaviour.
 *   3. Persistence / save side effects are owned by the store boundary,
 *      not the reducer. `confirmClose(id, "save")` removes the tab; the
 *      caller is responsible for actually calling the save endpoint
 *      before / alongside firing the event.
 *
 * **Tab identity.** Each tab carries a stable `id` (a nanoid, a UUID,
 * whatever the store generates — the reducer doesn't care, only that
 * it's unique). `path` is the project-relative path of the file the tab
 * represents; opening a path that already has an open tab focuses the
 * existing tab rather than creating a duplicate.
 *
 * **Dirty-close handshake.**
 *
 *   - `close(id)` on a clean tab removes it.
 *   - `close(id)` on a dirty tab sets `pendingClose: true` (the UI is
 *     expected to render a confirm dialog at this point).
 *   - `close(id)` on a tab whose dialog is already open is a no-op.
 *   - `confirmClose(id, "cancel")` clears `pendingClose`, leaving the
 *     buffer dirty.
 *   - `confirmClose(id, "save" | "dont")` removes the tab. The "save"
 *     branch assumes the caller has already written the buffer to disk
 *     — the reducer never performs I/O.
 *
 * **Sync points.** `setBuffer(id, content, sha)` is the *clean sync*
 * event: it represents "we just loaded this file, or just successfully
 * wrote it back, and these are the canonical bytes". It overwrites
 * `buffer`, sets `heldSha` to `sha`, and clears `dirty`. The fine-
 * grained typing path is owned by Monaco; the editor calls
 * `setDirty(id, true)` when the buffer drifts away from `heldSha` and
 * `setDirty(id, false)` if the user types it back.
 */

/** A single editor tab — one open file buffer. */
export interface Tab {
  /** Stable unique id. The store generates this; the reducer treats it
   *  as opaque. */
  id: string;
  /** Project-relative path the tab represents. Used for de-duping
   *  `open(path)` against already-open tabs. */
  path: string;
  /** Last known content of the buffer at a sync point (load / save).
   *  Monaco may diverge from this between sync points; the reducer
   *  doesn't track keystrokes. */
  buffer: string;
  /** Sha last seen at a sync point — `setBuffer` is the only event
   *  that updates it. The fs-changed handler compares against this to
   *  detect external edits. */
  heldSha: string;
  /** True while the in-editor buffer differs from `heldSha`. Toggled
   *  by `setDirty`; cleared by `setBuffer`. */
  dirty: boolean;
  /** Last-known cursor position. Optional — survives focus changes
   *  but not store resets. Currently set externally; no event mutates
   *  it in this slice. */
  cursor?: { line: number; col: number };
  /** Last-known scroll offset. Same lifecycle as `cursor`. */
  scrollTop?: number;
  /** True while a close-confirm dialog is open against this tab. The
   *  UI keys its `<ConfirmDialog>` off this flag. */
  pendingClose?: boolean;
}

/** Whole-store state. */
export interface State {
  /** Open tabs in left-to-right order. */
  tabs: Tab[];
  /** Currently-active tab id, or null when nothing is open. */
  activeId: string | null;
}

/** The choice returned from the dirty-close confirm dialog. */
export type CloseChoice = "save" | "dont" | "cancel";

/** Discriminated union of every event the reducer accepts. The store
 *  wraps these as method calls; tests fire them directly. */
export type Event =
  /** Open `path`. If a tab with that path is already open, focus it
   *  and ignore `newId`. Otherwise create a new tab with id `newId`,
   *  empty buffer, empty heldSha, dirty=false, and focus it. */
  | { type: "open"; path: string; newId: string }
  /** Close `id`. On a clean tab → remove it. On a dirty tab → flip
   *  `pendingClose` to true (the UI then shows the confirm dialog).
   *  No-op when `id` isn't open or when `pendingClose` is already
   *  true. */
  | { type: "close"; id: string }
  /** Resolve the dirty-close handshake. `"cancel"` clears
   *  `pendingClose`; `"save" | "dont"` removes the tab. */
  | { type: "confirmClose"; id: string; choice: CloseChoice }
  /** Make `id` the active tab. No-op when `id` isn't open. */
  | { type: "focus"; id: string }
  /** Mark `id` dirty / clean (typing path). Does NOT update `buffer`
   *  or `heldSha`. */
  | { type: "setDirty"; id: string; dirty: boolean }
  /** Sync point — buffer + sha are now the canonical bytes; clears
   *  dirty. Used after load and after successful save. */
  | { type: "setBuffer"; id: string; content: string; sha: string }
  /**
   * External rename — the file at `from` was renamed to `to` on disk
   * (typically via the tree's right-click → Rename). The reducer
   * patches every tab whose path equals `from` (there should only ever
   * be one — `open` de-dupes by path) and leaves all other state
   * intact: `buffer` / `heldSha` / `dirty` / `pendingClose` / cursor /
   * scroll all survive, because the file's bytes did not change.
   *
   * No-op when `from` has no open tab. Mismatched casing (e.g. "Foo.ts"
   * vs "foo.ts") is treated as a non-match — Linux is case-sensitive,
   * macOS file systems vary, and we'd rather miss a rare rename than
   * collide two distinct buffers into one.
   */
  | { type: "rename"; from: string; to: string };

/** A blank store. Exposed so tests can build "before" states by hand
 *  without reaching for store internals. */
export const initialState: State = { tabs: [], activeId: null };

// ---------- internal helpers ---------------------------------------------------

function findTab(state: State, id: string): Tab | undefined {
  return state.tabs.find((t) => t.id === id);
}

function patchTab(state: State, id: string, patch: Partial<Tab>): State {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return state;
  const next = state.tabs.slice();
  next[idx] = { ...next[idx]!, ...patch };
  return { ...state, tabs: next };
}

/**
 * Remove `id` from the tab list. When the removed tab was active,
 * focus shifts to the right neighbour, falling back to the left
 * neighbour, then to `null`.
 */
function removeTab(state: State, id: string): State {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return state;
  const tabs = state.tabs.slice();
  tabs.splice(idx, 1);
  let activeId = state.activeId;
  if (state.activeId === id) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    activeId = next ? next.id : null;
  }
  return { tabs, activeId };
}

// ---------- reducer ------------------------------------------------------------

/**
 * The pure transition function. Returns the input `state` reference
 * unchanged for no-op events so consumers can short-circuit re-renders
 * via reference equality (Zustand's default selector behaviour).
 */
export function reduce(state: State, event: Event): State {
  switch (event.type) {
    case "open": {
      const existing = state.tabs.find((t) => t.path === event.path);
      if (existing) {
        if (state.activeId === existing.id) return state;
        return { ...state, activeId: existing.id };
      }
      const tab: Tab = {
        id: event.newId,
        path: event.path,
        buffer: "",
        heldSha: "",
        dirty: false,
      };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }

    case "close": {
      const tab = findTab(state, event.id);
      if (!tab) return state;
      if (tab.pendingClose) return state;
      if (tab.dirty) return patchTab(state, event.id, { pendingClose: true });
      return removeTab(state, event.id);
    }

    case "confirmClose": {
      const tab = findTab(state, event.id);
      if (!tab) return state;
      if (event.choice === "cancel") {
        if (!tab.pendingClose) return state;
        return patchTab(state, event.id, { pendingClose: false });
      }
      // "save" or "dont" — remove the tab. Saving I/O is the caller's
      // responsibility; this reducer is pure.
      return removeTab(state, event.id);
    }

    case "focus": {
      if (!findTab(state, event.id)) return state;
      if (state.activeId === event.id) return state;
      return { ...state, activeId: event.id };
    }

    case "setDirty": {
      const tab = findTab(state, event.id);
      if (!tab) return state;
      if (tab.dirty === event.dirty) return state;
      return patchTab(state, event.id, { dirty: event.dirty });
    }

    case "setBuffer": {
      const tab = findTab(state, event.id);
      if (!tab) return state;
      return patchTab(state, event.id, {
        buffer: event.content,
        heldSha: event.sha,
        dirty: false,
      });
    }

    case "rename": {
      // The path index is the only field that needs to move — the
      // bytes are unchanged, so `buffer` / `heldSha` / `dirty` /
      // `pendingClose` and the cursor / scroll metadata all carry
      // through. The reducer matches on exact-string equality; we
      // never coerce to lowercase because filesystems vary.
      const idx = state.tabs.findIndex((t) => t.path === event.from);
      if (idx < 0) return state;
      return patchTab(state, state.tabs[idx]!.id, { path: event.to });
    }
  }
}
