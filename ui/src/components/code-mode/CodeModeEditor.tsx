/**
 * CodeModeEditor — single-buffer file pane that owns its sha + dirty
 * lifecycle and reacts to live `fs.changed` frames via the open-tabs
 * store in `lib/handlers/fs-changed.ts`.
 *
 * Responsibilities:
 *
 *   - Fetch the file via `useProjectFile` (the existing read hook).
 *   - Register the buffer with `fsTabStore` so the fs-changed handler
 *     can look up `(heldSha, dirty)` when a frame arrives for this
 *     path. Unregister on unmount or path swap.
 *   - Track local edits — `dirty=true` from the first keystroke that
 *     diverges from `heldSha`'s buffer.
 *   - Render a {@link AgentTouchedBanner} when the store flips to
 *     `conflict`. Banner actions:
 *       - Reload: refetch the file, replace the buffer, clear dirty +
 *         conflict, take the new sha.
 *       - Keep mine: dismiss the banner; leave the dirty buffer intact.
 *   - **Large-file flow.** When the daemon refuses a whole-file read with
 *     `fs_too_large`, render the {@link LargeFileTooBig} empty state
 *     instead of an editor. A click on its "Open first 64 KB read-only"
 *     button flips local `partialMode` state; the same `useProjectFile`
 *     hook re-fires with a `range` option and the editor mounts with the
 *     `partial` prop (forces read-only + sticky banner). Cmd+S inside
 *     the partial editor is a no-op that fires a toast — saving a slice
 *     would silently truncate the rest of the file on disk.
 *
 * **Per-tab Monaco model.** The component is mounted exactly once for
 * the lifetime of the Code-mode shell — the parent (`ProjectCodeMode`)
 * swaps `path` + the active tab's value rather than remounting. Down
 * the stack, `<Editor>` from `@monaco-editor/react` keys its model
 * cache off the URI (`monaco.Uri.file(path)`) so cursor position,
 * scroll offset, folds, and selection survive a tab switch for free.
 * Re-opening a tab returns to the exact view state it had when the
 * user last left it. See `TabBar.tsx` for the matching tab strip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";

import { CodeEditor } from "@/components/CodeEditor";
import { useProjectFile } from "@/lib/hooks";
import { fsTabStore } from "@/lib/handlers/fs-changed";
import { useTabState } from "@/lib/handlers/fs-changed";

import { AgentTouchedBanner } from "./AgentTouchedBanner";
import { LARGE_FILE_PARTIAL_BYTES, LargeFileTooBig } from "./LargeFileBanner";

export interface CodeModeEditorProps {
  projectId: string;
  /** Project-relative POSIX path of the file to display. */
  path: string;
  /**
   * Optional — when supplied, the editor enters "writable" mode and
   * relays edits to the parent. Saving is the parent's responsibility;
   * the editor only tracks dirty/conflict state. The slice that lands
   * the save endpoint will pass this; until then the editor is
   * read-only.
   */
  onChange?: (next: string) => void;
}

/**
 * Pull `stat.size` out of the daemon's `fs_too_large` message. The
 * server formats it as `"file is <N> bytes; <cap>-byte cap exceeded"`
 * (see `readProjectFile` in `src/services/fs-operations.ts`). Returns
 * `undefined` when the message is missing or differently shaped — the
 * empty state degrades gracefully ("file too large" without a number).
 *
 * Exported for unit-test reach without driving a full hook fixture.
 */
export function parseTooLargeSize(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const m = /file is (\d+) bytes/i.exec(message);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function CodeModeEditor({
  projectId,
  path,
  onChange,
}: CodeModeEditorProps) {
  // `partialMode` is a UI-only opt-in: the operator clicked "Open first
  // 64 KB read-only" on the `fs_too_large` empty state, so the next
  // hook firing should ask for a slice. Reset on path/project swap so
  // navigating away from the large file and back lands on the empty
  // state again (don't surprise the operator with an editor that's
  // suddenly partial without them re-confirming).
  const [partialMode, setPartialMode] = useState(false);
  useEffect(() => {
    setPartialMode(false);
  }, [projectId, path]);

  const range = useMemo(
    () =>
      partialMode
        ? { offset: 0, length: LARGE_FILE_PARTIAL_BYTES }
        : undefined,
    [partialMode],
  );
  const fileQuery = useProjectFile(projectId, path, { range });

  // Local mirror of the editor's value — tracked here so dirty detection
  // is independent of Monaco's internal model. Initialised to `null`
  // (sentinel for "not yet loaded") so a stale render between path
  // swaps doesn't accidentally claim dirty.
  const [buffer, setBuffer] = useState<string | null>(null);

  // Reset on path / project swap — a leftover buffer from the previous
  // file would otherwise paint until the new fetch resolves.
  useEffect(() => {
    setBuffer(null);
  }, [projectId, path]);

  // Sync buffer + register tab whenever a fresh `ok=true` body lands.
  // The register call is also responsible for tearing the entry down on
  // unmount. We register on partial responses too so the path is still
  // tracked in the open-tab store (fs.changed reconciliation, screen-
  // reader announcements, …) — even though dirty/conflict semantics
  // never fire for a forced-read-only editor.
  useEffect(() => {
    if (!fileQuery.data || fileQuery.data.ok !== true) return;
    const data = fileQuery.data;

    // Only initialise the buffer if it is unset or we are not dirty —
    // a successful background refetch (after the user dismissed the
    // banner with "Keep mine") must not stomp the user's edits.
    setBuffer((prev) => {
      const tab = fsTabStore.get(projectId, path);
      if (prev !== null && tab?.dirty) return prev;
      return data.content;
    });

    const unsub = fsTabStore.register({
      projectId,
      path,
      heldSha: data.sha,
      dirty: false,
      conflict: { kind: "none" },
    });
    return unsub;
  }, [fileQuery.data, projectId, path]);

  const tab = useTabState(projectId, path);

  /** Inline edit handler — flips `dirty` on first divergence. */
  const handleEdit = useCallback(
    (next: string) => {
      setBuffer(next);
      const cur = fsTabStore.get(projectId, path);
      if (!cur) return;
      // Compare against the registered initial buffer rather than the
      // last frame we saw — `heldSha` is the disk anchor; the editor
      // owns its own equality check.
      const isClean =
        fileQuery.data &&
        fileQuery.data.ok &&
        next === fileQuery.data.content;
      if (cur.dirty !== !isClean) {
        fsTabStore.update(projectId, path, { dirty: !isClean });
      }
      onChange?.(next);
    },
    [projectId, path, fileQuery.data, onChange],
  );

  /** Reload — discard local edits, refetch, take the disk sha. */
  const handleReload = useCallback(() => {
    fileQuery
      .refetch()
      .then((res) => {
        if (res.data && res.data.ok) {
          setBuffer(res.data.content);
          fsTabStore.update(projectId, path, {
            heldSha: res.data.sha,
            dirty: false,
            conflict: { kind: "none" },
          });
        }
      })
      .catch(() => {
        // Refetch error: leave the conflict banner up so the user can
        // try again or pick "Keep mine". `useProjectFile` surfaces the
        // error in `fileQuery.error`; we don't need to duplicate it.
      });
  }, [fileQuery, projectId, path]);

  /** Keep mine — clear the conflict; leave dirty + buffer intact. */
  const handleKeepMine = useCallback(() => {
    fsTabStore.update(projectId, path, { conflict: { kind: "none" } });
  }, [projectId, path]);

  // ─── Save-key toast (partial mode) ─────────────────────────────────
  //
  // When the editor is showing a slice we want Cmd+S / Ctrl+S to do
  // nothing useful — but explicitly, with a toast, so the operator
  // doesn't think their save just landed silently. The CodeEditor
  // already forces `readOnly: true` whenever `partial` is set, so
  // Monaco's built-in save command is a no-op; we just need to surface
  // the user-facing reason.
  const [savingDisabledToast, setSavingDisabledToast] = useState<{
    id: number;
    message: string;
  } | null>(null);
  const toastIdRef = useRef(0);
  const fireSavingDisabledToast = useCallback(() => {
    const id = ++toastIdRef.current;
    setSavingDisabledToast({ id, message: "Saving disabled on partial open" });
    setTimeout(() => {
      setSavingDisabledToast((prev) => (prev?.id === id ? null : prev));
    }, 3000);
  }, []);

  // Derived "we are rendering a partial slice right now" flag. Used both
  // for the editor's `partial` prop and to decide whether to register
  // the Cmd+S toast on mount. `partialMode` (the operator's opt-in
  // intent) is not the same thing — the response can come back partial
  // on its own (cached, restored from a previous session) before the
  // user clicks anything.
  const isPartialResponse =
    fileQuery.data &&
    fileQuery.data.ok === true &&
    "partial" in fileQuery.data &&
    fileQuery.data.partial === true;

  const handleEditorMount: OnMount = useCallback(
    (editor, m) => {
      if (!isPartialResponse) return;
      // Capture Cmd+S / Ctrl+S on the editor surface — Monaco's
      // `KeyMod.CtrlCmd | KeyCode.KeyS` resolves to ⌘S on macOS and
      // Ctrl+S elsewhere, matching the platform's "save" muscle memory.
      // A `readOnly` editor would otherwise swallow the chord silently;
      // the toast is the only signal the operator gets.
      editor.addCommand(
        m.KeyMod.CtrlCmd | m.KeyCode.KeyS,
        () => {
          fireSavingDisabledToast();
        },
      );
    },
    [isPartialResponse, fireSavingDisabledToast],
  );

  // Error branches FIRST — `useProjectFile` can return `error` while
  // `data` is still undefined and `buffer` is null; the loading branch
  // would otherwise win and trap the user on a spinner forever.
  if (fileQuery.error) {
    return (
      <div
        data-testid="code-mode-error"
        className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
      >
        Failed to open {path}: {fileQuery.error.message}
      </div>
    );
  }

  // Large-file empty state — the operator hit the 2 MiB whole-file
  // ceiling and hasn't yet opted into a partial open. Branch before the
  // generic `ok: false` error path so the dedicated UI wins.
  if (
    fileQuery.data &&
    fileQuery.data.ok === false &&
    fileQuery.data.error_code === "fs_too_large" &&
    !partialMode
  ) {
    return (
      <LargeFileTooBig
        path={path}
        totalBytes={parseTooLargeSize(fileQuery.data.message)}
        onOpenPartial={() => setPartialMode(true)}
      />
    );
  }

  if (fileQuery.data && fileQuery.data.ok === false) {
    const errorCode = fileQuery.data.error_code;
    return (
      <div
        data-testid="code-mode-error"
        data-error-code={errorCode}
        className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
      >
        Cannot open {path} ({errorCode})
        {fileQuery.data.message ? `: ${fileQuery.data.message}` : null}
      </div>
    );
  }

  if (fileQuery.isLoading || buffer === null) {
    return (
      <div
        data-testid="code-mode-loading"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading {path}…
      </div>
    );
  }

  const showBanner = tab?.conflict.kind === "conflict";

  // The CodeEditor's `partial` prop drives both the sticky top-banner
  // (under the editor's data-testid="code-editor") and the forced
  // read-only invariant. Only set it when the response we are
  // rendering is itself partial — the read hook can momentarily hold a
  // stale whole-file response while a partial refetch is pending.
  const partialPayload =
    isPartialResponse &&
    fileQuery.data &&
    fileQuery.data.ok === true &&
    "partial" in fileQuery.data
      ? {
          totalBytes: fileQuery.data.totalSize,
          shownBytes: fileQuery.data.range.length,
        }
      : undefined;

  return (
    <div
      data-testid="code-mode-editor"
      data-open-path={path}
      data-dirty={tab?.dirty ? "true" : "false"}
      data-partial={partialPayload ? "true" : "false"}
      className="flex h-full w-full flex-col"
    >
      {showBanner && tab?.conflict.kind === "conflict" && (
        <AgentTouchedBanner
          source={tab.conflict.source}
          path={path}
          onReload={handleReload}
          onKeepMine={handleKeepMine}
        />
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor
          value={buffer}
          path={path}
          height="100%"
          partial={partialPayload}
          onMount={handleEditorMount}
          onChange={onChange && !partialPayload ? handleEdit : undefined}
        />
      </div>
      {savingDisabledToast && (
        <div
          data-testid="code-mode-toast"
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 right-4 z-50 rounded border border-border bg-background px-3 py-2 text-sm shadow"
        >
          {savingDisabledToast.message}
        </div>
      )}
    </div>
  );
}

export default CodeModeEditor;
