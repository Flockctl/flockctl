import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/lib/use-view-mode";
import { MissionControlKpiBar } from "./MissionControlKpiBar";
import { SliceBoard } from "./SliceBoard";
import { DEFAULT_SLICE_COLUMNS } from "./slice-board-types";
import { useProjectTree } from "@/lib/hooks";
import { useSelection } from "@/lib/use-selection";
import { Skeleton } from "@/components/ui/skeleton";
import type { PlanSliceTree } from "@/lib/types/plan";
import { ProjectTreePanel } from "./ProjectTreePanel";
import { SliceDetailTabs, DEFAULT_SLICE_TABS } from "./SliceDetailTabs";
import { MilestoneDetailPanel } from "./MilestoneDetailPanel";

/**
 * 3-column shell for the mission-control project-detail layout.
 *
 * This component is intentionally dumb: it lays out a CSS grid with three
 * named slots (`left`, `center`, `right`) and nothing else. Data fetching,
 * expand/collapse state, milestone rendering, and the chat pane all land in
 * later slices of milestone 09 — each slice wires its panel into one of the
 * slots.
 *
 * Design notes:
 *
 * - Fixed 260px left rail, fluid center, fixed 360px right pane. The numbers
 *   match the prototype in `docs/prototypes/mission-control.html` so the
 *   visual regression snapshot taken from that prototype is reusable.
 * - Every slot gets `min-w-0` so a long milestone title inside the center
 *   column cannot blow past the grid track and push the right pane off
 *   screen. Overflow is clipped with `overflow-hidden`; children are
 *   expected to opt into their own scroll container.
 * - Height pins to the viewport minus the app bar via the CSS custom
 *   property `--appbar-h`. The property is declared at the layout level; if
 *   it is missing (e.g. in a storybook without the chrome) the calc
 *   gracefully falls back to `100vh` because `var()` resolves to the
 *   initial value `0` and `calc(100vh - 0)` === `100vh`.
 * - The `mode` prop lets the dispatcher reuse the same shell for the
 *   `swimlane` view — the layout is identical, only the default center stub
 *   changes to advertise "coming soon" so we do not need a second skeleton.
 * - A zero-milestone project renders the shell without crashing because
 *   each slot is either the caller-supplied node or a static placeholder;
 *   we never touch milestone data in here.
 *
 * Slice 01 addendum: the center slot default is now a live `SliceBoard`
 * populated from `useProjectTree(projectId)`. The left and right slots
 * remain stubs until slices 02/03 wire their panels in. Data fetching is
 * pushed into the small internal `BoardCenterDefault` component so the
 * shell itself stays dumb — callers that pass `center` directly still
 * bypass the hook entirely.
 */

export interface ProjectDetailBoardViewProps {
  /**
   * The project this board is rendering. Required so the KPI bar can
   * query `useKpiData(projectId)` without the shell having to thread
   * state in separately. When omitted the KPI bar silently skips
   * rendering — handy for storybook harnesses that stub the shell
   * without a real project.
   */
  projectId?: string;
  /**
   * Left column — milestones list (260px).
   * If omitted, a muted stub with a "wired in slice 02" hint renders.
   */
  left?: ReactNode;
  /**
   * Center column — selected milestone detail / board (fluid).
   * If omitted and `projectId` is set in `board` mode, the live
   * `SliceBoard` renders with real project-tree data. In `swimlane`
   * mode the default still resolves to a "coming soon" stub.
   */
  center?: ReactNode;
  /**
   * Right column — context rail (slice detail tabs, 360px).
   * If omitted and `projectId` is set, the live {@link SliceDetailTabs}
   * rail renders, keyed on `?slice=` from {@link useSelection}. With no
   * slice selected the rail shows a friendly empty-state hint instead
   * of a spinner — the rail is idle, not loading.
   */
  right?: ReactNode;
  /**
   * View mode the shell is rendering under. Only affects the default
   * center content; the grid geometry is the same for board + swimlane.
   * Defaults to `"board"`.
   */
  mode?: Extract<ViewMode, "board" | "swimlane">;
  /**
   * When `true`, the shell drops its own {@link MissionControlKpiBar}
   * and sizes the grid to fill its parent (`h-full`) instead of
   * pinning to the viewport.
   *
   * Use this when the board is rendered inside a page that already
   * owns the KPI bar and the outer scroll container — notably the new
   * tabbed project-detail shell. The shell assumes its container is
   * `flex flex-col` with a constrained height so the grid's `min-h-0`
   * can resolve.
   */
  embedded?: boolean;
  /** Optional extra classes merged onto the grid container. */
  className?: string;
}

interface SlotStubProps {
  label: string;
  hint: string;
  testId: string;
}

function SlotStub({ label, hint, testId }: SlotStubProps) {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-dashed border-border bg-muted/30 p-4 text-center"
    >
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="text-xs text-muted-foreground/70">{hint}</span>
    </div>
  );
}

/**
 * Default center-slot content when the caller does not supply `center`
 * and the view is in `board` mode. Pulls the project tree from the
 * shared react-query cache (so mounting next to {@link ProjectDetailTreeView}
 * does NOT fan out a second request) and flattens every milestone's
 * slices into the flat array {@link SliceBoard} expects.
 *
 * Selection is URL-backed via {@link useSelection} so a deep-linked
 * `?slice=...` param lands the highlight on the right card, and clicking
 * a card writes the id back so the rest of the mission-control layout
 * (right-pane chat, etc.) can react on subsequent slices.
 */
function BoardCenterDefault({ projectId }: { projectId: string }) {
  const { data: tree, isLoading, error } = useProjectTree(projectId);
  const { milestoneId, sliceId, setSlice } = useSelection();

  // Slice 02: the left-tree panel filters the board. When `milestoneId` is
  // set in the URL we narrow the flat slice array to that milestone's slices
  // only; otherwise we fall back to every slice across the project so the
  // default landing still reads as "everything".
  //
  // Titles for every milestone are still collected unconditionally — a
  // highlighted card may belong to a milestone that is filtered out in a
  // future iteration, and the breadcrumb lookup should keep working.
  const { flattenedSlices, milestoneTitles } = useMemo(() => {
    const slices: PlanSliceTree[] = [];
    const titles = new Map<string, string>();
    for (const milestone of tree?.milestones ?? []) {
      titles.set(milestone.id, milestone.title);
      if (milestoneId && milestone.id !== milestoneId) continue;
      for (const slice of milestone.slices) {
        slices.push(slice);
      }
    }
    return { flattenedSlices: slices, milestoneTitles: titles };
  }, [tree, milestoneId]);

  if (isLoading && !tree) {
    return (
      <div
        data-testid="board-center-loading"
        className="flex h-full min-w-0 flex-col gap-2 overflow-hidden p-2"
      >
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="board-center-error"
        className="flex h-full min-w-0 items-center justify-center p-4 text-sm text-destructive"
      >
        Failed to load project tree.
      </div>
    );
  }

  return (
    <SliceBoard
      columns={DEFAULT_SLICE_COLUMNS}
      slices={flattenedSlices}
      milestoneTitleFor={(slice) =>
        milestoneTitles.get(slice.milestone_id) ?? ""
      }
      selectedSliceId={sliceId}
      onSelectSlice={(id) => setSlice(id)}
    />
  );
}

/**
 * Default left-slot content — the {@link ProjectTreePanel} backed by the
 * shared `useProjectTree` cache and URL-backed {@link useSelection} state.
 *
 * - Clicking a milestone writes `?milestone=<id>` and clears any `?slice=` so
 *   the center board filters to that milestone cleanly.
 * - Clicking a slice writes both `?milestone=<parent>` and `?slice=<id>` so
 *   the tree and the board agree on the highlighted card even if the user
 *   lands on the URL from a deep link.
 * - A no-op `onGeneratePlan` is intentionally omitted here: the dispatcher
 *   already surfaces a "Generate plan" affordance on the tree-view, and we
 *   do not want to double-render the CTA in the rail.
 */
/**
 * Default right-slot content — the {@link SliceDetailTabs} rail fed by
 * URL-backed {@link useSelection} state.
 *
 * - When no slice is selected the rail renders a friendly empty-state hint
 *   (not a spinner). Nothing is loading; the rail is simply waiting on a
 *   user-driven selection from the tree or the board.
 * - When a slice IS selected we render the default tab registry. Passing the
 *   current `sliceId` through `SliceDetailTabs` means tab switches stay
 *   local to the rail without remounting; a new selection just re-renders
 *   the inner panels with a new `sliceId`, which avoids the unmount flicker
 *   the parent slice.md calls out.
 * - The registry itself is `DEFAULT_SLICE_TABS` so future slices (e.g.
 *   milestone 10's Supervisor log) plug in by spreading the default list
 *   without touching this file.
 */
function BoardRightDefault({ projectId }: { projectId: string }) {
  const { milestoneId, sliceId } = useSelection();

  // Priority: slice selection wins (drills into slice tabs), then milestone
  // selection falls back to the milestone-level detail panel so a user who
  // clicks a milestone in the tree gets context on the right rail instead of
  // an empty "pick a slice" hint. Only when neither is set does the idle
  // empty-state render.
  if (sliceId) {
    return (
      <div data-testid="board-right-rail" className="h-full min-w-0 overflow-hidden">
        <SliceDetailTabs
          tabs={DEFAULT_SLICE_TABS}
          sliceId={sliceId}
          projectId={projectId}
        />
      </div>
    );
  }

  if (milestoneId) {
    return (
      <div
        data-testid="board-right-rail-milestone"
        className="h-full min-w-0 overflow-hidden"
      >
        <MilestoneDetailPanel
          projectId={projectId}
          milestoneId={milestoneId}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="board-right-empty"
      className="flex h-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-dashed border-border bg-muted/30 p-4 text-center"
    >
      <span className="text-sm font-medium text-muted-foreground">
        Nothing selected
      </span>
      <span className="text-xs text-muted-foreground/70">
        Pick a milestone or a slice from the tree to see its details here.
      </span>
    </div>
  );
}

function BoardLeftDefault({ projectId }: { projectId: string }) {
  const { milestoneId, sliceId, setSelection } = useSelection();
  return (
    <ProjectTreePanel
      projectId={projectId}
      selectedMilestoneId={milestoneId ?? undefined}
      selectedSliceId={sliceId ?? undefined}
      // Clicking a milestone narrows the board to that milestone and clears
      // any lingering slice selection so the highlight state stays coherent.
      // Both URL params move in a single history transition — see the
      // `setSelection` doc on `useSelection` for why.
      onSelectMilestone={(id) => setSelection({ milestoneId: id, sliceId: null })}
      // Clicking a slice writes both params together so a deep-link rebuild
      // of the URL keeps tree expansion + board highlight in sync.
      onSelectSlice={(mId, sId) =>
        setSelection({ milestoneId: mId, sliceId: sId })
      }
    />
  );
}

export function ProjectDetailBoardView({
  projectId,
  left,
  center,
  right,
  mode = "board",
  embedded = false,
  className,
}: ProjectDetailBoardViewProps) {
  const centerHint =
    mode === "swimlane"
      ? "Swimlane layout — coming soon"
      : "Stub — board view";

  // Resolve default center content. In swimlane mode we still show the
  // "coming soon" stub — SliceBoard is a board-view affordance only. In
  // board mode, if we have a projectId, we wire the live SliceBoard;
  // otherwise (storybook / no project) we fall back to the stub so the
  // shell remains usable in isolation.
  let resolvedCenter: ReactNode;
  if (center !== undefined) {
    resolvedCenter = center;
  } else if (mode === "board" && projectId) {
    resolvedCenter = <BoardCenterDefault projectId={projectId} />;
  } else {
    resolvedCenter = (
      <SlotStub
        label={mode === "swimlane" ? "Swimlane" : "Board"}
        hint={centerHint}
        testId="board-center-stub"
      />
    );
  }

  return (
    <div
      data-testid="project-detail-board-view-wrapper"
      data-view-mode={mode}
      data-embedded={embedded ? "true" : "false"}
      className={cn(
        "flex flex-col gap-4",
        embedded && "h-full min-h-0",
        className,
      )}
    >
      {!embedded && projectId ? <MissionControlKpiBar projectId={projectId} /> : null}
      <div
        data-testid="project-detail-board-view"
        data-view-mode={mode}
        className={cn(
          "grid grid-cols-[260px_1fr_360px] gap-4 flex-1 min-h-0",
          embedded ? "h-full" : "h-[calc(100vh-var(--appbar-h))]",
        )}
      >
        <div
          data-slot="board-left"
          className="min-w-0 overflow-hidden"
        >
          {left ?? (
            mode === "board" && projectId ? (
              <BoardLeftDefault projectId={projectId} />
            ) : (
              <SlotStub
                label="Milestones"
                hint="Stub — wired in slice 02"
                testId="board-left-stub"
              />
            )
          )}
        </div>
        <div
          data-slot="board-center"
          className="min-w-0 overflow-hidden"
        >
          {resolvedCenter}
        </div>
        <div
          data-slot="board-right"
          className="min-w-0 overflow-hidden"
        >
          {right ?? (
            projectId ? (
              <BoardRightDefault projectId={projectId} />
            ) : (
              <SlotStub
                label="Context"
                hint="Stub — no project"
                testId="board-right-stub"
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default ProjectDetailBoardView;
