/**
 * Code-mode tab-store — minimal vanilla store backing the editor's tab
 * bar. Three tab kinds today:
 *
 *   - `file`   — a buffer pane for one project-relative path. Wired up
 *                in slice 02 of the Code-mode milestone; the editor's
 *                conflict / dirty state machine still lives in
 *                `lib/handlers/fs-changed.ts` and is keyed off
 *                `(projectId, path)` independently of tab identity.
 *   - `commit` — a commit-detail pane for one SHA on a project /
 *                workspace. Owned by the commit-detail tab introduced
 *                in this slice — see `git/CommitDetailTab.tsx`.
 *   - `diff`   — a Monaco DiffEditor pane for one project-relative path,
 *                comparing two sides (working/staged/ref-vs-ref). Always
 *                read-only by construction; Save (Cmd+S) is a no-op on
 *                this kind. Opened from `SourceControlPanel` clicks
 *                (`tabStore.openDiff(path, { staged })`) and from the
 *                future "view changed file" entry points. The id is
 *                scoped on the (base, head, staged) tuple so the same
 *                file can be open as both a working-tree diff and a
 *                staged diff side-by-side.
 *
 * The store is a vanilla pub/sub keyed on a stable `id` per tab so
 * external consumers can subscribe via `useSyncExternalStore` without
 * pulling in a state-management dependency. Adding a new tab kind is a
 * one-line addition to the discriminated `Tab` union.
 *
 * **Why not a context?** The tab list is a singleton across the entire
 * Code-mode shell (one route can host many sub-views, all of which
 * may want to open / close tabs). A vanilla store decouples that from
 * React's tree shape — the FS / git widgets that schedule a tab-open
 * don't have to be descendants of a `<TabsProvider>`.
 *
 * Test seam: `tabStore.__resetForTests()` clears the store between
 * tests. Production code never calls it.
 */

export interface FileTab {
  kind: "file";
  /** Stable id for this tab. By convention `file:<projectId>:<path>`. */
  id: string;
  projectId: string;
  path: string;
}

export interface CommitTab {
  kind: "commit";
  /** Stable id for this tab. By convention `commit:<scope>:<entityId>:<sha>`. */
  id: string;
  scope: "projects" | "workspaces";
  entityId: string;
  sha: string;
  /**
   * Human-readable label rendered on the tab itself.
   * Format: `"<shortSha> <subject-truncated>"`. When `null`, the tab
   * shows a placeholder until `useGitShow` resolves and the consumer
   * upgrades the title via `tabStore.update`.
   */
  title: string | null;
}

export interface DiffTab {
  kind: "diff";
  /**
   * Stable id. Format: `diff:<scope>:<entityId>:<path>:<mode>` where
   * `mode` is the canonical encoding of the diff sides:
   *   - `"staged"` for index vs HEAD (`?staged=true`)
   *   - `"working"` for worktree vs index (the no-args git-diff)
   *   - `"<base>..<head>"` for ref-vs-ref
   *
   * The scope-prefixing keeps a project's "src/foo.ts" diff distinct
   * from a workspace-level repo's same path, mirroring `commitTabId`.
   */
  id: string;
  scope: "projects" | "workspaces";
  entityId: string;
  /** Project/workspace-relative path of the file being diffed. */
  path: string;
  /**
   * Diff side selector. The three modes are mutually exclusive — same
   * contract as the underlying `runGitDiff` service.
   */
  staged?: boolean;
  base?: string;
  head?: string;
}

export type Tab = FileTab | CommitTab | DiffTab;

/**
 * Per-tab banner raised by the reconnect-drift handler. Two shapes:
 *
 *   - `changed` — the file's on-disk sha drifted from the held sha while
 *     the socket was offline AND the buffer is dirty. The banner exposes
 *     the disk's current sha so the user can choose between Reload
 *     (overwrite buffer) and Keep (overwrite disk on next save).
 *   - `deleted` — the file no longer exists on disk. The buffer survives;
 *     the user can save to recreate or close to discard.
 *
 * Clean-buffer drift does NOT raise a banner — the handler silently
 * rolls `heldSha` forward via the editor-tab `setBuffer` event.
 */
export type ReconnectBannerState =
  | { kind: "changed"; currentSha: string }
  | { kind: "deleted" };

interface StoreState {
  /** Open tabs in left-to-right order. */
  tabs: readonly Tab[];
  /** Tab id of the currently-active tab; null when nothing is open. */
  activeId: string | null;
  /**
   * Per-tab reconnect-drift banner state, keyed by tab id. Entries are
   * absent when no banner is active; cleared automatically when the
   * underlying tab is closed.
   */
  banners: ReadonlyMap<string, ReconnectBannerState>;
}

type Listener = () => void;

const initialState: StoreState = {
  tabs: [],
  activeId: null,
  banners: new Map(),
};

let state: StoreState = initialState;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

function setState(next: StoreState): void {
  state = next;
  emit();
}

function findIndex(id: string): number {
  return state.tabs.findIndex((t) => t.id === id);
}

/**
 * Build the canonical tab id for a {@link CommitTab}. Exposed so
 * route-mounted components can ask "is this commit already open?"
 * without re-deriving the same string.
 */
export function commitTabId(
  scope: "projects" | "workspaces",
  entityId: string,
  sha: string,
): string {
  return `commit:${scope}:${entityId}:${sha}`;
}

/**
 * Build the canonical tab id for a {@link FileTab}. Symmetric with
 * {@link commitTabId} so the editor's dirty-state lookups can key on
 * the same string regardless of who opened the file.
 */
export function fileTabId(projectId: string, path: string): string {
  return `file:${projectId}:${path}`;
}

/**
 * Encode the diff-side selector into a stable id segment. Used by
 * {@link diffTabId} so the same file can be open under multiple modes
 * simultaneously without colliding ids.
 *
 * The encoding is deliberately one-way (consumers don't decode it back
 * — they read `staged` / `base` / `head` off the tab). It exists so the
 * id is self-describing in dev tools and so the e2e harness can target
 * a specific mode by attribute selector.
 */
function diffModeKey(mode: {
  staged?: boolean;
  base?: string;
  head?: string;
}): string {
  if (mode.staged === true) return "staged";
  if (mode.base !== undefined && mode.head !== undefined) {
    return `${mode.base}..${mode.head}`;
  }
  return "working";
}

/**
 * Build the canonical tab id for a {@link DiffTab}. Format keeps the
 * mode segment last so ids sort grouped by `(scope, entityId, path)` —
 * useful for the future tab-bar reorder logic.
 */
export function diffTabId(
  scope: "projects" | "workspaces",
  entityId: string,
  path: string,
  mode: { staged?: boolean; base?: string; head?: string },
): string {
  return `diff:${scope}:${entityId}:${path}:${diffModeKey(mode)}`;
}

export const tabStore = {
  /** Snapshot for `useSyncExternalStore`. */
  getState(): StoreState {
    return state;
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Open `tab` (or focus it if its id is already present). Pre-existing
   * tab data is preserved on a re-open so a `title` upgrade from a
   * previous mount survives a navigation round-trip.
   */
  openTab(tab: Tab): void {
    const idx = findIndex(tab.id);
    if (idx >= 0) {
      setState({ ...state, activeId: tab.id });
      return;
    }
    setState({
      ...state,
      tabs: [...state.tabs, tab],
      activeId: tab.id,
    });
  },

  /**
   * Patch one field on an existing tab — typically used by
   * {@link CommitTab} consumers to upgrade `title` from `null` to
   * `"<shortSha> <subject>"` after `useGitShow` resolves. No-op when
   * the id isn't open. Type-narrowed: callers pass a partial that
   * matches the kind they own.
   */
  /**
   * Convenience for the most common diff-tab open path: the source-control
   * panel clicking on a changed file. Builds the id, derives the scope
   * from the {@link DiffTab} metadata, and delegates to {@link openTab}.
   *
   * The accepted `mode` is the same {@link DiffTab} subset
   * `({ staged?, base?, head? })` the underlying tab carries — keep them
   * in lock-step or the id won't match the data. Re-opening with the
   * same id is a focus-only no-op (matches `openTab` semantics).
   */
  openDiff(
    scope: "projects" | "workspaces",
    entityId: string,
    path: string,
    mode: { staged?: boolean; base?: string; head?: string } = {},
  ): void {
    const id = diffTabId(scope, entityId, path, mode);
    const tab: DiffTab = {
      kind: "diff",
      id,
      scope,
      entityId,
      path,
      ...(mode.staged === true ? { staged: true } : {}),
      ...(mode.base !== undefined ? { base: mode.base } : {}),
      ...(mode.head !== undefined ? { head: mode.head } : {}),
    };
    this.openTab(tab);
  },

  update(
    id: string,
    patch: Partial<CommitTab> | Partial<FileTab> | Partial<DiffTab>,
  ): void {
    const idx = findIndex(id);
    if (idx < 0) return;
    const cur = state.tabs[idx]!;
    // We deliberately don't allow `kind` / `id` to be overwritten;
    // they identify the tab and changing either invalidates external
    // references. Spread-then-pin the immutable fields back on top.
    const merged = { ...cur, ...patch, kind: cur.kind, id: cur.id } as Tab;
    const nextTabs = state.tabs.slice();
    nextTabs[idx] = merged;
    setState({ ...state, tabs: nextTabs });
  },

  /** Set the active tab. No-op when the id isn't open. */
  setActive(id: string): void {
    if (findIndex(id) < 0) return;
    setState({ ...state, activeId: id });
  },

  /**
   * Close a tab. When the closed tab is the active one, focus shifts
   * to the neighbour on the right (or, if it was the last tab, the
   * neighbour on the left). With nothing left, `activeId` returns to
   * `null`.
   *
   * Also clears any reconnect-drift banner held against this tab — the
   * banner is per-tab UI and has no meaning once the tab is gone.
   */
  closeTab(id: string): void {
    const idx = findIndex(id);
    if (idx < 0) return;
    const nextTabs = state.tabs.slice();
    nextTabs.splice(idx, 1);
    let activeId: string | null = state.activeId;
    if (state.activeId === id) {
      const nextActive = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
      activeId = nextActive ? nextActive.id : null;
    }
    let nextBanners = state.banners;
    if (state.banners.has(id)) {
      const map = new Map(state.banners);
      map.delete(id);
      nextBanners = map;
    }
    setState({ tabs: nextTabs, activeId, banners: nextBanners });
  },

  /**
   * Raise (or replace) a reconnect-drift banner against an existing
   * tab. No-op when the tab isn't open — a banner with no carrier has
   * nowhere to render and would leak across navigation.
   */
  setBanner(id: string, banner: ReconnectBannerState): void {
    if (findIndex(id) < 0) return;
    const map = new Map(state.banners);
    map.set(id, banner);
    setState({ ...state, banners: map });
  },

  /**
   * Dismiss the banner against `id`. No-op when there isn't one. Used
   * by the banner UI's Reload / Keep / Close handlers.
   */
  clearBanner(id: string): void {
    if (!state.banners.has(id)) return;
    const map = new Map(state.banners);
    map.delete(id);
    setState({ ...state, banners: map });
  },

  /** Test-only — reset to the initial state between tests. */
  __resetForTests(): void {
    setState({ tabs: [], activeId: null, banners: new Map() });
  },
};

import { useSyncExternalStore } from "react";

/**
 * React hook — subscribes the calling component to the store and
 * returns the current snapshot. Typical use is in the (future) tab-bar
 * component: `const { tabs, activeId } = useTabStore();`.
 */
export function useTabStore(): StoreState {
  return useSyncExternalStore(tabStore.subscribe, tabStore.getState);
}

// ============================================================================
// Editor buffer-tab store (Zustand) — one tab per open file buffer.
//
// This is a separate, narrower store from `tabStore` above (which
// handles the polymorphic file/commit tab list rendered in the
// Code-mode shell's tab bar). The buffer-tab store owns *editor*
// state — what's typed but not yet saved, the held sha, the dirty
// flag, the close-confirm handshake — and is driven by a pure reducer
// in `tab-state-machine.ts` (the unit-tested artifact).
//
// Keeping the two stores side-by-side rather than merged is
// deliberate: the shell's tab bar only cares about what tabs exist
// and which is active; the editor cares about per-buffer dirtiness
// and sha. Joining them would entangle two unrelated lifetimes (a
// commit-detail tab has no buffer, no dirty flag). A future slice can
// reconcile them if it turns out to matter; today it doesn't.
// ============================================================================

import { create } from "zustand";
import {
  reduce as reduceEditorTabs,
  initialState as editorTabsInitialState,
  type State as EditorTabsState,
  type Event as EditorTabsEvent,
  type Tab as EditorTab,
  type CloseChoice,
} from "./tab-state-machine";

export type { EditorTab, EditorTabsState, CloseChoice };

/** Id generator. Pulled out so tests can override it deterministically. */
function defaultGenId(): string {
  // Browsers + jsdom both ship `crypto.randomUUID`; no nanoid dep needed.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Last-resort fallback for ancient runtimes — not expected in
  // production, but keeps the store from throwing in odd test envs.
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

let genId: () => string = defaultGenId;

/** Test seam: replace the id generator with something deterministic. */
export function __setEditorTabIdGeneratorForTests(fn: () => string): void {
  genId = fn;
}

/** Test seam: restore the default id generator. */
export function __resetEditorTabIdGeneratorForTests(): void {
  genId = defaultGenId;
}

/**
 * Public store interface. Each method translates to a single reducer
 * event — the store is a thin wrapper, never adds behaviour the
 * reducer doesn't model.
 */
export interface EditorTabsStore extends EditorTabsState {
  open: (path: string) => string;
  close: (id: string) => void;
  confirmClose: (id: string, choice: CloseChoice) => void;
  focus: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  setBuffer: (id: string, content: string, sha: string) => void;
  /**
   * External-rename hook. Forwards a `{ type: "rename", from, to }`
   * event to the reducer, which updates the path on a matching tab and
   * leaves buffer / sha / dirty / cursor / scroll untouched. Wired up
   * to the FS mutation hooks via `__setTabRenameHandler` at module
   * load (see the import side-effect below) so a successful tree
   * `rename` propagates here automatically — callers can also fire it
   * directly from a custom flow without going through the FS hook.
   */
  handleRename: (from: string, to: string) => void;
  /**
   * Discard every open tab. Used by the project-detail Code-mode wrapper
   * on unmount so a project swap (`key={projectId}` remounts the
   * subtree) starts the next project with an empty tab list — the
   * existing single-buffer contract did the same via React's natural
   * state reset. Bypasses the dirty-close handshake by design: project
   * navigation is an explicit operator action, not an editor-internal
   * close.
   */
  closeAll: () => void;
  /** Test-only — clear all tabs. Production code never calls this. */
  __resetForTests: () => void;
}

/**
 * Zustand store backing the editor's open buffer tabs.
 *
 * Selector usage (recommended to avoid over-rendering):
 *
 *     const tabs = useEditorTabsStore((s) => s.tabs);
 *     const open = useEditorTabsStore((s) => s.open);
 *
 * The reducer's reference-equality short-circuits (returning the same
 * `state` object for no-op events) flow through Zustand's default
 * shallow comparison, so unrelated components don't re-render when an
 * event hits an unchanged path.
 */
export const useEditorTabsStore = create<EditorTabsStore>((set, get) => {
  function dispatch(event: EditorTabsEvent): EditorTabsState {
    const before: EditorTabsState = {
      tabs: get().tabs,
      activeId: get().activeId,
    };
    const after = reduceEditorTabs(before, event);
    if (after !== before) {
      set({ tabs: after.tabs, activeId: after.activeId });
    }
    return after;
  }

  return {
    ...editorTabsInitialState,

    open: (path: string): string => {
      // Pre-check: if the path already has an open tab, the reducer
      // will focus it and ignore `newId`. We still pre-resolve the id
      // to return so callers can route to the tab without reading the
      // post-state.
      const existing = get().tabs.find((t) => t.path === path);
      const newId = existing ? existing.id : genId();
      dispatch({ type: "open", path, newId });
      return newId;
    },

    close: (id: string): void => {
      dispatch({ type: "close", id });
    },

    confirmClose: (id: string, choice: CloseChoice): void => {
      dispatch({ type: "confirmClose", id, choice });
    },

    focus: (id: string): void => {
      dispatch({ type: "focus", id });
    },

    setDirty: (id: string, dirty: boolean): void => {
      dispatch({ type: "setDirty", id, dirty });
    },

    setBuffer: (id: string, content: string, sha: string): void => {
      dispatch({ type: "setBuffer", id, content, sha });
    },

    handleRename: (from: string, to: string): void => {
      dispatch({ type: "rename", from, to });
    },

    closeAll: (): void => {
      // Direct set — bypasses the reducer because project navigation
      // is an unconditional reset (no dirty handshake, no per-tab
      // close events). The existing per-tab "close" event respects
      // `pendingClose`; we deliberately don't go through it here.
      set({ ...editorTabsInitialState });
    },

    __resetForTests: (): void => {
      set({ ...editorTabsInitialState });
    },
  };
});

// ---------- FS-hook bridge ----------------------------------------------------
//
// The hooks under `lib/hooks/fs.ts` notify a registered handler on a
// successful tree-rename so the editor's open buffer follows the new
// path without going through a re-fetch. We register here (a one-line
// import side-effect) rather than from the editor's mount because:
//
//   - The bridge belongs to the store's lifecycle, not the React tree.
//     A buffer can be open in any number of mounted editors; the
//     handler should fire once per FS event regardless.
//   - The hooks file deliberately doesn't import this module (to avoid
//     a hooks/ → components/ dependency for callers that never touch
//     tabs). Inverting the dependency direction here keeps the import
//     graph one-way.
//
// `__setTabRenameHandler(null)` is the test-time teardown — see the
// existing tests in `tab-state-machine.test.ts` for the pattern.
import { __setTabRenameHandler } from "@/lib/hooks/fs";

__setTabRenameHandler((from, to) => {
  // The polymorphic shell tab list also stores file tabs keyed by a
  // `file:<projectId>:<path>` id; rebuild the id and patch the path so
  // the tab bar's label follows the rename. We walk every open file
  // tab whose path matches — there should never be more than one.
  for (const tab of tabStore.getState().tabs) {
    if (tab.kind === "file" && tab.path === from) {
      const newId = fileTabId(tab.projectId, to);
      // The tab bar keys on `id` for de-dupe, so we can't just patch
      // path — we need a new id. Replace the entry directly via the
      // store internals: close the old tab and open a fresh one with
      // the new path. The active-id semantics carry over because
      // `openTab` focuses on re-open.
      const wasActive = tabStore.getState().activeId === tab.id;
      tabStore.closeTab(tab.id);
      tabStore.openTab({
        kind: "file",
        id: newId,
        projectId: tab.projectId,
        path: to,
      });
      if (!wasActive) {
        // openTab focuses on insert — restore the prior active tab
        // when the renamed file wasn't the active one.
        const prior = tabStore.getState().activeId;
        if (prior && prior !== newId) tabStore.setActive(prior);
      }
    }
  }
  // Also forward to the editor-buffer store so Monaco's model URI is
  // updated for the open buffer. The reducer is a no-op when no buffer
  // is open for `from`.
  useEditorTabsStore.getState().handleRename(from, to);
});
