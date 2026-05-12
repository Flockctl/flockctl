import { useCallback, useEffect, useMemo, useState } from "react";

import { CodeMode as CodeModeShell } from "@/components/code-mode/CodeMode";
import { CodeModeEditor } from "@/components/code-mode/CodeModeEditor";
import { DiffTabContent } from "@/components/code-mode/DiffTabContent";
import { DirtyCloseConfirm } from "@/components/code-mode/DirtyCloseConfirm";
import { TabBar } from "@/components/code-mode/TabBar";
import {
  useEditorTabsStore,
  useTabStore,
} from "@/components/code-mode/tab-store";
import { FileTree } from "@/components/file-tree/FileTree";
import type { GitTarget } from "@/components/git/git-dropdown-button";
import { useFsChangedHandler } from "@/lib/handlers/fs-changed";
import { useGitStatusChangedHandler } from "@/lib/handlers/git-status-changed";

/**
 * localStorage key the gitignore visibility toggle persists to. Shared
 * across every project-detail Code-mode mount so an operator's choice
 * survives navigation and reload. Exported for the e2e suite which
 * pre-seeds / asserts the value.
 */
export const SHOW_IGNORED_STORAGE_KEY = "code-mode.show-ignored";

/**
 * Read the persisted toggle value, defaulting to `true` whenever the
 * key is absent or unparseable. We don't crash on a corrupted value —
 * the operator just gets the default and the next click overwrites it.
 *
 * Defensive against environments without `localStorage` (SSR / test
 * mocks): the helper short-circuits to the default rather than
 * throwing.
 */
function readShowIgnored(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    const raw = localStorage.getItem(SHOW_IGNORED_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

/**
 * Project-detail "Code" tab — wires the {@link CodeModeShell} (activity
 * bar + side panel skeleton already shipped in slice 00) to the actual
 * data sources for this project:
 *
 *   - Files panel = lazy-loading {@link FileTree} bound to
 *     `GET /projects/:id/fs/list`.
 *   - Tab bar     = {@link TabBar} reading from the editor-tabs store —
 *                   one tab per open file buffer.
 *   - Main editor = {@link CodeModeEditor} for the active editor tab,
 *                   or {@link DiffTabContent} when a diff tab is active
 *                   in the polymorphic shell tab store.
 *
 *                                 ┌─────────────────────────────────┐
 *   ┌──┬──────────────┐           │  TabBar (file buffers)          │
 *   │A │ FileTree     │  click →  │  ─────────────────────────────  │
 *   │c │              │           │  CodeModeEditor — banner-aware  │
 *   │t │              │           │  Monaco pane.                   │
 *   │  │              │           │                                 │
 *   └──┴──────────────┘           └─────────────────────────────────┘
 *
 * Live updates: {@link useFsChangedHandler} mounts a single fs-topic
 * subscription on the global ws singleton for `projectId` while the
 * Code tab is mounted. Frames flow through `applyFsChangedFrame` to
 * invalidate the relevant queries, flash the tree row, and resolve any
 * open tab's conflict state. Unmounts (tab switch, project swap) tear
 * the subscription down — see `lib/handlers/fs-changed.ts`.
 *
 * Tabbed editing: clicking a file in the tree opens (or focuses) a tab
 * in the editor-tabs store. Cmd/Ctrl+W closes; Cmd/Ctrl+S saves;
 * Cmd/Ctrl+1..9 / Cmd/Ctrl+]+[ navigate. The dirty-close handshake is
 * mediated by {@link DirtyCloseConfirm}, mounted alongside the shell.
 *
 * Test-id contract (in addition to those owned by {@link CodeModeShell}):
 *   - `code-mode-empty`   — placeholder when no file is selected.
 *   - `code-mode-loading` — spinner while the file body is fetching.
 *   - `code-mode-error`   — error placeholder when the read fails.
 *   - `code-mode-editor`  — wrapper around the Monaco pane.
 */
export interface ProjectCodeModeProps {
  projectId: string;
  /**
   * Forwarded to the SCM panel inside {@link CodeModeShell}. The Files
   * panel does not need it.
   */
  target: GitTarget;
}

export function ProjectCodeMode({ projectId, target }: ProjectCodeModeProps) {
  // Gitignore visibility — persisted to localStorage so the operator's
  // preference survives navigation. Read lazily on first mount so a
  // remount (project swap via `key={projectId}`) picks up an
  // out-of-band update made by a sibling tab. Default `true`: an
  // operator who has never touched the toggle sees every file.
  const [showIgnored, setShowIgnored] = useState<boolean>(readShowIgnored);

  // Persist on change. We deliberately do NOT read from storage on
  // every render — the state above is the source of truth once the
  // component has mounted, so a write-on-change effect is enough.
  useEffect(() => {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(
        SHOW_IGNORED_STORAGE_KEY,
        showIgnored ? "true" : "false",
      );
    } catch {
      // Ignore quota / disabled-storage errors — the toggle still
      // works in-session, the persistence is best-effort.
    }
  }, [showIgnored]);

  // Stable reference for the shell — avoids re-rendering the header
  // strip on every parent re-render even though the underlying setter
  // is already stable.
  const handleShowIgnoredChange = useCallback((next: boolean) => {
    setShowIgnored(next);
  }, []);

  // Subscribe to `fs.changed` frames for the lifetime of this Code tab.
  // The handler invalidates queries, flashes tree rows, and resolves
  // open-tab conflicts — see `lib/handlers/fs-changed.ts`.
  useFsChangedHandler(projectId);

  // Sister subscription on the same shared socket — reacts to
  // `git-status-changed` frames the server-side git internals watcher
  // pushes whenever `.git/HEAD`, `.git/index`, or `.git/refs/heads/*`
  // moves. Invalidates the porcelain peek + branches list so the file
  // tree's badges and the BranchPicker's dropdown stay live without
  // polling. See `lib/handlers/git-status-changed.ts`.
  useGitStatusChangedHandler(projectId);

  // Editor tabs store — owns the per-buffer tab list. Tree clicks call
  // `open()` which focuses the tab if its path is already open and
  // creates a new one otherwise (the focus-existing rule is enforced
  // by the reducer in `tab-state-machine.ts`).
  const editorTabs = useEditorTabsStore((s) => s.tabs);
  const editorActiveId = useEditorTabsStore((s) => s.activeId);
  const openEditorTab = useEditorTabsStore((s) => s.open);
  const closeAllEditorTabs = useEditorTabsStore((s) => s.closeAll);

  // Drain the editor tabs store on unmount. The parent (project-detail)
  // mounts this subtree under `key={projectId}` so a project swap
  // remounts us — clearing the store on unmount means the next project
  // starts with a fresh tab list, mirroring the previous single-buffer
  // contract enforced by the `code-mode-shell.test.tsx` "remount resets
  // selection" case.
  useEffect(() => {
    return () => {
      closeAllEditorTabs();
    };
  }, [closeAllEditorTabs]);

  const activeEditorTab = useMemo(
    () =>
      editorActiveId
        ? editorTabs.find((t) => t.id === editorActiveId) ?? null
        : null,
    [editorTabs, editorActiveId],
  );

  // Tree click handler — open-or-focus by path. The reducer dedupes by
  // path, so re-clicking the same row swaps focus without creating a
  // duplicate tab. Stable reference so FileTree doesn't re-render on
  // every parent commit.
  const handleTreeSelect = useCallback(
    (path: string) => {
      openEditorTab(path);
    },
    [openEditorTab],
  );

  // Polymorphic shell tab store — carries `diff` and `commit` tabs
  // opened from the SCM panel + history list. When a diff tab is the
  // active shell tab it takes precedence over the file pane (the SCM
  // surface only ever has one diff active at a time).
  const { tabs: shellTabs, activeId: shellActiveId } = useTabStore();
  const activeShellTab = shellActiveId
    ? shellTabs.find((t) => t.id === shellActiveId) ?? null
    : null;
  const activeDiffTab =
    activeShellTab && activeShellTab.kind === "diff" ? activeShellTab : null;

  // Save the active editor tab. The CodeModeEditor mounted on the
  // active path owns the buffer + sha pair; the shell triggers the
  // save by dispatching a custom DOM event the editor listens to.
  // This keeps the shell decoupled from the project-specific save
  // mutation hook while still letting Cmd+S short-circuit through
  // CodeMode's keyboard handler.
  //
  // The slice contract focuses on the keyboard wiring; the editor's
  // sha-conflict UX (already shipped in M00) handles the failure
  // branch the same way it does for the existing save button.
  const handleSaveActiveTab = useCallback(() => {
    if (!activeEditorTab) return;
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("flockctl:code-mode-save", {
        detail: { tabId: activeEditorTab.id, path: activeEditorTab.path },
      }),
    );
  }, [activeEditorTab]);

  return (
    <CodeModeShell
      target={target}
      showIgnored={showIgnored}
      onShowIgnoredChange={handleShowIgnoredChange}
      onSaveActiveTab={handleSaveActiveTab}
      quickOpenProjectId={projectId}
      filesPanel={
        <FileTree
          projectId={projectId}
          showIgnored={showIgnored}
          onSelect={handleTreeSelect}
        />
      }
    >
      <div className="flex h-full w-full flex-col">
        <TabBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeDiffTab ? (
            <DiffTabContent tab={activeDiffTab} />
          ) : activeEditorTab ? (
            <CodeModeEditor
              projectId={projectId}
              path={activeEditorTab.path}
            />
          ) : (
            <div
              data-testid="code-mode-empty"
              className="flex h-full items-center justify-center text-sm text-muted-foreground"
            >
              Select a file from the tree to open it.
            </div>
          )}
        </div>
      </div>
      {/*
        DirtyCloseConfirm is rendered as a sibling of the editor area so
        Radix's portal positions the dialog overlay above the entire
        Code-mode shell. The component is a no-op render when no tab
        carries `pendingClose: true`, so leaving it mounted is cheap.
      */}
      <DirtyCloseConfirm />
    </CodeModeShell>
  );
}

export default ProjectCodeMode;
