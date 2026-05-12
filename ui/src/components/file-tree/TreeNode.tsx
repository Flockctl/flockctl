import { memo, useContext } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { NodeRendererProps } from "react-arborist";

import { cn } from "@/lib/utils";
import { useFileHighlight } from "@/lib/handlers/fs-changed";
import type { GitTreeStatus } from "@/lib/hooks/git-status-tree";

import { fileIcon } from "./file-icon";
import { GitStatusTreeContext } from "./git-status-context";
import { TreeContextMenu } from "./TreeContextMenu";
import { TreeContextMenuContext } from "./tree-context-menu-context";
import type { FsTreeNode } from "./use-fs-tree";

/**
 * Tailwind class bundle for the per-row git-status badge. Each bucket
 * picks a single tint that aligns with the rest of the SCM rail:
 *
 *   - `M`  → amber  (modified — also matches the fs-touched flash so
 *                    the two highlights are visually adjacent).
 *   - `A`  → green  (added / staged).
 *   - `D`  → red, with strike-through copy on the row name itself
 *                    (the badge is rendered after the name, but the
 *                    strike treatment is applied via a sibling class
 *                    on the name span — see the JSX below).
 *   - `??` → grey   (untracked — same neutral as the muted-foreground
 *                    text colour so untracked rows recede).
 *   - `U`  → red    (unmerged / conflict — distinct from `D` because
 *                    the operator must resolve before any commit).
 *
 * The badge itself renders the literal status code so colour-blind
 * operators can still distinguish buckets by glyph.
 */
const STATUS_BADGE_CLASS: Record<GitTreeStatus, string> = {
  M: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  A: "bg-green-500/20 text-green-700 dark:text-green-300",
  D: "bg-red-500/20 text-red-700 dark:text-red-300",
  U: "bg-red-500/30 text-red-800 dark:text-red-200",
  "??": "bg-muted text-muted-foreground",
};

/**
 * Single row inside the file tree. react-arborist hands us a `NodeApi`
 * whose `data` is one of our `FsTreeNode` discriminants. We branch on
 * `kind` rather than checking `node.isLeaf` so the truncation marker
 * (which is technically a leaf) gets its own non-clickable styling
 * without leaking the kind through React props.
 *
 * Test-id contract:
 *   - `file-tree-row`             on every rendered row.
 *   - `file-tree-row-{path}`      stable per node — used by the e2e
 *                                 spec to click a specific entry.
 *   - `file-tree-truncated-{path}` on the synthetic "+ more" marker.
 */
function TreeNodeImpl({
  node,
  style,
  dragHandle,
}: NodeRendererProps<FsTreeNode>) {
  const data = node.data;

  // Hooks first — the truncation marker early-returns below, so the
  // highlight subscription has to land before any conditional return
  // (rules-of-hooks). The hook tolerates a path on a truncation marker
  // because that path will simply never be in the highlight store.
  const pathHighlighted = useFileHighlight(data.path);
  // Git status map is populated by `useGitStatusForTree` at the
  // FileTree root; the row pulls the per-path bucket via context so
  // the row stays a leaf in the render tree (react-arborist passes
  // only `node`/`style`/`dragHandle` — no extra props).
  const gitStatusMap = useContext(GitStatusTreeContext);
  const gitStatus = gitStatusMap.get(data.path);
  // Same context-via-react reasoning for the right-click menu's
  // wiring: react-arborist owns the row's prop surface, so we read the
  // mutation callbacks (and the project-root absolute path) from a
  // separate context the FileTree provider sets up.
  const ctxMenu = useContext(TreeContextMenuContext);

  // The truncation marker is purely informational — no chevron, no icon,
  // no keyboard activation. Keep it inside the same row container so the
  // virtualised height calculation stays accurate.
  if (data.kind === "truncated") {
    return (
      <div
        ref={dragHandle}
        style={style}
        data-testid={`file-tree-truncated-${data.path}`}
        className="flex h-full items-center pl-6 pr-2 text-xs italic text-muted-foreground"
      >
        {data.name}
      </div>
    );
  }

  // Indent purely from `node.level`; react-arborist measures the row
  // height from `rowHeight` so we keep the inner padding fixed and rely
  // on a left margin for the visual hierarchy.
  const isDir = data.kind === "dir";
  const isOpen = node.isOpen;
  const isSelected = node.isSelected;
  // We only flash leaves — flashing a directory because a child changed
  // would be visually noisy and the child row is already lit. The
  // hook above runs unconditionally; we just suppress the visual.
  const isHighlighted = pathHighlighted && !isDir;

  // Compose the absolute path on demand. POSIX-join of project root +
  // relative path; the menu uses this for Copy Path / Reveal. When the
  // context provider didn't ship a root (the read-only embedding case)
  // we leave it undefined and the menu falls back gracefully.
  const absolutePath =
    ctxMenu?.projectRoot != null
      ? `${ctxMenu.projectRoot.replace(/\/+$/, "")}/${data.path}`
      : undefined;

  // Wrap the row in the context menu when callbacks are wired, leave
  // the row bare otherwise (test fixtures, read-only embeddings). Done
  // here rather than at the parent because react-arborist owns the
  // immediate child of `<Tree>` — wrapping at the consumer level would
  // break the virtualiser's height measurement.
  const rowEl = (
    <div
      ref={dragHandle}
      style={style}
      data-testid={`file-tree-row-${data.path}`}
      data-kind={data.kind}
      data-ignored={data.ignored ? "true" : "false"}
      data-selected={isSelected ? "true" : "false"}
      data-highlighted={isHighlighted ? "true" : "false"}
      data-git-status={gitStatus ?? ""}
      onClick={() => {
        // Folders toggle open/closed; files activate (handled by Tree's
        // `onActivate`). The branch matters because react-arborist's
        // default click semantics pick depending on whether the row is
        // a leaf — we are explicit so the behaviour is predictable when
        // `onActivate` is not wired.
        if (isDir) {
          node.toggle();
        } else {
          node.activate();
        }
      }}
      className={cn(
        // M23 / T06 — file tree restyle: rows mirror the Monaco
        // `editor-line` rhythm (22px line-height, see index.css). The
        // tree's `rowHeight` is fixed at 22 to match, so each row maps
        // 1:1 onto a Monaco line. Small 13px copy keeps parity with
        // Monaco's `fontSize: 13`. Default text colour is zinc-700/300
        // so untouched rows recede behind the active surface; the
        // hover/selected branches bump it up to the indigo-tinted
        // accent palette.
        "flex h-full cursor-pointer select-none items-center gap-1 pr-2",
        "text-[13px] leading-[22px] text-zinc-700 dark:text-zinc-300",
        "hover:bg-indigo-500/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        // Transient flash — amber tint to distinguish from the steady
        // selection background. `transition-colors` makes the fade out
        // (when the entry expires) feel intentional rather than abrupt.
        "transition-colors",
        isHighlighted && "bg-amber-500/20",
        isSelected &&
          "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-medium",
        // Gitignore dimming. The row only ever renders for an ignored
        // entry when the parent has `showIgnored=true` (the `useFsTree`
        // adapter filters ignored entries OUT of the data array
        // otherwise — see its `showIgnored` parameter), so a single
        // `opacity-50` class here is the visual contract for "shown but
        // dimmed". Picking 50 over 60 lands on the same fade ramp the
        // rest of the UI uses for muted/disabled states.
        data.ignored && "opacity-50",
      )}
    >
      {/* Chevron column — fixed width so files line up with folder names. */}
      <span className="flex w-4 items-center justify-center text-muted-foreground">
        {isDir ? (
          isOpen ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : null}
      </span>
      {/* Icon column — folder vs extension-aware file icon. Folders use
          Folder/FolderOpen and stay muted so they recede behind the
          name text; files pull their (icon, colour) pair from
          {@link fileIcon}, falling back to a neutral `File` glyph when
          the extension is unknown. Keep the wrapper width fixed so
          rows align regardless of which icon ends up rendered. */}
      {isDir ? (
        <span className="flex w-4 items-center justify-center text-muted-foreground">
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Folder className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
      ) : (
        (() => {
          const { icon: Icon, colorClass } = fileIcon(data.name);
          return (
            <span
              className={cn(
                "flex w-4 items-center justify-center",
                colorClass,
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          );
        })()
      )}
      <span
        className={cn(
          "truncate",
          // `D` (deleted) and the conflict bucket both strike the
          // name through. `D` is the obvious case; `U` follows the
          // same convention because porcelain's `DD` (both deleted)
          // collapses to `U` and the visual cue is identical.
          (gitStatus === "D" || gitStatus === "U") && "line-through",
        )}
      >
        {data.name}
      </span>
      {/* Status badge — empty when the path is clean / unknown so the
          row layout stays unchanged for the dominant case. The badge
          carries its own data-testid keyed by path so e2e specs can
          select it without a structural query. */}
      {gitStatus && (
        <span
          data-testid={`file-tree-status-${data.path}`}
          data-status={gitStatus}
          className={cn(
            "ml-auto rounded px-1 text-[10px] font-medium leading-4",
            STATUS_BADGE_CLASS[gitStatus],
          )}
        >
          {gitStatus}
        </span>
      )}
    </div>
  );

  if (!ctxMenu) return rowEl;

  return (
    <TreeContextMenu
      kind={data.kind}
      path={data.path}
      absolutePath={absolutePath}
      onNewFile={ctxMenu.onNewFile}
      onNewFolder={ctxMenu.onNewFolder}
      onRename={ctxMenu.onRename}
      onDelete={ctxMenu.onDelete}
    >
      {rowEl}
    </TreeContextMenu>
  );
}

/**
 * Memoised (audit-round-5). react-arborist re-renders every visible
 * node on each tree update; wrapping in `React.memo` lets unchanged
 * nodes skip render when only sibling state (highlight / git status)
 * changes. The render closure pulls dynamic state from `useContext`
 * and `useFileHighlight`, both of which already trigger re-renders
 * via their own subscription mechanics — so memoising the outer call
 * is safe and the inner updates still propagate.
 */
export const TreeNode = memo(TreeNodeImpl);
