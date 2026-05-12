import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  useFsCreateFile,
  useFsDelete,
  useFsMkdir,
  useFsRename,
} from "@/lib/hooks/fs";
import {
  useGitStatusForTree,
  type GitTreeStatus,
} from "@/lib/hooks/git-status-tree";

import { FileTreeFilter } from "./FileTreeFilter";
import { GitStatusTreeContext } from "./git-status-context";
import { TreeContextMenuContext } from "./tree-context-menu-context";
import { TreeNode } from "./TreeNode";
import { useFsTree, type FsTreeNode } from "./use-fs-tree";

export interface FileTreeProps {
  projectId: string;
  /**
   * Fired when the user activates a file row (Enter / double-click /
   * single-click on a leaf). Directories never call this — they toggle
   * open instead. Truncation markers are inert.
   */
  onSelect?: (path: string) => void;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * Fixed height for the virtualised list. When omitted the tree fills
   * its parent via a ResizeObserver; passing a number short-circuits
   * the observer and is useful for tests + storybook frames where the
   * layout is deterministic.
   */
  height?: number;
  /**
   * When `false`, gitignored entries are filtered OUT of the tree data
   * before react-arborist renders it. When `true` (default), they are
   * kept and dimmed via `opacity-50` on the row. Forwarded straight to
   * {@link useFsTree} — flipping the flag at runtime is a memo
   * recomputation, not a refetch.
   */
  showIgnored?: boolean;
  /**
   * Absolute on-disk root of the project, used by the right-click
   * context menu to render Copy Path / Reveal in Finder against the
   * full path. Optional: when omitted the tree is read-only — the
   * context menu is suppressed entirely. Pass `project.path` from
   * `useProject(projectId)` once it has resolved.
   */
  projectRoot?: string | null;
  /**
   * Disable the right-click context menu wholesale. Defaults to false.
   * Used by read-only embeddings (test fixtures, AGENTS.md picker)
   * that mount the tree just to navigate, never to mutate.
   */
  disableContextMenu?: boolean;
}

/**
 * react-arborist needs a numeric `height` for its virtualiser. In a
 * flexbox parent we don't know that height up front, so we measure the
 * wrapper's clientHeight on mount and on resize. This is the same
 * pattern react-arborist's own examples use; the alternative — passing
 * 100% — does not work because the underlying react-window list cannot
 * size from a percentage.
 */
function useContainerHeight(
  ref: React.RefObject<HTMLDivElement | null>,
  fallback: number,
): number {
  const [height, setHeight] = useState<number>(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Initial measure — `ResizeObserver` only fires on changes, so the
    // first paint would otherwise stay at `fallback`.
    setHeight(el.clientHeight || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height ?? fallback;
      // Avoid infinite loop: only update when the rounded height changed.
      setHeight((prev) => (Math.round(prev) === Math.round(next) ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return height;
}

/**
 * Lazy-loading file tree backed by `GET /projects/:id/fs/list`. Renders
 * the project root immediately, fetches each subdirectory the first
 * time it is expanded, and caches the result in React Query so a
 * sibling editor view doesn't re-fetch.
 *
 * Drag-and-drop is explicitly disabled — slice 04 will introduce a
 * context menu for rename/move; until then dragging would silently lose
 * the operation.
 *
 * Keyboard navigation, focus management, and roving tabindex come from
 * react-arborist out of the box. We just wire the activate/toggle
 * callbacks and forward the path.
 */
export function FileTree({
  projectId,
  onSelect,
  className,
  height: explicitHeight,
  showIgnored = true,
  projectRoot,
  disableContextMenu = false,
}: FileTreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  // 400 is just a "feels reasonable" fallback for the very first paint
  // before ResizeObserver fires. Once the parent finishes laying out we
  // jump to the real height on the next frame.
  const measuredHeight = useContainerHeight(treeRef, 400);
  const height = explicitHeight ?? measuredHeight;

  // Imperative tree handle — used by the right-click menu to drop the
  // selected row into rename mode (`treeApi.edit(id)`). Optional ref:
  // if it never resolves (jsdom mock for unit tests, the read-only
  // tree variant), the rename callback is a no-op.
  const treeApiRef = useRef<TreeApi<FsTreeNode> | null>(null);

  const { rootData, onToggle, isLoadingRoot, rootError } = useFsTree(
    projectId,
    { showIgnored },
  );

  // FS-mutation hooks. The hook factories cache stable mutation
  // functions per `projectId`; declaring them at the top of the
  // component keeps the wiring obvious and avoids the "hook called
  // inside callback" footgun.
  const renameMutation = useFsRename(projectId);
  const deleteMutation = useFsDelete(projectId);
  const mkdirMutation = useFsMkdir(projectId);
  const createFileMutation = useFsCreateFile(projectId);

  // Pending-delete state — drives the confirm dialog below. We keep
  // the FULL path here (not just a name) so the dialog body can render
  // the disambiguating context, and so the `onConfirm` handler doesn't
  // have to re-resolve which row was right-clicked.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    isDir: boolean;
  } | null>(null);

  const ctxValue = useMemo(() => {
    if (disableContextMenu) return null;
    return {
      projectRoot: projectRoot ?? null,
      onNewFile: (parentPath: string) => {
        // Two-step UX: prompt for the new name (cheap, synchronous —
        // no need for a custom dialog at this slice's scope), then
        // mutate. A blank or whitespace-only name cancels.
        if (typeof window === "undefined") return;
        const name = window.prompt("New file name");
        if (!name || !name.trim()) return;
        const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
        createFileMutation.mutate({ path });
      },
      onNewFolder: (parentPath: string) => {
        if (typeof window === "undefined") return;
        const name = window.prompt("New folder name");
        if (!name || !name.trim()) return;
        const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
        mkdirMutation.mutate({ path });
      },
      onRename: (path: string) => {
        // Drop the row into arborist's edit mode. The `onRename`
        // handler on the Tree below catches the committed value and
        // fires the FS mutation; until that resolves the row keeps
        // showing the old name.
        const api = treeApiRef.current;
        if (!api) return;
        void api.edit(path);
      },
      onDelete: (path: string) => {
        const node = treeApiRef.current?.get(path);
        const isDir = node?.data.kind === "dir";
        setPendingDelete({ path, isDir });
      },
    };
  }, [
    disableContextMenu,
    projectRoot,
    createFileMutation,
    mkdirMutation,
  ]);

  // Polled `git status` map → `Map<path, GitTreeStatus>`. Falls back to
  // an empty map while in-flight or on structured failure; the badge
  // simply stays absent in those cases. The map identity changes on
  // each refetch, which is the trigger TreeNode needs to re-render its
  // row when a path moves between status buckets.
  const { data: gitStatusMap } = useGitStatusForTree(projectId);

  // Debounced filter term, owned by FileTreeFilter — empty string means
  // "no filter active", which restores the normal lazy-loaded tree
  // shape. react-arborist consumes `searchTerm` + `searchMatch` and
  // handles match-highlighting plus ancestor expansion internally; we
  // only need to provide the predicate.
  const [searchTerm, setSearchTerm] = useState("");

  // `searchMatch` is called once per node per render; keep it cheap and
  // stable. Ignore the synthetic truncation marker — its name is
  // operator-facing copy ("+ more entries (truncated)") and matching
  // against the literal "truncated" string would surface noise.
  const searchMatch = useCallback(
    (node: NodeApi<FsTreeNode>, term: string) => {
      const data = node.data;
      if (data.kind === "truncated") return false;
      return data.name.toLowerCase().includes(term.toLowerCase());
    },
    [],
  );

  // Body picks one of: loading spinner, error placeholder, empty state,
  // or the actual virtualised tree. The filter input renders above
  // every state so the operator can start typing while the root
  // listing is in flight (the typed value is held locally and applied
  // once the tree mounts).
  let body: React.ReactNode;
  if (isLoadingRoot && rootData.length === 0) {
    body = (
      <div
        data-testid="file-tree-loading"
        className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </div>
    );
  } else if (rootError) {
    body = (
      <div
        data-testid="file-tree-error"
        data-error-code={rootError}
        className="flex h-full items-center justify-center px-3 text-center text-xs text-destructive"
      >
        Failed to load file tree ({rootError}).
      </div>
    );
  } else if (rootData.length === 0) {
    body = (
      <div
        data-testid="file-tree-empty"
        className="flex h-full items-center justify-center text-xs text-muted-foreground"
      >
        No files
      </div>
    );
  } else {
    body = (
      <Tree<FsTreeNode>
        ref={treeApiRef}
        data={rootData}
        openByDefault={false}
        width="100%"
        height={height}
        // M23 / T06 — 22px aligns rows to the Monaco `editor-line`
        // rhythm so the tree and the open file scroll in lockstep
        // when an editor is mounted alongside.
        rowHeight={22}
        disableDrag
        disableDrop
        // The tree's idAccessor reads `id` from each node — we set this
        // to the relative path so toggle / focus state survives across
        // re-renders triggered by lazy loads.
        onToggle={onToggle}
        onActivate={(node) => {
          const data = node.data;
          if (data.kind === "file") {
            onSelect?.(data.path);
          }
        }}
        // Inline rename — react-arborist's edit mode commits via this
        // handler, passing `{ id, name }` (id == relative path of the
        // node being edited). We compute the new path by replacing the
        // basename in place so a rename of `src/foo.ts` to `bar.ts`
        // produces `src/bar.ts`. Empty / unchanged names short-circuit
        // before reaching the FS mutation.
        onRename={({ id, name }) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const idx = id.lastIndexOf("/");
          const parent = idx < 0 ? "" : id.slice(0, idx);
          const next = parent ? `${parent}/${trimmed}` : trimmed;
          if (next === id) return;
          renameMutation.mutate({ from: id, to: next });
        }}
        // Filter wiring: react-arborist runs `searchMatch` against every
        // node, hides non-matches, and auto-expands ancestors of any
        // match so the operator can see where the hit lives. Empty
        // `searchTerm` short-circuits the filter — the tree renders its
        // normal shape, including manually-collapsed folders.
        searchTerm={searchTerm}
        searchMatch={searchMatch}
      >
        {TreeNode}
      </Tree>
    );
  }

  return (
    <GitStatusTreeContext.Provider value={gitStatusMap ?? EMPTY_STATUS_MAP}>
      <TreeContextMenuContext.Provider value={ctxValue}>
        <div
          data-testid="file-tree-root"
          className={cn(
            "file-tree-root flex h-full w-full flex-col overflow-hidden",
            className,
          )}
        >
          <FileTreeFilter onChange={setSearchTerm} />
          {/* The tree subtree is wrapped in its own flex-1 container so
              the virtualiser's height measurement excludes the filter
              row. */}
          <div ref={treeRef} className="min-h-0 flex-1">
            {body}
          </div>
        </div>
        {/* Delete confirm dialog — keyed off `pendingDelete`, mounted at
            the FileTree boundary so it survives row unmounts (the
            row is removed from the tree the moment the delete starts,
            but the dialog should keep showing the path it was opened
            against). The recursive opt-in is keyed off `isDir` — folders
            opt into recursive removal because the tree never surfaces
            an "empty folder" affordance the operator could rely on. */}
        {pendingDelete && (
          <ConfirmDialog
            open
            onOpenChange={(o) => {
              if (!o) setPendingDelete(null);
            }}
            title={pendingDelete.isDir ? "Delete folder?" : "Delete file?"}
            description={`This will permanently delete ${pendingDelete.path}. This cannot be undone.`}
            isPending={deleteMutation.isPending}
            onConfirm={() => {
              const target = pendingDelete;
              deleteMutation.mutate(
                { path: target.path, recursive: target.isDir },
                {
                  onSettled: () => setPendingDelete(null),
                },
              );
            }}
          />
        )}
      </TreeContextMenuContext.Provider>
    </GitStatusTreeContext.Provider>
  );
}

/**
 * Stable identity fallback so a transient `undefined` from React Query
 * (initial load, structured failure) doesn't break referential equality
 * for memoised consumers. Created once at module scope.
 */
const EMPTY_STATUS_MAP: Map<string, GitTreeStatus> = new Map();
