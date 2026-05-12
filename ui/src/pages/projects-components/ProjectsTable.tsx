import * as React from "react";
import { useNavigate } from "react-router-dom";
import { FileCode, GitBranch, MoreHorizontal } from "lucide-react";

import { StatusPill } from "@/components/design";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, timeAgo } from "@/lib/utils";
import type { Project } from "@/lib/types";

/**
 * ProjectsTable — table view of projects under the M22 token system
 * (slice 23-02 T0X). Restyles the inline table from M20 (`projects.tsx`)
 * into a small, presentational component:
 *
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │ NAME            WORKSPACE     BRANCH          LAST ACTIVITY    ⋯  │  ← header (uppercase tracking-wider zinc-500 font-semibold)
 *   │───────────────────────────────────────────────────────────────────│  ← divide-y between body rows
 *   │ ▣  Flockctl     [work]        ⎇ main          3h ago             ⋯│  ← hover bg-zinc-50 dark:bg-zinc-800/40
 *   │ ▣  cms          [personal]    ⎇ feat/x        2d ago             ⋯│
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - Presentational: the parent (e.g. `projects.tsx`) is responsible for
 *     sorting + pagination + filter + grouping. Sorting and pagination
 *     state, when callers add it, live OUTSIDE this component — pass the
 *     pre-sorted, pre-paged rows in via {@link ProjectsTableProps.rows}.
 *   - Click anywhere on a row navigates to `/projects/:id`. The kebab
 *     dropdown stops propagation so opening the menu (or selecting an
 *     item) does NOT also navigate.
 *   - The workspace column uses `<StatusPill tone="info">` and accepts an
 *     optional `accentClassName` so callers can paint each workspace's
 *     family colour (matches `ProjectCard`'s pill).
 *   - Edge cases: missing workspace renders a `—` placeholder; missing
 *     branch renders `—`; missing last-activity falls back to `—` via
 *     `timeAgo`; long names / branches truncate with `min-w-0 + truncate`.
 */

export interface ProjectsTableRowWorkspace {
  /** Display name shown inside the pill. */
  name: string;
  /**
   * Optional Tailwind class override for the pill's bg + text colour.
   * Defaults to StatusPill's `info` tone (indigo).
   */
  accentClassName?: string;
}

export interface ProjectsTableRowGit {
  branch: string;
}

export interface ProjectsTableRow {
  project: Pick<Project, "id" | "name" | "path" | "repo_url" | "updated_at">;
  /** Optional workspace pill. Standalone projects pass `undefined`. */
  workspace?: ProjectsTableRowWorkspace;
  /** Optional git info; omitted → branch column shows `—`. */
  git?: ProjectsTableRowGit;
  /**
   * ISO timestamp of last activity for the row (e.g. last task, last
   * commit, last project mutation). Falls back to `project.updated_at`
   * when omitted.
   */
  lastActivity?: string | null;
}

export interface ProjectsTableProps {
  rows: ReadonlyArray<ProjectsTableRow>;
  /** Override the default `nav('/projects/:id')` row click. */
  onRowClick?: (id: string) => void;
  /** Optional kebab actions. Omit any callback to hide its menu item. */
  onRename?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  className?: string;
  "data-testid"?: string;
}

const HEADER_CELL =
  "px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500";

const BODY_CELL = "px-3 py-2 align-middle";

const ROW =
  "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors";

export function ProjectsTable({
  rows,
  onRowClick,
  onRename,
  onArchive,
  onDelete,
  className,
  "data-testid": testId,
}: ProjectsTableProps): React.JSX.Element {
  const navigate = useNavigate();
  const hasKebab = Boolean(onRename || onArchive || onDelete);

  const handleOpen = React.useCallback(
    (id: string) => {
      if (onRowClick) {
        onRowClick(id);
        return;
      }
      navigate(`/projects/${id}`);
    },
    [navigate, onRowClick],
  );

  return (
    <table
      data-testid={testId ?? "projects-table"}
      className={cn("w-full text-[12.5px]", className)}
    >
      <thead data-testid="projects-table-head">
        <tr>
          <th scope="col" className={HEADER_CELL}>
            Name
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Workspace
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden md:table-cell")}>
            Branch
          </th>
          <th scope="col" className={cn(HEADER_CELL, "hidden sm:table-cell")}>
            Last activity
          </th>
          <th
            scope="col"
            className={cn(HEADER_CELL, "w-[44px] text-right")}
            aria-label="Actions"
          />
        </tr>
      </thead>
      <tbody
        data-testid="projects-table-body"
        className="divide-y divide-zinc-100 dark:divide-zinc-800"
      >
        {rows.map(({ project, workspace, git, lastActivity }) => {
          const activity = lastActivity ?? project.updated_at ?? null;
          return (
            <tr
              key={project.id}
              data-testid="projects-table-row"
              data-project-id={project.id}
              role="link"
              tabIndex={0}
              aria-label={`Open project ${project.name}`}
              onClick={() => handleOpen(project.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleOpen(project.id);
                }
              }}
              className={cn(ROW, "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
            >
              {/* Name — icon-tile + name (path under the name on mobile, hidden columns on desktop) */}
              <td className={cn(BODY_CELL)}>
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    data-testid="projects-table-icon"
                    className="h-7 w-7 rounded-lg bg-blue-500/15 text-blue-500 grid place-items-center shrink-0"
                    aria-hidden="true"
                  >
                    <FileCode className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div
                      data-testid="projects-table-name"
                      className="font-semibold text-[12.5px] truncate"
                    >
                      {project.name}
                    </div>
                    <div
                      data-testid="projects-table-path"
                      className="text-[11px] text-zinc-500 font-mono truncate md:hidden"
                      title={project.path ?? project.repo_url ?? ""}
                    >
                      {project.path ?? project.repo_url ?? "—"}
                    </div>
                  </div>
                </div>
              </td>

              {/* Workspace pill */}
              <td className={cn(BODY_CELL, "hidden md:table-cell")}>
                {workspace ? (
                  <StatusPill
                    tone="info"
                    data-testid="projects-table-workspace-pill"
                    className={cn(workspace.accentClassName)}
                  >
                    {workspace.name}
                  </StatusPill>
                ) : (
                  <span
                    data-testid="projects-table-workspace-empty"
                    className="text-zinc-400"
                  >
                    —
                  </span>
                )}
              </td>

              {/* Branch */}
              <td
                className={cn(
                  BODY_CELL,
                  "hidden md:table-cell font-mono text-[11.5px] text-zinc-500",
                )}
              >
                {git ? (
                  <span
                    data-testid="projects-table-branch"
                    className="inline-flex items-center gap-1 min-w-0"
                  >
                    <GitBranch
                      className="h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate">{git.branch}</span>
                  </span>
                ) : (
                  <span
                    data-testid="projects-table-branch-empty"
                    className="text-zinc-400"
                  >
                    —
                  </span>
                )}
              </td>

              {/* Last activity */}
              <td
                className={cn(
                  BODY_CELL,
                  "hidden sm:table-cell text-[11.5px] text-zinc-500",
                )}
              >
                <span data-testid="projects-table-last-activity">
                  {timeAgo(activity)}
                </span>
              </td>

              {/* Actions kebab */}
              <td className={cn(BODY_CELL, "text-right w-[44px]")}>
                {hasKebab ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="inline-flex"
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="More actions"
                          data-testid="projects-table-kebab"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        {onRename && (
                          <DropdownMenuItem
                            onSelect={() => onRename(project.id)}
                          >
                            Rename
                          </DropdownMenuItem>
                        )}
                        {onArchive && (
                          <DropdownMenuItem
                            onSelect={() => onArchive(project.id)}
                          >
                            Archive
                          </DropdownMenuItem>
                        )}
                        {onDelete && (
                          <>
                            {(onRename || onArchive) && (
                              <DropdownMenuSeparator />
                            )}
                            <DropdownMenuItem
                              onSelect={() => onDelete(project.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default ProjectsTable;
