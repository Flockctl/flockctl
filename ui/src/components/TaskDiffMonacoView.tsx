/**
 * TaskDiffMonacoView — Monaco-backed diff viewer for the task-detail
 * "Show Diff" section. Replaces the previous {@link InlineDiff} call
 * site in {@link "@/pages/task-detail"} with the same DiffEditor surface
 * Code-mode uses for working-tree diffs.
 *
 * UX shape (file-list layout — preferred over a vertical stack so long
 * change-sets stay scannable):
 *
 *   ┌──────────── files ─────────────┬──────── DiffEditor ─────────┐
 *   │ src/foo.ts          +12 -3     │                              │
 *   │ src/bar.ts (active) +5  -1     │  monaco DiffEditor for the   │
 *   │ docs/README.md      +0  -7     │  active file's hunks         │
 *   │ …                              │                              │
 *   └────────────────────────────────┴──────────────────────────────┘
 *
 * Data flow:
 *   - Caller hands us the raw unified-diff string from the task-diff
 *     endpoint plus the `truncated` flag. We parse via the shared
 *     `unifiedDiffToFilePairs` helper so the same logic is reused if
 *     other surfaces ever want a Monaco view of a unified diff.
 *   - Each entry becomes a sidebar row + a DiffEditor mount on click.
 *     Only the active file's editor is mounted at a time — Monaco is
 *     expensive and most change-sets touch >5 files; mounting them all
 *     would tank the page.
 *
 * Out of scope for this slice:
 *   - Editing either side. The editor is read-only by construction.
 *   - File-tree grouping. The flat list mirrors what `git diff` emits
 *     and avoids a second render path for the rare edge cases (renames
 *     across directories) where a tree would be clearer.
 *   - Hunk-level discard. Task-level rejection lives on the approval
 *     banner in `task-detail.tsx`; this component is read-only.
 */
import { useMemo, useState } from "react";

import { CodeEditor } from "@/components/CodeEditor";
import {
  unifiedDiffToFilePairs,
  type DiffFilePair,
} from "@/lib/diff/unified-to-pairs";
import { cn } from "@/lib/utils";

export interface TaskDiffMonacoViewProps {
  diff: string;
  truncated?: boolean;
  className?: string;
}

export function TaskDiffMonacoView({
  diff,
  truncated,
  className,
}: TaskDiffMonacoViewProps) {
  const files = useMemo<DiffFilePair[]>(
    () => unifiedDiffToFilePairs(diff),
    [diff],
  );

  // The first file is selected by default; the index lets us survive
  // path renames between renders (path strings can collide for adds vs.
  // deletes of the same file in the same change-set, so we key on the
  // array position, not on `path`).
  const [activeIdx, setActiveIdx] = useState(0);
  const active = files[activeIdx] ?? files[0];

  if (files.length === 0) {
    return (
      <div
        data-testid="task-diff-monaco-empty"
        className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
      >
        No changes to display.
      </div>
    );
  }

  return (
    <div
      data-testid="task-diff-monaco"
      data-file-count={files.length}
      className={cn("flex h-[32rem] flex-col overflow-hidden rounded-md border border-border", className)}
    >
      <div className="flex min-h-0 flex-1">
        {/* Sidebar — flat list of touched paths with +N/-M counts. */}
        <ul
          data-testid="task-diff-monaco-files"
          className="w-64 shrink-0 overflow-y-auto border-r border-border bg-muted/20 text-xs"
        >
          {files.map((f, idx) => {
            const isActive = idx === activeIdx;
            return (
              <li key={`${f.path}-${idx}`}>
                <button
                  type="button"
                  data-testid="task-diff-monaco-file"
                  data-active={isActive ? "true" : "false"}
                  data-path={f.path}
                  onClick={() => setActiveIdx(idx)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate" title={f.path}>
                    {f.path || "(unknown)"}
                  </span>
                  {f.isBinary ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      bin
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px]">
                      <span className="text-emerald-500 dark:text-emerald-400">
                        +{f.added}
                      </span>
                      <span className="mx-1 opacity-50">/</span>
                      <span className="text-red-500 dark:text-red-400">
                        -{f.removed}
                      </span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {/* Right pane — Monaco DiffEditor for the active file, or a
            fallback if the active file is binary. */}
        <div className="min-w-0 flex-1">
          {active && active.isBinary ? (
            <div
              data-testid="task-diff-monaco-binary"
              className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
            >
              Binary diff — cannot render in editor.
            </div>
          ) : active ? (
            <CodeEditor
              key={`${active.path}-${activeIdx}`}
              diff={{ original: active.originalContent }}
              value={active.modifiedContent}
              path={active.path}
              height="100%"
            />
          ) : null}
        </div>
      </div>

      {truncated && (
        <div
          data-testid="task-diff-monaco-truncated"
          className="border-t border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
        >
          Output truncated. Showing the first portion of the diff.
        </div>
      )}
    </div>
  );
}

export default TaskDiffMonacoView;
