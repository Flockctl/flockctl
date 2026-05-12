import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, FolderTree, GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";
import type { GitTarget } from "@/components/git/git-dropdown-button";
import { SourceControlPanel } from "@/components/git/SourceControlPanel";

import { useEditorTabsStore } from "./tab-store";
import { QuickOpen } from "./QuickOpen";
import { useQuickOpenIndexStore } from "./quick-open-store";

/**
 * The two activities the Code-mode left rail can surface today. Each
 * activity owns one icon button on the activity bar and one side panel
 * to the right of it. Adding a new activity ("Search", "Run", …) is a
 * one-row addition to {@link ACTIVITIES}.
 */
export type CodeModeActivity = "files" | "scm";

interface ActivityDef {
  id: CodeModeActivity;
  label: string;
  icon: typeof FolderTree;
  testId: string;
}

const ACTIVITIES: ActivityDef[] = [
  {
    id: "files",
    label: "Files",
    icon: FolderTree,
    testId: "code-mode-tab-files",
  },
  {
    id: "scm",
    label: "Source Control",
    icon: GitBranch,
    testId: "code-mode-tab-scm",
  },
];

/**
 * CodeMode — the project-detail "Code" view. Shape mirrors VSCode:
 *
 *   ┌──┬───────────────┬───────────────────────────────────────────┐
 *   │A │  Side panel   │              Editor / main                │
 *   │c │  (Files |     │              (out of scope —              │
 *   │t │   SourceCtrl) │               passed in via children)     │
 *   │  │               │                                           │
 *   └──┴───────────────┴───────────────────────────────────────────┘
 *      └─ activity bar (icons stacked vertically)
 *
 * - The activity bar is a thin column of icon buttons (w-10).
 *   Clicking one swaps which side panel is shown.
 *   Clicking the active one collapses the side panel entirely.
 * - The side panel is `min-w-[260px]`. The Files panel is rendered via
 *   the `filesPanel` slot the parent passes in (today's existing tree
 *   panel — we don't re-implement it here). The SourceControl panel is
 *   owned by this component because it's brand-new in this slice.
 *
 * Test-id contract:
 *   - `code-mode-root`         — outer flex container.
 *   - `code-mode-activity-bar` — vertical icon column.
 *   - `code-mode-tab-files`    — Files icon button.
 *   - `code-mode-tab-scm`      — Source Control icon button.
 *   - `code-mode-side-panel`   — the active side panel container.
 *   - `code-mode-files-panel`  — the Files slot wrapper (only when active).
 *   - `code-mode-scm-panel`    — the SCM slot wrapper (only when active).
 *   - `code-mode-main`         — the main editor area (children).
 */
export interface CodeModeProps {
  target: GitTarget;
  /**
   * The Files panel content — typically the existing project tree.
   * Owned by the caller so this component stays portable.
   */
  filesPanel: ReactNode;
  /**
   * The main editor area. Out of scope for this slice — the diff click
   * handler that fills it lands in slice 02.
   */
  children?: ReactNode;
  /**
   * Initial active activity. Defaults to `"files"` so an operator who
   * lands on the page sees the file tree first (the dominant flow).
   */
  defaultActivity?: CodeModeActivity;
  /**
   * Optional ahead/behind snapshot forwarded to the SCM panel header.
   * Slice 01 will source this from a live query; for now the parent can
   * pass a stub or omit it entirely.
   */
  aheadBehind?: { ahead: number; behind: number } | null;
  /**
   * Whether the Files panel should currently surface gitignored entries.
   * Drives the in-header toggle button rendered above the file tree.
   * The shell renders the toggle UI but the *state* is owned by the
   * parent so the same value can be threaded into {@link FileTree}'s
   * `showIgnored` prop without going through a context.
   *
   * Defaults to `true` — operators see every file by default and
   * explicitly hide the noise. The persistent default lives one level
   * up (the project-detail wrapper persists to localStorage).
   */
  showIgnored?: boolean;
  /**
   * Fired when the operator clicks the toggle. Required when
   * `showIgnored` is provided; omitted when the caller does not surface
   * the toggle (e.g. test frames that don't care about the flag).
   */
  onShowIgnoredChange?: (next: boolean) => void;
  /**
   * Cmd/Ctrl+S handler — fired when the editor's "save active tab"
   * shortcut hits while the Code-mode container has focus. The shell
   * does NOT know how to save (it has no project id, no buffer, no
   * mutation hook); the parent owns that wiring and passes the
   * thunk in. Omitted in test frames or in scopes that don't support
   * writing (e.g. workspace-level diffs).
   */
  onSaveActiveTab?: () => void | Promise<void>;
  /**
   * Project id for the Quick-Open (Cmd+P) modal. When provided, the
   * shell mounts a `<QuickOpen>` dialog and registers a
   * container-scoped Cmd+P binding that toggles it. Omitted from
   * scopes that don't have a project (workspace-level diffs, test
   * frames that just want the activity-bar shell) — Cmd+P then is a
   * no-op so a stray keypress can't open an empty modal.
   */
  quickOpenProjectId?: string;
}

export function CodeMode({
  target,
  filesPanel,
  children,
  defaultActivity = "files",
  aheadBehind = null,
  showIgnored = true,
  onShowIgnoredChange,
  onSaveActiveTab,
  quickOpenProjectId,
}: CodeModeProps) {
  const [activity, setActivity] = useState<CodeModeActivity | null>(
    defaultActivity,
  );

  // Quick-Open (Cmd+P) modal visibility. The shell owns the open state
  // because the shortcut binding lives here; the modal itself is a
  // self-contained component that fetches its index off the
  // quick-open-store. We pre-warm the index on Code-mode mount (when
  // we have a projectId) so the first Cmd+P press is instant.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const requestQuickOpenIndex = useQuickOpenIndexStore(
    (s) => s.requestIndex,
  );
  useEffect(() => {
    if (!quickOpenProjectId) return;
    void requestQuickOpenIndex(quickOpenProjectId);
  }, [quickOpenProjectId, requestQuickOpenIndex]);

  // Keyboard handler is attached to the container — NOT `document` —
  // so the shortcuts only fire while the operator is interacting with
  // Code mode. Other modes (Tasks table, Chats, etc.) keep their own
  // bindings without a global listener fighting them. The handler
  // listens during the bubble phase so editor-internal handlers
  // (Monaco's own Cmd+S preview, Cmd+W in command palette) get a
  // chance first; we only act on events that have not been
  // `defaultPrevented` upstream.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest save callback — captured in a ref so the keydown listener
  // (which we register once per container) always sees the freshest
  // closure without needing the effect to re-bind on every parent
  // render.
  const saveActiveRef = useRef<typeof onSaveActiveTab>(undefined);
  saveActiveRef.current = onSaveActiveTab;

  // Same trick for the Quick-Open project id — the listener fires
  // `setQuickOpenOpen(true)` only when a project id is wired, so the
  // ref lets prop changes propagate without re-binding the listener.
  const quickOpenProjectIdRef = useRef<string | undefined>(
    quickOpenProjectId,
  );
  quickOpenProjectIdRef.current = quickOpenProjectId;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.defaultPrevented) return;

      // Pull the freshest store snapshot at event time — `getState()`
      // returns the current values without re-rendering this
      // component, which is what we want for one-shot actions.
      const store = useEditorTabsStore.getState();

      // Cmd/Ctrl+W — close active tab. On a clean tab the reducer
      // removes it; on a dirty tab it flips `pendingClose` and the
      // <DirtyCloseConfirm> dialog (mounted by the parent) opens.
      if (e.key === "w" || e.key === "W") {
        if (!store.activeId) return;
        e.preventDefault();
        e.stopPropagation();
        store.close(store.activeId);
        return;
      }

      // Cmd/Ctrl+P — open the Quick-Open modal. The shortcut is
      // intentionally container-scoped (the listener is on `el`, not
      // `document`) so other modes don't fight for the binding. When
      // no `quickOpenProjectId` is wired, the shortcut is a no-op —
      // but we still preventDefault so the browser's "Print" dialog
      // doesn't fire on top of an unrelated mode mount.
      if (e.key === "p" || e.key === "P") {
        if (e.shiftKey) return; // Cmd+Shift+P reserved for command palette
        e.preventDefault();
        e.stopPropagation();
        if (!quickOpenProjectIdRef.current) return;
        setQuickOpenOpen(true);
        return;
      }

      // Cmd/Ctrl+S — save active tab. Delegate to the parent-supplied
      // thunk; without one the shortcut is a noop (still preventDefault
      // so the browser's "save page" dialog doesn't fire).
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        e.stopPropagation();
        const fn = saveActiveRef.current;
        if (!fn) return;
        // Errors are the parent's problem — we deliberately don't
        // surface them here. The save handler owns its own toast /
        // banner UX.
        Promise.resolve(fn()).catch(() => {
          /* swallow — caller surfaces errors */
        });
        return;
      }

      // Cmd/Ctrl+1..9 — focus tab at index. `9` is the spec'd "last"
      // (matches VSCode), but the simpler "index N" rule is the one
      // the slice asks for.
      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        const tab = store.tabs[idx];
        if (!tab) return;
        e.preventDefault();
        e.stopPropagation();
        store.focus(tab.id);
        return;
      }

      // Cmd/Ctrl+] — next tab (wraps).  Cmd/Ctrl+[ — previous tab
      // (wraps). No-op when no tabs are open or when the active tab
      // is somehow not in the list (defensive — `findIndex` returns
      // -1 then).
      if (e.key === "]" || e.key === "[") {
        if (store.tabs.length === 0 || !store.activeId) return;
        const curIdx = store.tabs.findIndex((t) => t.id === store.activeId);
        if (curIdx < 0) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "]" ? 1 : -1;
        const nextIdx =
          (curIdx + delta + store.tabs.length) % store.tabs.length;
        const nextTab = store.tabs[nextIdx];
        if (nextTab) store.focus(nextTab.id);
        return;
      }
    };

    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
    };
    // The handler reads the latest `onSaveActiveTab` via a ref, so
    // re-registering on prop-change isn't necessary — and a stable
    // listener avoids losing focus state on every parent render.
  }, []);

  const handleActivityClick = (next: CodeModeActivity) => {
    // Clicking the active icon collapses the side panel — VSCode parity.
    // Clicking a different icon swaps to it (and re-opens if collapsed).
    setActivity((prev) => (prev === next ? null : next));
  };

  return (
    <div
      ref={containerRef}
      // tabIndex makes the container focusable so a click anywhere
      // inside Code-mode lands keyboard focus on the listener element.
      // -1 keeps it out of the tab-order; the operator never tabs to a
      // wrapper div on purpose.
      tabIndex={-1}
      data-testid="code-mode-root"
      className="flex h-full w-full outline-none"
    >
      {/* ─── Activity bar ───────────────────────────────────────────── */}
      <nav
        data-testid="code-mode-activity-bar"
        aria-label="Code mode activities"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-2"
      >
        {ACTIVITIES.map((a) => {
          const Icon = a.icon;
          const isActive = activity === a.id;
          return (
            <button
              key={a.id}
              type="button"
              data-testid={a.testId}
              data-active={isActive ? "true" : "false"}
              onClick={() => handleActivityClick(a.id)}
              title={a.label}
              aria-label={a.label}
              aria-pressed={isActive}
              className={cn(
                "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-foreground",
                isActive && "text-foreground",
              )}
            >
              {/* Active-tab indicator: a 2px primary-coloured rail on
                  the left edge, mirroring VSCode's activity-bar tab. */}
              {isActive && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary"
                />
              )}
              <Icon className="h-5 w-5" aria-hidden />
            </button>
          );
        })}
      </nav>

      {/* ─── Side panel ─────────────────────────────────────────────── */}
      {activity && (
        <aside
          data-testid="code-mode-side-panel"
          data-activity={activity}
          className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r"
        >
          {activity === "files" && (
            <div
              data-testid="code-mode-files-panel"
              className="flex flex-1 flex-col overflow-hidden"
            >
              {/* Header strip — owned by the shell so the toggle sits at
                  a stable, visually-aligned position above whatever
                  caller-supplied tree the `filesPanel` slot renders.
                  The strip is rendered unconditionally so the layout
                  shape is stable across `showIgnored` callbacks; we
                  only suppress the toggle button when the parent did
                  not wire the change handler (i.e. test frames that
                  don't care about the flag). */}
              <div
                data-testid="code-mode-files-header"
                className="flex h-7 shrink-0 items-center justify-between border-b bg-muted/30 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                <span>Files</span>
                {onShowIgnoredChange && (
                  <button
                    type="button"
                    data-testid="code-mode-show-ignored-toggle"
                    data-show-ignored={showIgnored ? "true" : "false"}
                    aria-pressed={showIgnored}
                    onClick={() => onShowIgnoredChange(!showIgnored)}
                    title={
                      showIgnored
                        ? "Hide gitignored files"
                        : "Show gitignored files"
                    }
                    aria-label={
                      showIgnored
                        ? "Hide gitignored files"
                        : "Show gitignored files"
                    }
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors",
                      "hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                      showIgnored && "text-foreground",
                    )}
                  >
                    {showIgnored ? (
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">{filesPanel}</div>
            </div>
          )}
          {activity === "scm" && (
            <div
              data-testid="code-mode-scm-panel"
              className="flex-1 overflow-hidden"
            >
              <SourceControlPanel
                target={target}
                aheadBehind={aheadBehind}
              />
            </div>
          )}
        </aside>
      )}

      {/* ─── Main editor area ───────────────────────────────────────── */}
      <main
        data-testid="code-mode-main"
        className="flex-1 overflow-auto"
      >
        {children}
      </main>

      {/* ─── Quick-Open (Cmd+P) modal ───────────────────────────────── */}
      {/*
        Mounted only when a `quickOpenProjectId` is wired. The dialog
        renders nothing while closed (Radix portals lazily) so the
        cost of leaving it mounted is minimal.
      */}
      {quickOpenProjectId && (
        <QuickOpen
          projectId={quickOpenProjectId}
          open={quickOpenOpen}
          onOpenChange={setQuickOpenOpen}
        />
      )}
    </div>
  );
}
