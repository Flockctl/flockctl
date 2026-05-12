import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  fetchFsList,
  type FsListEntry,
  type FsListErrorCode,
  type FsListResponse,
} from "@/lib/api/fs";
import { fsListQueryKey } from "@/lib/hooks/fs";

/**
 * The data shape react-arborist consumes. We expose the same TypeScript
 * surface to TreeNode so its render prop has full type information without
 * casting through `any`. `kind` is the discriminator:
 *
 *   - `"file"`       → leaf row, click to open in the editor.
 *   - `"dir"`        → expandable folder.
 *   - `"truncated"`  → synthetic non-clickable marker appended after the
 *                      last real entry whenever the server reports the
 *                      `truncated:true` flag for that listing. We fold it
 *                      into the children list so the tree component never
 *                      needs to know about it.
 *
 * We deliberately keep `path` distinct from the react-arborist `id` field
 * even though they're equal in practice: making the path explicit means
 * downstream consumers don't reach into id parsing, and we have somewhere
 * to put a sentinel suffix on truncation rows without polluting the
 * navigable path space.
 */
export type FsTreeNode =
  | {
      kind: "file";
      id: string;
      path: string;
      name: string;
      ignored: boolean;
      size?: number;
      mtime?: number;
    }
  | {
      kind: "dir";
      id: string;
      path: string;
      name: string;
      ignored: boolean;
      mtime?: number;
      hasChildren: boolean;
      /** Children loaded so far; `undefined` means "not loaded yet". */
      children: FsTreeNode[] | undefined;
    }
  | {
      kind: "truncated";
      id: string;
      path: string;
      name: string;
    };

export interface UseFsTreeResult {
  /** The data array passed to `<Tree data=…>`. */
  rootData: FsTreeNode[];
  /**
   * Wire to react-arborist's `onToggle` to lazy-load directory contents
   * the first time a folder is expanded. No-op once a path is loaded.
   */
  onToggle: (id: string) => void;
  /** True while the *root* listing is in flight. */
  isLoadingRoot: boolean;
  /** Set if the root listing failed (no entry to show). */
  rootError: FsListErrorCode | null;
  /**
   * Lower-level primitive: fetch one path's listing, prime the React
   * Query cache, and update local state. Exposed for tests + callers that
   * want to refresh a node manually.
   */
  loadChildren: (path: string) => Promise<FsListResponse>;
}

/**
 * Sentinel appended to a directory's id to make a truncation marker
 * distinguishable from any real path. Real paths never end in `/`, so a
 * `/` + sentinel suffix is unambiguous.
 */
function truncatedId(parentPath: string): string {
  return `${parentPath}/__truncated__`;
}

/**
 * Map one server-side `FsListEntry` to the tree node shape. Directories
 * arrive with `children: undefined`, signalling "not loaded yet" — they
 * still render as expandable, and the first toggle triggers a fetch.
 *
 * `parentPath` is "" for the project root; for everything else it's the
 * forward-slash-joined relative path of the parent directory.
 */
function entryToTreeNode(entry: FsListEntry, parentPath: string): FsTreeNode {
  const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.type === "dir") {
    return {
      kind: "dir",
      id: childPath,
      path: childPath,
      name: entry.name,
      ignored: entry.ignored,
      mtime: entry.mtime,
      hasChildren: entry.hasChildren ?? true,
      children: undefined,
    };
  }
  return {
    kind: "file",
    id: childPath,
    path: childPath,
    name: entry.name,
    ignored: entry.ignored,
    size: entry.size,
    mtime: entry.mtime,
  };
}

/**
 * Build the array of children to splice into a directory node, including
 * the synthetic truncation marker when the server flagged the listing as
 * over-cap. Pure: extracted from `useFsTree` so the test that exercises
 * truncation does not have to render react-arborist.
 */
export function buildChildren(
  entries: FsListEntry[],
  parentPath: string,
  truncated: boolean,
): FsTreeNode[] {
  const nodes = entries.map((e) => entryToTreeNode(e, parentPath));
  if (truncated) {
    nodes.push({
      kind: "truncated",
      id: truncatedId(parentPath),
      path: parentPath,
      name: "+ more entries (truncated)",
    });
  }
  return nodes;
}

export interface UseFsTreeOptions {
  /**
   * When `false`, every entry whose server payload had `ignored:true`
   * is filtered OUT of the data array before react-arborist sees it —
   * the operator sees a clean tree as if the ignored paths did not
   * exist. When `true` (default), ignored entries are kept and
   * {@link TreeNode} dims them via `opacity-50`.
   *
   * The filter is purely a data transformation: it never touches
   * fetched payloads (those stay cached as-is in React Query) and the
   * lazy-load dedupe key is unchanged. Toggling the flag at runtime
   * is therefore O(N) over the already-loaded children — no extra
   * network requests.
   */
  showIgnored?: boolean;
}

/**
 * Lazy-loading bridge between react-arborist and `GET /projects/:id/fs/list`.
 *
 * Strategy:
 *   1. On mount, kick off the root listing (path=""). The Tree shows an
 *      empty state until `rootData` populates.
 *   2. Track every loaded path in `loadedRef` so a second toggle on a
 *      directory does NOT refetch — react-arborist preserves open state
 *      across re-renders by id, but it does not deduplicate `onToggle`
 *      events for "already loaded" folders, so we have to.
 *   3. The tree itself is rebuilt from a flat `Map<path, children>` cache
 *      via `assembleTree`. Memoised against the cache reference, so the
 *      rebuild is O(N) only when a load resolves.
 *
 * Why not give react-arborist the children inline via `useQuery` per
 * folder? Two reasons:
 *   - `useQuery` cannot be called conditionally inside a tree walk (rules
 *     of hooks), so we'd need a second tier of components. The state-ful
 *     parent is simpler.
 *   - We want to prefill the React Query cache for `useFsList` siblings
 *     (e.g. the file-tree-driven editor in slice 02) without a second
 *     network round-trip. `qc.setQueryData` after a fetch handles that.
 */
export function useFsTree(
  projectId: string,
  options: UseFsTreeOptions = {},
): UseFsTreeResult {
  const { showIgnored = true } = options;
  const qc = useQueryClient();

  // Flat cache keyed by the relative path of the *parent* directory. The
  // empty string is the project root. Storing it flat rather than nested
  // keeps state updates O(1) — we don't have to walk a recursive tree to
  // splice in children.
  const [childrenByPath, setChildrenByPath] = useState<
    Record<string, FsTreeNode[]>
  >({});
  const [isLoadingRoot, setIsLoadingRoot] = useState(true);
  const [rootError, setRootError] = useState<FsListErrorCode | null>(null);

  const loadChildren = useCallback(
    async (path: string): Promise<FsListResponse> => {
      // `fetchQuery` deduplicates concurrent calls and primes the cache,
      // so a sibling `useFsList(projectId, path)` mounted later renders
      // synchronously off the cached payload.
      const res = await qc.fetchQuery<FsListResponse>({
        queryKey: fsListQueryKey(projectId, path),
        queryFn: () => fetchFsList(projectId, path),
      });

      if (res.ok) {
        const nodes = buildChildren(res.entries, path, res.truncated);
        setChildrenByPath((prev) => ({ ...prev, [path]: nodes }));
      } else if (path === "") {
        setRootError(res.error_code);
      }
      return res;
    },
    [projectId, qc],
  );

  // Kick off the root listing exactly once per `projectId`. The
  // `setIsLoadingRoot` toggles cover the unmount case so we don't write to
  // stale state when the component dismounts mid-fetch.
  useEffect(() => {
    let cancelled = false;
    setIsLoadingRoot(true);
    setRootError(null);
    setChildrenByPath({});
    void loadChildren("").finally(() => {
      if (!cancelled) setIsLoadingRoot(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, loadChildren]);

  /**
   * Recursively splice the loaded children into the static tree shape.
   * For an unloaded directory we keep `children: []` so react-arborist
   * still treats the row as a folder and surfaces the chevron — the next
   * toggle triggers a fetch through `onToggle`. (Setting `children:
   * undefined` would make it render as a leaf, which is wrong.)
   */
  const rootData = useMemo(() => {
    const assemble = (path: string): FsTreeNode[] => {
      const list = childrenByPath[path];
      if (!list) return [];
      // Filter ignored entries OUT of the data array when the operator
      // has hidden them. The truncation marker carries no `ignored`
      // flag (its discriminant is "truncated") so it always passes
      // through. Filtering at the assemble step — rather than mutating
      // the cache — keeps a runtime toggle cheap (O(N) memo
      // recomputation) and means flipping the flag back to `true`
      // restores the previously-hidden rows without a refetch.
      const filtered = showIgnored
        ? list
        : list.filter(
            (node) => node.kind === "truncated" || !node.ignored,
          );
      return filtered.map((node) => {
        if (node.kind !== "dir") return node;
        const loaded = childrenByPath[node.path];
        // Loaded → splice children. Not yet loaded but `hasChildren` is
        // true → empty array so react-arborist still renders the chevron
        // and fires `onToggle` to trigger the lazy load. Empty directory
        // → empty array, same shape, no fetch on toggle (loadChildren
        // dedupes by `childrenByPath[id] !== undefined`).
        return {
          ...node,
          children: loaded ? assemble(node.path) : [],
        };
      });
    };
    return assemble("");
  }, [childrenByPath, showIgnored]);

  const onToggle = useCallback(
    (id: string) => {
      // The truncation marker is non-toggleable — guard against synthetic
      // ids leaking back through react-arborist's keyboard handling.
      if (id.endsWith("/__truncated__")) return;
      // Already loaded: a second toggle just collapses/expands the cached
      // children, which react-arborist does internally.
      if (childrenByPath[id] !== undefined) return;
      void loadChildren(id);
    },
    [childrenByPath, loadChildren],
  );

  return { rootData, onToggle, isLoadingRoot, rootError, loadChildren };
}
