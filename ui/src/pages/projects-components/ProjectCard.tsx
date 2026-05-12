import * as React from "react";
import { useNavigate } from "react-router-dom";
import { FileCode, GitBranch, MoreHorizontal, Star } from "lucide-react";

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
import type { Project } from "@/lib/types";

/**
 * ProjectCard — single project tile in the workspace-grouped Cards layout
 * (slice 23-02 T01). Mirrors `.flockctl/plan/ui-prototype.html` lines
 * 447–490: a `FlatCard interactive` surface that shows
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │ ▣  name ⭐                              [livedot]   │
 *   │    path/to/repo                                    │
 *   │ [workspace-pill]                                   │
 *   │ description, leading-relaxed                       │
 *   │ ⎇ branch   N changes                       2↑3↓   │
 *   │ Mission · 42%                                      │
 *   │ ▰▰▰▰▰▱▱▱▱▱                                         │
 *   └────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - The card is presentational: the parent page hands it the project
 *     row plus a small bag of derived inputs (workspace, branch info,
 *     mission progress, optional callbacks). This keeps the card
 *     trivially testable without mocking hooks.
 *   - Click anywhere on the card body navigates to `/projects/:id`. The
 *     kebab dropdown stops propagation so opening the menu (or selecting
 *     an item) does NOT also navigate.
 *   - The workspace pill uses `<StatusPill tone="info">` and accepts an
 *     optional `accentClassName` to override the indigo default with the
 *     workspace's chosen colour family (the prototype paints `work` indigo,
 *     `personal` pink, `opensource` amber).
 *   - Edge cases: missing description (paragraph omitted), missing branch
 *     info (whole git row omitted), missing mission (progress block
 *     omitted), very long name / path (truncate with `min-w-0` chains).
 */

export interface ProjectCardWorkspace {
  /** Display name shown inside the pill. */
  name: string;
  /**
   * Optional Tailwind class override for the pill's bg + text colour.
   * Defaults to StatusPill's `info` tone (indigo). The prototype paints
   * the `work` workspace indigo (`bg-indigo-500/15 text-indigo-600`),
   * `personal` pink, `opensource` amber — those classes go here.
   */
  accentClassName?: string;
}

export interface ProjectCardGitInfo {
  /** Current branch name; rendered mono next to the branch icon. */
  branch: string;
  /** Number of uncommitted changes. 0 → emerald "clean", > 0 → amber "N changes". */
  changeCount: number;
  /** Commits ahead of upstream. Right-aligned, mono. */
  ahead?: number;
  /** Commits behind upstream. Right-aligned, mono. */
  behind?: number;
}

export interface ProjectCardMission {
  /** Mission completion percentage (0–100). Clamped on render. */
  percent: number;
}

export interface ProjectCardProps {
  project: Pick<Project, "id" | "name" | "path" | "repo_url" | "description">;
  /** Optional workspace pill. Standalone projects pass `undefined`. */
  workspace?: ProjectCardWorkspace;
  /** Whether this project is pinned ("⭐" next to the name). */
  pinned?: boolean;
  /** Whether the project has an active task (paints the live-dot). */
  hasActiveTask?: boolean;
  /** Optional git status; omitted → the branch row is not rendered. */
  git?: ProjectCardGitInfo;
  /** Optional mission progress; omitted → the progress block is not rendered. */
  mission?: ProjectCardMission;
  /** Override the default `nav('/projects/:id')` click. */
  onClick?: () => void;
  /** Optional kebab actions. Omit to hide the kebab. */
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function ProjectCardImpl({
  project,
  workspace,
  pinned,
  hasActiveTask,
  git,
  mission,
  onClick,
  onRename,
  onArchive,
  onDelete,
}: ProjectCardProps): React.JSX.Element {
  const navigate = useNavigate();
  const handleOpen = React.useCallback(() => {
    if (onClick) {
      onClick();
      return;
    }
    navigate(`/projects/${project.id}`);
  }, [navigate, onClick, project.id]);

  // The repo path the user thinks of: an explicit path wins, then the
  // remote URL, then a placeholder (so the row never collapses to 0px and
  // misaligns the icon-tile baseline).
  const pathLabel = project.path ?? project.repo_url ?? "—";

  const hasKebab = Boolean(onRename || onArchive || onDelete);
  const hasMission = mission !== undefined;
  const missionPercent = hasMission ? clampPercent(mission.percent) : 0;

  return (
    <FlatCard
      interactive
      onClick={handleOpen}
      className="p-3.5"
    >
      <div data-testid="project-card" data-project-id={project.id}>
        {/* Top row: icon + name/path + (live-dot, kebab) */}
        <div className="flex items-start gap-2 mb-2">
          <div
            data-testid="project-card-icon"
            className="h-8 w-8 rounded-lg bg-blue-500/15 text-blue-500 grid place-items-center shrink-0"
            aria-hidden="true"
          >
            <FileCode className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[13px] flex items-center gap-1.5">
              <span className="truncate">{project.name}</span>
              {pinned && (
                <Star
                  data-testid="project-card-pinned"
                  className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
                  aria-label="pinned"
                />
              )}
            </div>
            <div
              data-testid="project-card-path"
              className="text-[11.5px] text-zinc-500 font-mono truncate"
              title={pathLabel}
            >
              {pathLabel}
            </div>
          </div>
          {hasActiveTask && (
            <LiveDot
              data-testid="project-card-live"
              state="live"
              size="sm"
              className="mt-1.5 shrink-0"
            />
          )}
          {hasKebab && (
            <div
              // The kebab lives inside an interactive FlatCard surface, so
              // any click / keyboard activation from inside the dropdown
              // would otherwise also fire the card-level onClick. Stop the
              // bubble at the wrapper.
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
                    data-testid="project-card-kebab"
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

        {/* Workspace pill row (omitted for standalone projects) */}
        {workspace && (
          <div className="flex items-center gap-1.5 mb-3">
            <StatusPill
              tone="info"
              data-testid="project-card-workspace-pill"
              className={cn(workspace.accentClassName)}
            >
              {workspace.name}
            </StatusPill>
          </div>
        )}

        {/* Description */}
        {project.description && (
          <p
            data-testid="project-card-description"
            className="text-[12px] text-zinc-500 mb-3 leading-relaxed line-clamp-2"
          >
            {project.description}
          </p>
        )}

        {/* Branch + change count + ahead/behind */}
        {git && (
          <div
            data-testid="project-card-git"
            className="flex items-center gap-3 text-[11.5px] mb-3 font-mono"
          >
            <span className="flex items-center gap-1 text-zinc-500 min-w-0">
              <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{git.branch}</span>
            </span>
            <span
              data-testid="project-card-changes"
              className={
                git.changeCount > 0 ? "text-amber-500" : "text-emerald-500"
              }
            >
              {git.changeCount > 0
                ? `${git.changeCount} changes`
                : "clean"}
            </span>
            {(git.ahead !== undefined || git.behind !== undefined) && (
              <span
                data-testid="project-card-ahead-behind"
                className="text-zinc-500 ml-auto"
              >
                {git.ahead ?? 0}↑{git.behind ?? 0}↓
              </span>
            )}
          </div>
        )}

        {/* Mission progress */}
        {hasMission && (
          <>
            <div
              data-testid="project-card-mission-label"
              className="text-[11px] text-zinc-500 mb-1"
            >
              Mission · {missionPercent}%
            </div>
            <div
              role="progressbar"
              aria-label="Mission progress"
              aria-valuenow={missionPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="project-card-mission-bar"
              className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden"
            >
              <div
                data-testid="project-card-mission-fill"
                className="h-full bg-gradient-to-r from-indigo-500 to-purple-500"
                style={{ width: `${missionPercent}%` }}
              />
            </div>
          </>
        )}
      </div>
    </FlatCard>
  );
}

/**
 * Memoised (audit-round-5) — projects grid re-renders on every poll;
 * memoising cards lets unchanged rows skip render.
 */
export const ProjectCard = React.memo(ProjectCardImpl);
export default ProjectCard;
