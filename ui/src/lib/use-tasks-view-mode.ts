import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed view-mode state machine for the /tasks page.
 *
 * Mirrors the pattern in `use-view-mode.ts` (slice 00 task 03) but is scoped
 * to the *tasks* page's two-way segmented toggle:
 *
 *   - "table"   (default) — the legacy filters + table UI. Saved filters and
 *                           workflows are tied to this mode, so it MUST
 *                           render byte-for-byte identically to the pre-slice
 *                           implementation.
 *   - "kanban"            — cross-project kanban: tasks from all projects
 *                           grouped into status columns.
 *
 * URL contract:
 *
 *   /tasks?view=kanban
 *
 * - Any `?view=` value outside the allow-list silently degrades to "table".
 *   This includes the legacy `?view=cards` value — the cards view has been
 *   removed in favour of the kanban; saved bookmarks land on the table view.
 * - `setMode` uses `{ replace: true }` so toggling never adds a browser
 *   history entry or triggers a navigation.
 *
 * There is intentionally no localStorage fallback for the tasks page; saved
 * filters already live inside the table, and the URL is authoritative.
 */

export type TasksViewMode = "table" | "kanban";

const ALLOWED_VIEW_MODES: readonly TasksViewMode[] = [
  "table",
  "kanban",
] as const;

const DEFAULT_VIEW_MODE: TasksViewMode = "table";

function isViewMode(value: unknown): value is TasksViewMode {
  return (
    typeof value === "string" &&
    (ALLOWED_VIEW_MODES as readonly string[]).includes(value)
  );
}

export interface UseTasksViewModeResult {
  mode: TasksViewMode;
  setMode: (next: TasksViewMode) => void;
}

export function useTasksViewMode(): UseTasksViewModeResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get("view");

  const mode: TasksViewMode = useMemo(
    () => (rawView !== null && isViewMode(rawView) ? rawView : DEFAULT_VIEW_MODE),
    [rawView],
  );

  const setMode = useCallback(
    (next: TasksViewMode) => {
      if (!isViewMode(next)) return;
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("view", next);
          // The cards view is gone — strip its sub-param so stale bookmarks
          // don't leave noise in the URL after switching to kanban or back.
          params.delete("groupBy");
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { mode, setMode };
}
