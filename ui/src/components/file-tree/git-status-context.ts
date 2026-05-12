import { createContext } from "react";

import type { GitTreeStatus } from "@/lib/hooks/git-status-tree";

/**
 * Per-tree status map injected by {@link FileTree} and consumed by
 * {@link TreeNode} so the row renderer can look up its path in O(1)
 * without re-calling the polled query for every node.
 *
 * Defaults to an empty map so the tree renders unchanged when wrapped
 * outside of a `FileTree` (e.g. unit tests for `TreeNode` in isolation).
 *
 * Why a context rather than a prop on `TreeNode`? react-arborist passes
 * `TreeNode` as the `children` render prop to `<Tree>` and only forwards
 * `node`, `style`, and `dragHandle`. Threading anything else through
 * means either patching the library or pulling from a parent-controlled
 * scope — context is the cleanest path.
 */
export const GitStatusTreeContext = createContext<Map<string, GitTreeStatus>>(
  new Map(),
);
