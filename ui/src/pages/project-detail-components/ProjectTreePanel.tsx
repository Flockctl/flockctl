import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useProjectTree, useMissions, type Mission } from "@/lib/hooks";
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
  Compass,
} from "lucide-react";

/**
 * Compact aria-tree rendering of a project's missions + milestones + slices
 * for the left slot of the mission-control `ProjectDetailBoardView`.
 *
 * Hierarchy (slice 11/04 — "mission level above milestones"):
 *
 *   mission (level 1)            ← from `useMissions(projectId)`
 *     milestone (level 2)        ← `MilestoneTree` rows whose `mission_id`
 *                                  matches the parent mission's id
 *       slice (level 3)
 *
 *   milestone (level 1, orphan)  ← `MilestoneTree` rows with no mission_id
 *     slice (level 2)              OR with a mission_id pointing at a row
 *                                  that does not exist in the missions
 *                                  list (dangling-mission tolerance).
 *
 * The flat-node nav model + roving tabindex pattern from the milestone-only
 * version is preserved — the mission row simply joins as a new node kind.
 *
 * Design notes:
 *
 * - Reuses `useProjectTree(projectId)` AND `useMissions(projectId)`, both
 *   keyed by projectId so mounting this panel alongside the existing tree
 *   view does NOT fan out duplicate requests — every consumer shares the
 *   same React-Query cache entry.
 * - When `useMissions` errors or returns an empty list, the panel falls
 *   back to the flat milestones-at-root rendering — there is no "missions
 *   not loaded" UI state. A no-missions project is visually identical to
 *   the pre-mission rendering.
 * - Expand/collapse state is intentionally local (a `Set<string>` of node
 *   ids — both mission and milestone ids share the same set since the id
 *   spaces don't collide). Default expansion: every mission is expanded
 *   on mount so a five-mission project lays out side-by-side without the
 *   user clicking to reveal the milestones underneath.
 * - Aria semantics: container `role="tree"`, every node `role="treeitem"`
 *   with `aria-level`, `aria-expanded` on parents only, and
 *   `aria-selected` on the currently active (focused / selected) node.
 * - Keyboard navigation follows the WAI-ARIA tree pattern with a roving
 *   `tabIndex`. Exactly one node is `tabIndex=0`; the rest are `tabIndex=-1`.
 *   Focus is moved onto the real `<li>` element so screen readers + browser
 *   focus stay in sync.
 *
 *   Key map (mission rows are parents, otherwise unchanged from the
 *   milestone-only version):
 *     ArrowDown  — next visible node
 *     ArrowUp    — previous visible node
 *     ArrowRight — collapsed parent w/ children: expand;
 *                  expanded parent: move to first child;
 *                  on a leaf: no-op
 *     ArrowLeft  — expanded parent: collapse;
 *                  on a child: move to its parent
 *     Enter      — leaf (slice): call onSelectSlice;
 *                  milestone: call onSelectMilestone (and expand if
 *                    collapsed with children);
 *                  mission: call onSelectMission (and expand if collapsed
 *                    with children)
 *
 *   Corner cases:
 *     - No wrap at top/bottom (WAI-ARIA recommends non-wrapping trees).
 *     - When an ArrowKey is pressed without any prior focus, the handler
 *       falls to the first visible node.
 *     - 5+ peer missions render side-by-side, each with their milestones
 *       expanded by default — slice 11/04 edge case.
 *
 * - Selection highlighting accepts `selectedMissionId` /
 *   `selectedMilestoneId` / `selectedSliceId` as plain props. If any is
 *   set, the matching node becomes the initial active (tabindex=0,
 *   aria-selected=true) target so a deep-linked URL lands the focus ring
 *   on the right row. The parent component is expected to drive these
 *   props from `useSelection` (URL-backed state).
 * - Empty state surfaces a CTA-shaped button when `onGeneratePlan` is
 *   provided so the rail is useful on a brand-new project instead of an
 *   inert "no milestones" label.
 *
 * Tolerance contracts (forward-compat, see `extension-points.test.tsx`):
 * - A milestone that carries a `mission_id` not present in the missions
 *   list is grouped at root as an orphan, not buried under a phantom
 *   parent. No broken-link visual marker is rendered (deferred — the
 *   contract is "do not crash", not "highlight").
 * - An empty-string `mission_id` is treated identically to no mission_id.
 */

export interface ProjectTreePanelProps {
  /** Project whose planning tree to render. */
  projectId: string;
  /** Highlight this mission (set `aria-selected` + visual ring). */
  selectedMissionId?: string;
  /** Highlight this milestone. */
  selectedMilestoneId?: string;
  /** Highlight this slice. Implies the parent milestone is expanded. */
  selectedSliceId?: string;
  /**
   * Click handler for a mission row. The parent typically wires this to
   * `useSelection.setSelection({ ... })` so the URL writes
   * `?selectedMission=<id>` in a single history transition.
   */
  onSelectMission?: (missionId: string) => void;
  /** Click handler for a milestone row. */
  onSelectMilestone?: (milestoneId: string) => void;
  /** Click handler for a slice row. */
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
      kind: "mission";
      id: string;
      hasChildren: boolean;
      expanded: boolean;
    }
  | {
      kind: "milestone";
      id: string;
      missionId: string | null;
      hasChildren: boolean;
      expanded: boolean;
      level: 1 | 2;
    }
  | {
      kind: "slice";
      id: string;
      milestoneId: string;
      level: 2 | 3;
    };

// --- Slice leaf -------------------------------------------------------------

interface SliceNodeProps {
  slice: PlanSliceTree;
  milestoneId: string;
  level: 2 | 3;
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
  level,
  active,
  onSelect,
  registerRef,
  onFocusNode,
}: SliceNodeProps) {
  return (
    <li
      ref={(el) => registerRef(slice.id, el)}
      role="treeitem"
      aria-level={level}
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
  /** Aria-level depends on whether this milestone is nested under a mission. */
  level: 1 | 2;
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
  level,
  active,
  activeId,
  onToggle,
  onSelectMilestone,
  onSelectSlice,
  registerRef,
  onFocusNode,
}: MilestoneNodeProps) {
  const hasSlices = milestone.slices.length > 0;
  // Slices nest one level deeper than the milestone they belong to.
  const sliceLevel: 2 | 3 = level === 1 ? 2 : 3;

  return (
    <li
      ref={(el) => registerRef(milestone.id, el)}
      role="treeitem"
      aria-level={level}
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
              level={sliceLevel}
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

// --- Mission parent ---------------------------------------------------------

interface MissionNodeProps {
  mission: Mission;
  childMilestones: MilestoneTree[];
  expanded: boolean;
  active: boolean;
  activeId: string | undefined;
  isMilestoneExpanded: (milestoneId: string) => boolean;
  onToggle: (id: string) => void;
  onSelectMission?: (missionId: string) => void;
  onSelectMilestone?: (milestoneId: string) => void;
  onSelectSlice?: (milestoneId: string, sliceId: string) => void;
  registerRef: (id: string, el: HTMLLIElement | null) => void;
  onFocusNode: (id: string) => void;
}

/**
 * Mission row + its nested milestones. Visual treatment uses the `Compass`
 * lucide glyph to differentiate from the milestone `Target` glyph at a
 * glance — the two icons share the same 3.5-square footprint so the row
 * heights line up across the tree.
 *
 * Title source: `mission.objective` is the human-facing label. We do not
 * truncate aggressively here (the row uses `truncate` for overflow) so the
 * tree tooltip + screen-reader text match what the operator typed.
 */
function MissionNode({
  mission,
  childMilestones,
  expanded,
  active,
  activeId,
  isMilestoneExpanded,
  onToggle,
  onSelectMission,
  onSelectMilestone,
  onSelectSlice,
  registerRef,
  onFocusNode,
}: MissionNodeProps) {
  const hasChildren = childMilestones.length > 0;

  return (
    <li
      ref={(el) => registerRef(mission.id, el)}
      role="treeitem"
      aria-level={1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid={`tree-mission-${mission.id}`}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusNode(mission.id);
      }}
    >
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-sm",
          "hover:bg-muted/60",
          active && "bg-accent text-accent-foreground ring-1 ring-ring",
        )}
        onClick={() => {
          onFocusNode(mission.id);
          onSelectMission?.(mission.id);
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(mission.id);
          }}
          aria-label={expanded ? "Collapse mission" : "Expand mission"}
          aria-hidden={!hasChildren}
          tabIndex={-1}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground",
            !hasChildren && "invisible",
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
        <Compass
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="truncate font-medium">{mission.objective}</span>
      </div>
      {expanded && hasChildren && (
        <ul role="group" className="ml-5 mt-0.5 space-y-0.5">
          {childMilestones.map((m) => (
            <MilestoneNode
              key={m.id}
              milestone={m}
              expanded={isMilestoneExpanded(m.id)}
              level={2}
              active={activeId === m.id}
              activeId={activeId}
              onToggle={onToggle}
              onSelectMilestone={onSelectMilestone}
              onSelectSlice={onSelectSlice}
              registerRef={registerRef}
              onFocusNode={onFocusNode}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// --- Helpers ----------------------------------------------------------------

/**
 * Pull the `mission_id` field off a milestone tree row in a way that
 * tolerates older response shapes (no key) and partially-filled forms
 * (empty string). Both null/undefined/"" coerce to `null` so downstream
 * grouping treats them identically to "no mission".
 */
function readMissionId(m: MilestoneTree): string | null {
  const raw = (m as { mission_id?: string | null }).mission_id;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

// --- Panel ------------------------------------------------------------------

export function ProjectTreePanel({
  projectId,
  selectedMissionId,
  selectedMilestoneId,
  selectedSliceId,
  onSelectMission,
  onSelectMilestone,
  onSelectSlice,
  onGeneratePlan,
  className,
}: ProjectTreePanelProps) {
  const { data: tree, isLoading, error } = useProjectTree(projectId);
  // Missions come from a sibling endpoint. Errors are non-fatal — a
  // failure to load missions falls back to the flat milestones rendering
  // (see `missionsList` below). We don't surface a separate error UI here
  // because the tree is still useful without the mission grouping.
  const { data: missionsResp } = useMissions(projectId);

  const missionsList = useMemo<Mission[]>(
    () => missionsResp?.items ?? [],
    [missionsResp],
  );

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

  // Mission that owns the currently-selected milestone (so deep-linking to
  // a nested milestone reveals it). Lookup is by milestone's mission_id.
  const selectedMilestoneParentMission = useMemo(() => {
    if (!selectedMilestoneId || !tree) return undefined;
    for (const m of tree.milestones) {
      if (m.id !== selectedMilestoneId) continue;
      const mid = readMissionId(m);
      if (mid && missionsList.some((x) => x.id === mid)) return mid;
      return undefined;
    }
    return undefined;
  }, [selectedMilestoneId, tree, missionsList]);

  // Default expansion: every mission is expanded on mount. This makes a
  // 5-mission project lay out side-by-side without forcing the user to
  // click each chevron — the "5 peer missions render side-by-side"
  // edge case from the slice spec.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Track which projects we've seeded so a re-render with the same
  // missions list doesn't re-add ids the user has manually collapsed.
  const seededRef = useRef<{
    projectId: string | null;
    missionIds: string[];
  }>({ projectId: null, missionIds: [] });

  useEffect(() => {
    const ids = missionsList.map((m) => m.id);
    const prev = seededRef.current;
    const sameProject = prev.projectId === projectId;
    const sameIds =
      sameProject &&
      prev.missionIds.length === ids.length &&
      prev.missionIds.every((id, i) => id === ids[i]);
    if (sameIds) return;
    seededRef.current = { projectId, missionIds: ids };
    setExpanded((prevSet) => {
      const next = new Set(prevSet);
      for (const id of ids) next.add(id);
      return next;
    });
  }, [projectId, missionsList]);

  const [focusedId, setFocusedId] = useState<string | undefined>();
  const nodeRefs = useRef(new Map<string, HTMLLIElement | null>());

  // Seed the expanded set when the selected-slice parent changes.
  useEffect(() => {
    if (!selectedSliceParentId) return;
    setExpanded((prev) => {
      if (prev.has(selectedSliceParentId)) return prev;
      const next = new Set(prev);
      next.add(selectedSliceParentId);
      return next;
    });
  }, [selectedSliceParentId]);

  // Expand a mission whose child milestone is selected.
  useEffect(() => {
    if (!selectedMilestoneParentMission) return;
    setExpanded((prev) => {
      if (prev.has(selectedMilestoneParentMission)) return prev;
      const next = new Set(prev);
      next.add(selectedMilestoneParentMission);
      return next;
    });
  }, [selectedMilestoneParentMission]);

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

  // Group milestones by mission. Orphans (no/empty/dangling mission_id)
  // render at root.
  const { missionGroups, orphanMilestones } = useMemo(() => {
    const validMissionIds = new Set(missionsList.map((m) => m.id));
    const groups = new Map<string, MilestoneTree[]>();
    const orphans: MilestoneTree[] = [];
    for (const m of milestones) {
      const mid = readMissionId(m);
      if (mid && validMissionIds.has(mid)) {
        const list = groups.get(mid) ?? [];
        list.push(m);
        groups.set(mid, list);
      } else {
        // Includes: no mission_id, empty mission_id, dangling mission_id
        // pointing at a row not in the missions list.
        orphans.push(m);
      }
    }
    return { missionGroups: groups, orphanMilestones: orphans };
  }, [milestones, missionsList]);

  // Flat ordered list of visible nodes — single source of truth for
  // keyboard navigation. Order: missions (in the order returned by the
  // API) → orphan milestones (in the order returned by the project tree).
  const flatNodes = useMemo<FlatNode[]>(() => {
    const out: FlatNode[] = [];
    for (const mission of missionsList) {
      const children = missionGroups.get(mission.id) ?? [];
      const missionExpanded = isExpanded(mission.id);
      out.push({
        kind: "mission",
        id: mission.id,
        hasChildren: children.length > 0,
        expanded: missionExpanded,
      });
      if (missionExpanded) {
        for (const m of children) {
          const milestoneExpanded = isExpanded(m.id);
          out.push({
            kind: "milestone",
            id: m.id,
            missionId: mission.id,
            hasChildren: m.slices.length > 0,
            expanded: milestoneExpanded,
            level: 2,
          });
          if (milestoneExpanded) {
            for (const s of m.slices) {
              out.push({
                kind: "slice",
                id: s.id,
                milestoneId: m.id,
                level: 3,
              });
            }
          }
        }
      }
    }
    for (const m of orphanMilestones) {
      const milestoneExpanded = isExpanded(m.id);
      out.push({
        kind: "milestone",
        id: m.id,
        missionId: null,
        hasChildren: m.slices.length > 0,
        expanded: milestoneExpanded,
        level: 1,
      });
      if (milestoneExpanded) {
        for (const s of m.slices) {
          out.push({
            kind: "slice",
            id: s.id,
            milestoneId: m.id,
            level: 2,
          });
        }
      }
    }
    return out;
  }, [missionsList, missionGroups, orphanMilestones, isExpanded]);

  // activeId is the node that owns the roving tabindex AND aria-selected.
  // Order of preference: user-moved keyboard focus > selected slice prop >
  // selected milestone prop > selected mission prop > first visible node.
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
    if (
      selectedMissionId &&
      flatNodes.some((n) => n.id === selectedMissionId)
    ) {
      return selectedMissionId;
    }
    return flatNodes[0]?.id;
  }, [
    focusedId,
    selectedSliceId,
    selectedMilestoneId,
    selectedMissionId,
    flatNodes,
  ]);

  const registerRef = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  // When the user navigates with the keyboard (focusedId changes), move the
  // real browser focus to the matching <li> and scroll it into view.
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
          if (
            (node.kind === "milestone" || node.kind === "mission") &&
            node.hasChildren
          ) {
            if (!node.expanded) {
              toggle(node.id);
            } else {
              // Move into the first child, which is at idx + 1 in the flat
              // list because children follow their parent in order.
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
          if (node.kind === "mission") {
            if (node.expanded) toggle(node.id);
          } else if (node.kind === "milestone") {
            if (node.expanded) toggle(node.id);
            else if (node.missionId) {
              setFocusedId(node.missionId);
            }
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
          } else if (node.kind === "milestone") {
            onSelectMilestone?.(node.id);
            if (node.hasChildren && !node.expanded) toggle(node.id);
          } else {
            onSelectMission?.(node.id);
            if (node.hasChildren && !node.expanded) toggle(node.id);
          }
          return;
        }
        default:
          return;
      }
    },
    [
      flatNodes,
      focusedId,
      onSelectMission,
      onSelectMilestone,
      onSelectSlice,
      toggle,
    ],
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

  if (milestones.length === 0 && missionsList.length === 0) {
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
        {missionsList.map((mission) => (
          <MissionNode
            key={mission.id}
            mission={mission}
            childMilestones={missionGroups.get(mission.id) ?? []}
            expanded={isExpanded(mission.id)}
            active={activeId === mission.id}
            activeId={activeId}
            isMilestoneExpanded={isExpanded}
            onToggle={toggle}
            onSelectMission={onSelectMission}
            onSelectMilestone={onSelectMilestone}
            onSelectSlice={onSelectSlice}
            registerRef={registerRef}
            onFocusNode={setFocusedId}
          />
        ))}
        {orphanMilestones.map((milestone) => (
          <MilestoneNode
            key={milestone.id}
            milestone={milestone}
            expanded={isExpanded(milestone.id)}
            level={1}
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
