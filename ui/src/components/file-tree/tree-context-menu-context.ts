import { createContext } from "react";

/**
 * Per-tree context menu wiring. The tree's row component pulls the
 * callbacks via context — react-arborist hands the row `node`, `style`,
 * `dragHandle` and nothing else, so prop drilling through the library
 * is not on the table.
 *
 * `null` callbacks (or a `null` context value) disable the menu — used
 * by stripped-down embeddings (test fixtures, the read-only tree in the
 * AGENTS.md picker) that have no business mutating the filesystem.
 *
 * `projectRoot` is the absolute on-disk root of the project (e.g.
 * `/Users/.../src`), used by the menu to render "Copy Path" and the
 * Reveal-in-Finder item — both want the *absolute* path. Optional:
 * when omitted, the menu falls back to copying the relative path.
 */
export interface TreeContextMenuValue {
  /** Absolute path of the project root, or null when unknown. */
  projectRoot: string | null;
  /** Callback for "New File" inside a folder. */
  onNewFile?: (parentPath: string) => void;
  /** Callback for "New Folder" inside a folder. */
  onNewFolder?: (parentPath: string) => void;
  /** Callback for "Rename" — caller starts arborist's edit mode. */
  onRename?: (path: string) => void;
  /** Callback for "Delete" — caller surfaces the confirm dialog. */
  onDelete?: (path: string) => void;
}

export const TreeContextMenuContext =
  createContext<TreeContextMenuValue | null>(null);
