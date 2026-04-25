import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useProjectTree } from "@/lib/hooks";
import type { MilestoneTree, PlanSliceTree } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDown,
  ChevronRight,
  Target,
  Layers,
  Plus,
  CheckCircle2,
} from "lucide-react";

/**
 * Compact aria-tree rendering of a project's milestones + slices for the left
 * slot of the mission-control `ProjectDetailBoardView`.
 *
 * Design notes:
 *
 * - Reuses `useProjectTree(projectId)` so mounting this panel alongside the
 *   existing tree view does NOT fan out a second request — both consumers
 *   share the same React-Query cache entry.
 * - Expand/collapse state is intentionally local (a `Set<string>` of
 *   milestone ids). The wider page has its own expansion state for the tree
 *   view; isolating this one means closing a milestone in the left rail does
 *   not collapse the same row in the classic tree. Milestone-level only —
 *   slices are leaves here (tasks live in the center pane).
 * - Aria semantics: container `role="tree"`, every node `role="treeitem"`
 *   with `aria-level`, `aria-expanded` on milestone parents only, and
 *   `aria-selected` on the currently active (focused / selected) node.
 * - Keyboard navigation follows the WAI-ARIA tree pattern with a roving
 *   `tabIndex`. Exactly one node is `tabIndex=0`; the rest are `tabIndex=-1`.
 *   We do NOT use `aria-activedescendant` — focus is moved onto the real
 *   `<li>` element so screen readers + browser focus stay in sync.
 *
 *   Key map:
 *     ArrowDown  — next visible node
 *     ArrowUp    — previous visible node
 *     ArrowRight — if collapsed parent w/ children: expand;
 *                  if expanded parent: move to first child;
 *                  on a leaf: no-op
 *     ArrowLeft  — if expanded parent: collapse;
 *                  on a slice: move to the parent milestone
 *     Enter      — on a slice: call onSelectSlice (opens the slice in the
 *                  right rail);
 *                  on a milestone: call onSelectMilestone and, if collapsed
 *                  with children, also expand
 *
 *   Corner cases:
 *     - No wrap at top/bottom (WAI-ARIA recommends non-wrapping trees).
 *     - When an ArrowKey is pressed without any prior focus, the handler
 *       falls to the first visible node.
 *     - 30+ milestones: the container is `overflow-y-auto` and we call
 *       `scrollIntoView({ block: "nearest" })` on focus to keep the active
 *       row in view while scrolling.
 * - Selection highlighting accepts `selectedMilestoneId` /
 *   `selectedSliceId` as plain props. If either is set, the matching node
 *   becomes the initial active (tabindex=0, aria-selected=true) target so
 *   a deep-linked URL lands the focus ring on the right row.
 * - Empty state surfaces a CTA-shaped button when `onGeneratePlan` is
 *   provided so the rail is useful on a brand-new project instead of an
 *   inert "no milestones" label. If the parent does not want to offer a
 *   CTA here it can omit the handler and a muted hint renders instead.
 */

export interface ProjectTreePanelProps {
  /** Project whose planning tree to render. */
  projectId: string;
  /** Highlight this milestone (set `aria-selected` + visual ring). */
  selectedMilestoneId?: string;
  /** Highlight this slice. Implies the parent milestone is expanded. */
  selectedSliceId?: string;
  /** Click handler for a milestone row. Task 02 wires selection through. */
  onSelectMilestone?: (milestoneId: string) => void;
  /** Click handler for a slice row. Task 02 wires selection through. */
  onSelectSlice?: (milestoneId: string, sliceId: string) => void;
  /**
   * Click handler for the empty-state CTA. If omitted, the empty state
   * renders as a plain muted hint (no button).
   */
  onGeneratePlan?: () => void;
  /** Optional extra classes merged onto the outer container. */
  className?: string;
}

// --- Flat-node model --------------------------------------------------------

type FlatNode =
  | {
      kind: "milestone";
      id: string;
      hasChildren: boolean;
      expanded: boolean;
    }
  | {
      kind: "slice";
      id: string;
      milestoneId: string;
    };

// --- Slice leaf -------------------------------------------------------------

interface SliceNodeProps {
  slice: PlanSliceTree;
  milestoneId: string;
  /** True iff this row is the roving-tabindex target. */
  active: boolean;
  /** Forwarded click handler. */
  onSelect?: (milestoneId: string, sliceId: string) => void;
  /** Register the `<li>` DOM ref with the parent so keyboard nav can focus it. */
  registerRef: (id: string, el: HTMLLIElement | null) => void;
  /** Sync the parent's focus state when the row receives browser focus. */
  onFocusNode: (id: string) => void;
}

function SliceNode({
  slice,
  milestoneId,
  active,
  onSelect,
  registerRef,
  onFocusNode,
}: SliceNodeProps) {
  return (
    <li
      ref={(el) => registerRef(slice.id, el)}
      role="treeitem"
      aria-level={2}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid={`tree-slice-${slice.id}`}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs outline-none",
        "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent text-accent-foreground ring-1 ring-ring",
      )}
      onClick={() => {
        onFocusNode(slice.id);
        onSelect?.(milestoneId, slice.id);
      }}
      onFocus={() => onFocusNode(slice.id)}
    >
      {slice.status === "completed" ? (
        <CheckCircle2
          className="h-3 w-3 shrink-0 text-green-600 dark:text-green-500"
          aria-label="Completed"
          data-testid={`tree-slice-${slice.id}-completed`}
        />
      ) : (
        <Layers className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate">{slice.title}</span>
    </li>
  );
}

// --- Milestone parent -------------------------------------------------------

interface MilestoneNodeProps {
  milestone: MilestoneTree;
  expanded: boolean;
  /** True iff this milestone row is the roving-tabindex target. */
  active: boolean;
  /** Id of the currently-active node (used to resolve child activity). */
  activeId: string | undefined;
  onToggle: (milestoneId: string) => void;
  onSelectMilestone?: (milestoneId: string) => void;
  onSelectSlice?: (milestoneId: string, sliceId: string) => void;
  registerRef: (id: string, el: HTMLLIElement | null) => void;
  onFocusNode: (id: string) => void;
}

function MilestoneNode({
  milestone,
  expanded,
  active,
  activeId,
  onToggle,
  onSelectMilestone,
  onSelectSlice,
  registerRef,
  onFocusNode,
}: MilestoneNodeProps) {
  const hasSlices = milestone.slices.length > 0;

  return (
    <li
      ref={(el) => registerRef(milestone.id, el)}
      role="treeitem"
      aria-level={1}
      aria-expanded={hasSlices ? expanded : undefined}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid={`tree-milestone-${milestone.id}`}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onFocus={(e) => {
        // Only fire for focus landing on the <li> itself, not bubbling from
        // a child treeitem (which manages its own focusedId).
        if (e.target === e.currentTarget) onFocusNode(milestone.id);
      }}
    >
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-sm",
          "hover:bg-muted/60",
          active && "bg-accent text-accent-foreground ring-1 ring-ring",
        )}
        onClick={() => {
          onFocusNode(milestone.id);
          onSelectMilestone?.(milestone.id);
        }}
      >
        <button
          type="button"
          // Stops the row click from firing twice. Keyboard expansion is
          // handled at the tree level (ArrowRight / ArrowLeft) — this is the
          // mouse-only affordance for the chevron.
          onClick={(e) => {
            e.stopPropagation();
            onToggle(milestone.id);
          }}
          aria-label={expanded ? "Collapse milestone" : "Expand milestone"}
          aria-hidden={!hasSlices}
          tabIndex={-1}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground",
            !hasSlices && "invisible",
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
        {milestone.status === "completed" ? (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500"
            aria-label="Completed"
            data-testid={`tree-milestone-${milestone.id}-completed`}
          />
        ) : (
          <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="truncate font-medium">{milestone.title}</span>
      </div>
      {expanded && hasSlices && (
        <ul role="group" className="ml-5 mt-0.5 space-y-0.5">
          {milestone.slices.map((slice) => (
            <SliceNode
              key={slice.id}
              slice={slice}
              milestoneId={milestone.id}
              active={activeId === slice.id}
              onSelect={onSelectSlice}
              registerRef={registerRef}
              onFocusNode={onFocusNode}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// --- Panel ------------------------------------------------------------------

export function ProjectTreePanel({
  projectId,
  selectedMilestoneId,
  selectedSliceId,
  onSelectMilestone,
  onSelectSlice,
  onGeneratePlan,
  className,
}: ProjectTreePanelProps) {
  const { data: tree, isLoading, error } = useProjectTree(projectId);

  // Milestone that owns the currently-selected slice. We auto-expand it on
  // mount so a deep-linked URL lands with the highlight visible — BUT we
  // only seed the expanded set, we do NOT keep it expanded forever. That
  // way ArrowLeft on the milestone (or on the slice, then again) actually
  // collapses it like any other node.
  const selectedSliceParentId = useMemo(() => {
    if (!selectedSliceId || !tree) return undefined;
    for (const m of tree.milestones) {
      if (m.slices.some((s) => s.id === selectedSliceId)) return m.id;
    }
    return undefined;
  }, [selectedSliceId, tree]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | undefined>();
  const nodeRefs = useRef(new Map<string, HTMLLIElement | null>());

  // Seed the expanded set when the selected-slice parent changes. This
  // runs once per (projectId / selectedSliceId) combo; user toggles after
  // that win — collapsing no longer springs back open on every render.
  useEffect(() => {
    if (!selectedSliceParentId) return;
    setExpanded((prev) => {
      if (prev.has(selectedSliceParentId)) return prev;
      const next = new Set(prev);
      next.add(selectedSliceParentId);
      return next;
    });
  }, [selectedSliceParentId]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isExpanded = useCallback(
    (id: string) => expanded.has(id),
    [expanded],
  );

  const milestones = tree?.milestones ?? [];

  // Flat ordered list of visible nodes. This is the single source of truth
  // for keyboard navigation ("next visible" / "previous visible").
  const flatNodes = useMemo<FlatNode[]>(() => {
    const out: FlatNode[] = [];
    for (const m of milestones) {
      out.push({
        kind: "milestone",
        id: m.id,
        hasChildren: m.slices.length > 0,
        expanded: isExpanded(m.id),
      });
      if (isExpanded(m.id)) {
        for (const s of m.slices) {
          out.push({ kind: "slice", id: s.id, milestoneId: m.id });
        }
      }
    }
    return out;
  }, [milestones, isExpanded]);

  // activeId is the node that owns the roving tabindex AND aria-selected.
  // Order of preference: user-moved keyboard focus > selected slice prop >
  // selected milestone prop > first visible node.
  const activeId = useMemo<string | undefined>(() => {
    if (focusedId && flatNodes.some((n) => n.id === focusedId)) {
      return focusedId;
    }
    if (selectedSliceId && flatNodes.some((n) => n.id === selectedSliceId)) {
      return selectedSliceId;
    }
    if (
      selectedMilestoneId &&
      flatNodes.some((n) => n.id === selectedMilestoneId)
    ) {
      return selectedMilestoneId;
    }
    return flatNodes[0]?.id;
  }, [focusedId, selectedSliceId, selectedMilestoneId, flatNodes]);

  const registerRef = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  // When the user navigates with the keyboard (focusedId changes), move the
  // real browser focus to the matching <li> and scroll it into view. We skip
  // the effect when focusedId is undefined so mounting the panel does NOT
  // auto-steal focus from whatever had it.
  useEffect(() => {
    if (!focusedId) return;
    const el = nodeRefs.current.get(focusedId);
    if (!el) return;
    if (document.activeElement !== el) {
      el.focus();
    }
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "nearest" });
      } catch {
        /* jsdom / older browsers: scrollIntoView may not accept options */
      }
    }
  }, [focusedId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (flatNodes.length === 0) return;

      // idx === -1 means no prior focus — ArrowKeys fall to the first node.
      const idx = focusedId
        ? flatNodes.findIndex((n) => n.id === focusedId)
        : -1;
      const node = idx >= 0 ? flatNodes[idx] : undefined;

      const first = flatNodes[0];
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          if (idx < 0) {
            if (first) setFocusedId(first.id);
          } else if (idx < flatNodes.length - 1) {
            const nxt = flatNodes[idx + 1];
            if (nxt) setFocusedId(nxt.id);
          }
          return;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (idx < 0) {
            if (first) setFocusedId(first.id);
          } else if (idx > 0) {
            const prev = flatNodes[idx - 1];
            if (prev) setFocusedId(prev.id);
          }
          return;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (!node) {
            if (first) setFocusedId(first.id);
            return;
          }
          if (node.kind === "milestone" && node.hasChildren) {
            if (!node.expanded) {
              toggle(node.id);
            } else {
              // Move into the first child slice, which is at idx + 1 in the
              // flat list because slices follow their milestone in order.
              const child = flatNodes[idx + 1];
              if (child) setFocusedId(child.id);
            }
          }
          return;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (!node) {
            if (first) setFocusedId(first.id);
            return;
          }
          if (node.kind === "milestone") {
            if (node.expanded) toggle(node.id);
          } else {
            // Slice → jump up to its parent milestone.
            setFocusedId(node.milestoneId);
          }
          return;
        }
        case "Enter": {
          e.preventDefault();
          if (!node) {
            if (first) setFocusedId(first.id);
            return;
          }
          if (node.kind === "slice") {
            onSelectSlice?.(node.milestoneId, node.id);
          } else {
            onSelectMilestone?.(node.id);
            if (node.hasChildren && !node.expanded) toggle(node.id);
          }
          return;
        }
        default:
          return;
      }
    },
    [flatNodes, focusedId, onSelectMilestone, onSelectSlice, toggle],
  );

  if (isLoading && !tree) {
    return (
      <div
        className={cn("h-full space-y-2 overflow-hidden p-2", className)}
        data-testid="project-tree-panel-loading"
      >
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center p-4 text-sm text-destructive",
          className,
        )}
        data-testid="project-tree-panel-error"
      >
        Failed to load planning tree.
      </div>
    );
  }

  if (milestones.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 p-4 text-center",
          className,
        )}
        data-testid="project-tree-panel-empty"
      >
        <p className="text-sm font-medium text-muted-foreground">
          No milestones yet
        </p>
        <p className="text-xs text-muted-foreground/80">
          Generate a plan or add a milestone to get started.
        </p>
        {onGeneratePlan && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1"
            onClick={onGeneratePlan}
          >
            <Plus className="mr-1 h-4 w-4" />
            Generate Plan
          </Button>
        )}
      </div>
    );
  }

  return (
    <nav
      aria-label="Project planning tree"
      data-testid="project-tree-panel"
      className={cn("h-full overflow-y-auto p-2", className)}
    >
      <ul role="tree" className="space-y-0.5" onKeyDown={handleKeyDown}>
        {milestones.map((milestone) => (
          <MilestoneNode
            key={milestone.id}
            milestone={milestone}
            expanded={isExpanded(milestone.id)}
            active={activeId === milestone.id}
            activeId={activeId}
            onToggle={toggle}
            onSelectMilestone={onSelectMilestone}
            onSelectSlice={onSelectSlice}
            registerRef={registerRef}
            onFocusNode={setFocusedId}
          />
        ))}
      </ul>
    </nav>
  );
}

export default ProjectTreePanel;
