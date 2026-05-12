import * as React from "react";
import {
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  ExternalLink,
  Copy,
  CornerDownRight,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LOCAL_SERVER_ID, getActiveServerId } from "@/lib/server-store";

/**
 * Right-click context menu for a file-tree row. The trigger surface is
 * supplied by the caller (`children`) — typically the row itself —
 * which lets us preserve the row's existing click / keyboard wiring
 * (toggle / activate / focus) without the context-menu primitive
 * intercepting unrelated events.
 *
 * The menu's item list is conditional on:
 *
 *   - `kind` — folders show "New File" / "New Folder" at the top;
 *     files don't (they cannot host children).
 *   - The active daemon's locality — "Reveal in Finder" only renders
 *     when the active server is the local daemon. On a remote server
 *     the daemon's filesystem is the *remote host's* filesystem, and
 *     opening a Finder window there from a browser is meaningless;
 *     we hide the item rather than silently no-op so the operator
 *     doesn't think the click did something. "Copy Path" remains
 *     available so the operator can paste the absolute path into a
 *     terminal session on the remote host.
 *
 * The menu does NOT enforce the "cannot rename / delete the project
 * root" invariant — that's the caller's job (the project root is not
 * rendered as a row in the tree, so a right-click on it never reaches
 * here). The server-side `fs_invalid_path` would catch a stray attempt
 * regardless.
 *
 * Each item's click handler is a *prop callback* rather than wiring
 * the FS hooks inline — keeps the component pure, easy to unit-test
 * with spies, and lets the caller batch a confirm dialog or arborist
 * edit-mode start before issuing the FS call.
 */

export interface TreeContextMenuProps {
  /** Row's discriminator — controls which mutation items are visible. */
  kind: "file" | "dir";
  /** Project-relative path of the row (`src/foo.ts`). Used for label
   *  copy and passed back into callbacks. */
  path: string;
  /**
   * Absolute on-disk path of the row, when the caller can compute it
   * (typically `${project.path}/${path}`). Used by the Copy Path /
   * Reveal items. Optional — when omitted we fall back to copying the
   * relative path for "Copy Path" too, and the Reveal item is always
   * hidden (there's nothing to reveal).
   */
  absolutePath?: string;
  /** Callback fired when the operator picks "New File". Folders only. */
  onNewFile?: (parentPath: string) => void;
  /** Callback fired when the operator picks "New Folder". Folders only. */
  onNewFolder?: (parentPath: string) => void;
  /** Callback fired when the operator picks "Rename". The caller is
   *  responsible for putting the row into arborist's edit mode and,
   *  on commit, issuing the rename mutation. */
  onRename?: (path: string) => void;
  /** Callback fired when the operator picks "Delete". The caller is
   *  responsible for surfacing a confirm dialog before issuing the
   *  delete mutation. */
  onDelete?: (path: string) => void;
  /** Trigger surface — usually the {@link TreeNode} row. */
  children: React.ReactNode;
  /**
   * Test seam: override the locality probe. Production code reads from
   * the server store; tests can inject `false` to exercise the remote
   * code path without flipping the global active-server id.
   */
  isLocalServer?: boolean;
}

/**
 * Best-effort clipboard write. Falls back to a synchronous `execCommand`
 * path under jsdom (which does not expose `navigator.clipboard`) so
 * tests can spy on `document.execCommand` without poly-filling the
 * async API. Production browsers go through the async `writeText`.
 */
async function copyToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  // Legacy path: best-effort, no-op on environments that don't support
  // either API.
  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* swallow — clipboard is best-effort */
    }
    document.body.removeChild(ta);
  }
}

export function TreeContextMenu({
  kind,
  path,
  absolutePath,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  children,
  isLocalServer,
}: TreeContextMenuProps): React.ReactElement {
  const isLocal = isLocalServer ?? getActiveServerId() === LOCAL_SERVER_ID;
  const isDir = kind === "dir";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid={`tree-context-menu-${path}`}>
        {isDir && (
          <>
            <ContextMenuItem
              data-testid="tree-context-menu-new-file"
              onSelect={() => onNewFile?.(path)}
            >
              <FilePlus className="h-3.5 w-3.5" aria-hidden="true" />
              New File
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="tree-context-menu-new-folder"
              onSelect={() => onNewFolder?.(path)}
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        <ContextMenuItem
          data-testid="tree-context-menu-rename"
          onSelect={() => onRename?.(path)}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Rename
          {/* F2 is the de-facto shortcut for inline rename across
              VS Code / Finder / Explorer. We render the hint here so the
              menu is self-documenting; the actual key binding lives on
              the row's `onKeyDown` handler in TreeNode. */}
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="tree-context-menu-delete"
          onSelect={() => onDelete?.(path)}
          className="text-destructive data-highlighted:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Reveal in Finder — only meaningful when the active server is
            the local daemon (the daemon's filesystem == the operator's
            machine). For a remote daemon we hide the item entirely so
            the operator doesn't think the click did anything; the Copy
            Path item below is the documented degraded affordance. */}
        {isLocal && absolutePath && (
          <ContextMenuItem
            data-testid="tree-context-menu-reveal"
            onSelect={() => {
              // We don't have a daemon endpoint that runs `open` /
              // `xdg-open` yet; until that lands, copying the absolute
              // path is the next best thing — the operator can paste it
              // straight into a terminal. Wrapped in a `void` to satisfy
              // no-floating-promises.
              void copyToClipboard(absolutePath);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Reveal in Finder
          </ContextMenuItem>
        )}
        <ContextMenuItem
          data-testid="tree-context-menu-copy-path"
          onSelect={() => {
            // Absolute when known, relative when the caller couldn't
            // resolve it. Either way it's a single string the operator
            // can paste — don't surface the distinction in the label,
            // it would be noise in the dominant case.
            void copyToClipboard(absolutePath ?? path);
          }}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="tree-context-menu-copy-relative-path"
          onSelect={() => void copyToClipboard(path)}
        >
          <CornerDownRight className="h-3.5 w-3.5" aria-hidden="true" />
          Copy Relative Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
