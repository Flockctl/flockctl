import * as React from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, MoreHorizontal } from "lucide-react";

import { FlatCard, LiveDot, StatusPill } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import {
  workspaceTone,
  WORKSPACE_TONE_GRADIENT,
} from "@/lib/workspace-tone";

/**
 * WorkspaceCard — single workspace tile in the workspaces grid (slice
 * 23-03 T01). Mirrors `.flockctl/plan/ui-prototype.html` lines 351–406:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ▣  name [ACTIVE]                              ⋯       │
 *   │    /Users/me/code/work                                │
 *   │                                                       │
 *   │ description, leading-relaxed                          │
 *   │                                                       │
 *   │ ▤ 4 projects   ●live 3 tasks running       2h ago    │
 *   └──────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - Presentational only. The parent page hands the card a small bag of
 *     props derived from `Workspace` + `active_task_count` + the project
 *     list — no react-query hooks here so the card stays trivially
 *     unit-testable and re-usable from a future search/grouping page.
 *   - Click anywhere on the card body navigates to `/workspaces/:id`
 *     (matching the existing `M20` workspace-detail route). The kebab
 *     dropdown stops propagation so opening the menu (or selecting an
 *     item) does NOT also navigate.
 *   - Avatar tone is deterministic: `workspaceTone(name)` picks one of
 *     five gradient classes from `WORKSPACE_TONE_GRADIENT`. The mapping
 *     is materialised here (not built via template literals) so the
 *     Tailwind JIT scanner sees the literal class strings.
 *   - Description fallback: when the workspace row has no description,
 *     the card falls back to the first three project names joined by
 *     ", ". When the workspace has zero projects either, the slot is
 *     omitted entirely (no orphan empty paragraph).
 *   - Bottom row: project count is always shown; the "tasks running"
 *     indicator switches between an emerald LiveDot ("N tasks running")
 *     when `activeTaskCount > 0` and a zinc LiveDot ("idle") when not.
 *     The relative-time stamp is right-aligned via `ml-auto`.
 *   - Truncate everywhere a string can be long: name, path, description.
 *     The `min-w-0` chain on the flex column above the text is what lets
 *     `truncate` actually clip the string instead of overflowing the row.
 */

export interface WorkspaceCardData {
  /** Stable workspace identifier — used for the default click target. */
  id: string;
  /** Display name. Drives the avatar letter and the deterministic tone. */
  name: string;
  /** Filesystem path. Rendered mono. May be very long → truncate. */
  path: string;
  /** Optional description. When null, falls back to project names. */
  description?: string | null;
  /** Whether the workspace is "active" (paints the green ACTIVE pill). */
  active?: boolean;
  /**
   * Number of projects associated with this workspace. Always shown in
   * the bottom-row "N projects" slot.
   */
  projectCount: number;
  /**
   * Names of projects in this workspace. Used as the description
   * fallback when `description` is null. Only the first three are
   * surfaced; longer lists are truncated.
   */
  projectNames?: string[];
  /**
   * Number of currently-running tasks across all projects in this
   * workspace. Drives the live-dot tone in the bottom row.
   */
  activeTaskCount: number;
  /**
   * ISO-8601 timestamp of the last activity (most recent task / chat /
   * commit). Rendered via `timeAgo` in the bottom-right.
   */
  lastActivityAt: string | null | undefined;
}

export interface WorkspaceCardProps {
  workspace: WorkspaceCardData;
  /** Override the default `nav('/workspaces/:id')` click. */
  onClick?: () => void;
  /** Optional kebab actions. Omit all to hide the kebab. */
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  /** Extra classes merged onto the FlatCard root. */
  className?: string;
}

function WorkspaceCardImpl({
  workspace,
  onClick,
  onRename,
  onArchive,
  onDelete,
  className,
}: WorkspaceCardProps): React.JSX.Element {
  const navigate = useNavigate();
  const handleOpen = React.useCallback(() => {
    if (onClick) {
      onClick();
      return;
    }
    navigate(`/workspaces/${workspace.id}`);
  }, [navigate, onClick, workspace.id]);

  const tone = workspaceTone(workspace.name);
  const gradient = WORKSPACE_TONE_GRADIENT[tone];
  const initial = (workspace.name[0] ?? "?").toUpperCase();

  // Description fallback: first three project names, comma-joined. We
  // skip the slot entirely if neither a description nor any project
  // names are available, rather than rendering an empty paragraph that
  // would gobble up the card's vertical rhythm.
  const fallbackDescription = React.useMemo(() => {
    if (!workspace.projectNames || workspace.projectNames.length === 0) {
      return null;
    }
    return workspace.projectNames.slice(0, 3).join(", ");
  }, [workspace.projectNames]);

  const description = workspace.description ?? fallbackDescription;

  const hasKebab = Boolean(onRename || onArchive || onDelete);

  return (
    <FlatCard
      interactive
      onClick={handleOpen}
      className={cn("p-4", className)}
    >
      <div
        data-testid="workspace-card"
        data-workspace-id={workspace.id}
        data-tone={tone}
      >
        {/* Top row: avatar + name/path + (kebab) */}
        <div className="flex items-start gap-3 mb-3">
          <div
            data-testid="workspace-card-avatar"
            className={cn(
              "h-10 w-10 shrink-0 rounded-lg",
              "bg-gradient-to-br",
              gradient,
              "grid place-items-center text-white font-semibold",
            )}
            aria-hidden="true"
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-[13px] flex items-center gap-1.5">
              <span className="truncate">{workspace.name}</span>
              {workspace.active && (
                <StatusPill
                  tone="success"
                  size="sm"
                  data-testid="workspace-card-active-pill"
                >
                  active
                </StatusPill>
              )}
            </div>
            <div
              data-testid="workspace-card-path"
              className="text-[11.5px] text-zinc-500 font-mono truncate"
              title={workspace.path}
            >
              {workspace.path}
            </div>
          </div>
          {hasKebab && (
            <div
              // The kebab lives inside an interactive FlatCard surface,
              // so any click / keyboard activation from inside the
              // dropdown would otherwise also fire the card-level
              // onClick. Stop the bubble at the wrapper.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="-mt-1 -mr-1 shrink-0"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                    data-testid="workspace-card-kebab"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {onRename && (
                    <DropdownMenuItem onSelect={onRename}>
                      Rename
                    </DropdownMenuItem>
                  )}
                  {onArchive && (
                    <DropdownMenuItem onSelect={onArchive}>
                      Archive
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <>
                      {(onRename || onArchive) && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onSelect={onDelete}
                        className="text-destructive focus:text-destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* Description (or project-names fallback) */}
        {description && (
          <div
            data-testid="workspace-card-description"
            className="text-[12.5px] text-zinc-500 mb-3 leading-relaxed line-clamp-2"
          >
            {description}
          </div>
        )}

        {/* Bottom row: projects · live-dot · relative time */}
        <div
          data-testid="workspace-card-meta"
          className="flex items-center gap-3 text-[11.5px]"
        >
          <span
            data-testid="workspace-card-project-count"
            className="flex items-center gap-1 text-zinc-500"
          >
            <LayoutGrid className="h-3 w-3" aria-hidden="true" />
            {workspace.projectCount} {workspace.projectCount === 1 ? "project" : "projects"}
          </span>
          {workspace.activeTaskCount > 0 ? (
            <span
              data-testid="workspace-card-tasks-running"
              className="flex items-center gap-1 text-emerald-500"
            >
              <LiveDot state="live" size="xs" />
              {workspace.activeTaskCount} {workspace.activeTaskCount === 1 ? "task" : "tasks"} running
            </span>
          ) : (
            <span
              data-testid="workspace-card-idle"
              className="flex items-center gap-1 text-zinc-500"
            >
              <LiveDot state="idle" size="xs" pulse={false} />
              idle
            </span>
          )}
          <span
            data-testid="workspace-card-last-activity"
            className="text-zinc-500 ml-auto"
          >
            {timeAgo(workspace.lastActivityAt)}
          </span>
        </div>
      </div>
    </FlatCard>
  );
}

/**
 * Memoised (audit-round-5) — workspaces grid re-renders on every poll
 * tick; memo lets unchanged cards skip work.
 */
export const WorkspaceCard = React.memo(WorkspaceCardImpl);
export default WorkspaceCard;
