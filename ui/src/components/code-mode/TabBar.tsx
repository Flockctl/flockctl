/**
 * TabBar — VSCode-style horizontal tab strip for the Code-mode editor.
 *
 * Backed by {@link useEditorTabsStore} (the buffer-tab store, NOT the
 * polymorphic shell tab store). Each tab represents one open file
 * buffer; switching focus is a model swap inside a single Monaco
 * instance — see `CodeModeEditor` for the editor side.
 *
 * Visual contract (asserted by `tab-bar.test.tsx`):
 *   - Each tab carries: file-type icon, label (basename or
 *     disambiguated parent/basename), a `•` dirty dot when the buffer
 *     differs from disk, and a `×` close button.
 *   - The active tab is highlighted via `data-active="true"` and a
 *     contrasting background.
 *   - Long labels truncate with CSS `truncate`; the full path is always
 *     surfaced via the row's `title` attribute so a hover reveals it.
 *   - When two open tabs share a basename, every label in the
 *     collision group grows toward the root by one parent segment per
 *     pass until labels are unique. See {@link disambiguateLabels}.
 *
 * Out of scope (slice 02):
 *   - Confirm dialog wiring on dirty close (the store flips
 *     `pendingClose`; today the close button just clobbers).
 *   - Keyboard handlers (Cmd+W, Cmd+Tab cycling, …).
 *
 * Test seam: every interactive element exposes a `data-testid` keyed
 * off the tab id so tests can target a specific row without traversing
 * the DOM.
 */
import { useMemo } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { fileIcon } from "@/components/file-tree/file-icon";

import { useEditorTabsStore } from "./tab-store";

/**
 * Disambiguate labels for a list of project-relative POSIX paths.
 *
 * Algorithm (matches the SKILL spec):
 *   1. Start every label as its basename.
 *   2. While any basename appears in more than one label, prepend the
 *      next parent segment to every label in that collision group.
 *   3. Stop when no collisions remain — or when a colliding tab has no
 *      more parent segments to add (degenerate but possible if the same
 *      path is somehow open twice; the store dedupes by path so this
 *      shouldn't happen in practice, but we don't loop forever on it).
 *
 * Pure function exported so it can be unit-tested without mounting the
 * component.
 */
export function disambiguateLabels(paths: readonly string[]): string[] {
  // Pre-split each path into its segments so we don't repeat the work
  // every iteration. Empty segments (a leading "/") get filtered so a
  // path like "/foo/bar.ts" still labels as "bar.ts".
  const splits = paths.map((p) => p.split("/").filter(Boolean));
  const labels = splits.map((s) => s[s.length - 1] ?? "");

  // `depth` is the number of trailing segments currently included in a
  // colliding label. depth=1 = basename only; depth=2 = parent/basename;
  // and so on. The loop runs until either no collisions remain or no
  // expandable members remain in any collision group.
  let depth = 1;
  // Hard ceiling — defends against pathological inputs where the loop
  // can't make progress. The store is bounded by what a user can
  // realistically open, so this is purely a safety belt.
  const MAX_DEPTH = 32;
  while (depth < MAX_DEPTH) {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < labels.length; i++) {
      const arr = groups.get(labels[i]!);
      if (arr) arr.push(i);
      else groups.set(labels[i]!, [i]);
    }
    let progressed = false;
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      const expandable = indices.filter((i) => splits[i]!.length > depth);
      if (expandable.length === 0) continue;
      for (const i of expandable) {
        const segs = splits[i]!;
        const start = Math.max(0, segs.length - depth - 1);
        labels[i] = segs.slice(start).join("/");
      }
      progressed = true;
    }
    if (!progressed) break;
    depth += 1;
  }
  return labels;
}

export interface TabBarProps {
  className?: string;
}

export function TabBar({ className }: TabBarProps) {
  // Selector form keeps unrelated re-renders out of this component —
  // every Zustand `set` only retriggers the consumers that read the
  // changed slice (Zustand's default is `Object.is` per selector).
  const tabs = useEditorTabsStore((s) => s.tabs);
  const activeId = useEditorTabsStore((s) => s.activeId);
  const focus = useEditorTabsStore((s) => s.focus);
  const close = useEditorTabsStore((s) => s.close);

  const labels = useMemo(
    () => disambiguateLabels(tabs.map((t) => t.path)),
    [tabs],
  );

  // An empty bar would still occupy a row in the layout; render nothing
  // so the editor area starts at the top of the pane.
  if (tabs.length === 0) return null;

  return (
    <div
      data-testid="tab-bar"
      role="tablist"
      aria-label="Open files"
      className={cn(
        "flex h-9 items-stretch overflow-x-auto border-b bg-muted/20",
        className,
      )}
    >
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeId;
        const label = labels[idx]!;
        const basename = tab.path.split("/").pop() ?? tab.path;
        const { icon: Icon, colorClass } = fileIcon(basename);
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            data-testid={`tab-${tab.id}`}
            data-active={isActive ? "true" : "false"}
            data-dirty={tab.dirty ? "true" : "false"}
            data-path={tab.path}
            aria-selected={isActive}
            // The whole row carries the full path on `title` so the
            // truncated label is always recoverable on hover. The label
            // span repeats it so the title still resolves when the
            // user hovers the truncated text directly.
            title={tab.path}
            onClick={() => focus(tab.id)}
            onMouseDown={(e) => {
              // Middle-click closes — VSCode parity. Keyboard close
              // (Cmd+W) is the next slice; mouse handling stays here.
              if (e.button === 1) {
                e.preventDefault();
                close(tab.id);
              }
            }}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-xs select-none",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            <Icon
              className={cn("h-3.5 w-3.5 shrink-0", colorClass)}
              aria-hidden
            />
            <span
              className="max-w-[180px] truncate"
              title={tab.path}
              data-testid={`tab-label-${tab.id}`}
            >
              {label}
            </span>
            {tab.dirty ? (
              <span
                aria-label="Unsaved changes"
                data-testid={`tab-dirty-${tab.id}`}
                className="ml-0.5 leading-none text-foreground"
              >
                •
              </span>
            ) : null}
            <button
              type="button"
              data-testid={`tab-close-${tab.id}`}
              aria-label={`Close ${basename}`}
              onClick={(e) => {
                // Stop propagation so the click doesn't also focus the
                // tab on its way out — `close` already handles focus
                // shift via the reducer's `removeTab` rule.
                e.stopPropagation();
                close(tab.id);
              }}
              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default TabBar;
