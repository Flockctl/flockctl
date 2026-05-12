import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";

import { SegmentToggle } from "@/components/design/SegmentToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ProjectsToolbar — search input + Cards/Table view toggle + indigo
 * `+ New project` button. Lives in the header rail of `/projects`
 * (slice 23-02 T04).
 *
 * Three pieces of state, each anchored to the right durability layer:
 *
 *   1. **Search query** — typed into the native `<input>`, debounced
 *      200 ms before being committed to the URL `?q=` param. Debouncing
 *      is intentional: every keystroke firing a router replace would
 *      flood the address bar history (even with `replace: true`,
 *      consumers re-render). The URL is the single source of truth so
 *      reload / share / back-button all keep the user where they were.
 *
 *   2. **View mode** — Cards | Table. Persisted to localStorage under
 *      `projects.view`. URL is *not* used here because Cards vs. Table
 *      is a personal preference, not a shareable view.
 *
 *   3. **+ New project** — pure call-to-action. The dialog itself
 *      (CreateProjectDialog) lives in `projects.tsx`; this component
 *      surfaces the button and forwards the click via
 *      `onNewProject?` so the parent can open the dialog.
 *
 * The component self-manages all three pieces of state; it also fires
 * `onSearchChange` (after the debounce) and `onViewChange` (on click)
 * so the parent can react without re-implementing the same plumbing.
 *
 * For consumers that need to read the live state without depending on
 * callbacks, the {@link useProjectsSearchQuery} and {@link
 * useProjectsView} hooks expose the same source of truth.
 */

export type ProjectsView = "cards" | "table";

const VIEW_STORAGE_KEY = "projects.view";
const ALLOWED_VIEWS: ReadonlyArray<ProjectsView> = ["cards", "table"] as const;
const DEFAULT_VIEW: ProjectsView = "cards";
const DEFAULT_DEBOUNCE_MS = 200;
const QUERY_PARAM = "q";

function isProjectsView(v: unknown): v is ProjectsView {
  return (
    typeof v === "string" &&
    (ALLOWED_VIEWS as readonly string[]).includes(v)
  );
}

function readStoredView(): ProjectsView | null {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_STORAGE_KEY);
    return isProjectsView(raw) ? raw : null;
  } catch {
    // localStorage can throw in private-mode Safari etc. Treat as absent.
    return null;
  }
}

function writeStoredView(v: ProjectsView): void {
  try {
    globalThis.localStorage?.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    // Quota / disabled — silently degrade. The component still works,
    // the choice just won't survive a reload.
  }
}

/**
 * URL-backed search query state for the `/projects` page.
 *
 * Returns:
 *   - `draft`        — what the input currently shows (uncommitted typing).
 *   - `query`        — what the URL holds (debounced commit).
 *   - `setDraft(v)`  — update the draft. After `debounceMs`, the draft
 *                      is committed to URL `?q=` (using `replace: true`
 *                      so back/forward isn't polluted).
 *
 * Empty / whitespace-only drafts clear the param entirely (so a clean
 * URL is `/projects` rather than `/projects?q=`). Trimming happens on
 * commit, not on every keystroke — so the user can briefly hold a
 * trailing space without the input fighting them.
 *
 * Because tests want deterministic timing, `debounceMs` is overridable
 * (defaults to 200 ms per slice spec).
 */
export function useProjectsSearchQuery(debounceMs: number = DEFAULT_DEBOUNCE_MS): {
  draft: string;
  query: string;
  setDraft: (next: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM) ?? "";

  // Draft is local and may diverge from the URL between keystrokes and
  // the debounce flush. Initial draft is whatever the URL says so that
  // landing on /projects?q=foo prepopulates the input.
  const [draft, setDraftState] = useState<string>(urlQuery);

  // If the URL changes externally (e.g. browser back), reflect that
  // back into the draft. We compare against the previous URL value so
  // we don't clobber an in-flight typing session that hasn't committed
  // yet.
  const lastUrlRef = useRef<string>(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastUrlRef.current) {
      lastUrlRef.current = urlQuery;
      setDraftState(urlQuery);
    }
  }, [urlQuery]);

  // Debounced commit. `setSearchParams` with `{ replace: true }` keeps
  // the address-bar history clean — typing 8 characters shouldn't
  // produce 8 history entries.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === urlQuery) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (trimmed) params.set(QUERY_PARAM, trimmed);
          else params.delete(QUERY_PARAM);
          return params;
        },
        { replace: true },
      );
      lastUrlRef.current = trimmed;
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs, setSearchParams, urlQuery]);

  const setDraft = useCallback((next: string) => {
    setDraftState(next);
  }, []);

  return { draft, query: urlQuery, setDraft };
}

/**
 * localStorage-backed view-mode state for the `/projects` page.
 *
 * Default is `'cards'` (matches the prototype). Invalid persisted
 * values (corrupted localStorage, an old enum entry, etc.) silently
 * fall back to the default rather than throwing.
 *
 * `setView` writes through to localStorage immediately so a reload
 * during the same tick picks up the new value.
 */
export function useProjectsView(): [ProjectsView, (view: ProjectsView) => void] {
  const [view, setView] = useState<ProjectsView>(
    () => readStoredView() ?? DEFAULT_VIEW,
  );

  const set = useCallback((next: ProjectsView) => {
    if (!isProjectsView(next)) return;
    writeStoredView(next);
    setView(next);
  }, []);

  return [view, set];
}

export interface ProjectsToolbarProps {
  /**
   * Fired with the committed (debounced) search query whenever it
   * changes. The string is already trimmed.
   */
  onSearchChange?: (query: string) => void;
  /** Fired when the user activates a different view. */
  onViewChange?: (view: ProjectsView) => void;
  /**
   * Fired when the user clicks `+ New project`. The parent owns the
   * actual dialog; the toolbar just surfaces the button.
   */
  onNewProject?: () => void;
  /**
   * Override the search debounce. Tests pin this to `0` to keep
   * timer plumbing simple; production uses 200 ms.
   */
  searchDebounceMs?: number;
  className?: string;
  "data-testid"?: string;
}

const VIEW_OPTIONS: ReadonlyArray<{ value: ProjectsView; label: string }> = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const;

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

/**
 * Filter helper exported so callers (e.g. the projects page) can apply
 * the same case-insensitive `name`-and-`path` substring match the
 * toolbar contracts for. Centralising the predicate keeps the toolbar's
 * URL state and the rendered list strictly consistent.
 */
export function filterProjectsByQuery<T extends { name?: string | null; path?: string | null }>(
  rows: ReadonlyArray<T>,
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const name = (row.name ?? "").toLowerCase();
    const path = (row.path ?? "").toLowerCase();
    return name.includes(trimmed) || path.includes(trimmed);
  });
}

export function ProjectsToolbar({
  onSearchChange,
  onViewChange,
  onNewProject,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  className,
  "data-testid": testId,
}: ProjectsToolbarProps) {
  const { draft, query, setDraft } = useProjectsSearchQuery(searchDebounceMs);
  const [view, setView] = useProjectsView();

  // Mirror committed query changes to the parent. Skip the very first
  // emission when the URL is empty so consumers don't get a synthetic
  // "" event on mount they didn't ask for.
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedRef.current === query) return;
    lastEmittedRef.current = query;
    onSearchChange?.(query);
  }, [query, onSearchChange]);

  const handleViewChange = useCallback(
    (next: ProjectsView) => {
      setView(next);
      onViewChange?.(next);
    },
    [setView, onViewChange],
  );

  const segmentOptions = useMemo(() => [...VIEW_OPTIONS], []);

  return (
    <div
      data-testid={testId ?? "projects-toolbar"}
      className={cn("flex items-center gap-2", className)}
    >
      <input
        type="text"
        role="searchbox"
        placeholder="Search projects…"
        aria-label="Search projects"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={SEARCH_INPUT_CLASSES}
        data-testid="projects-search-input"
      />
      <SegmentToggle<ProjectsView>
        options={segmentOptions}
        value={view}
        onChange={handleViewChange}
        aria-label="Projects view"
        data-testid="projects-view-toggle"
      />
      <Button
        type="button"
        size="sm"
        onClick={onNewProject}
        data-testid="projects-new-project-button"
      >
        <Plus aria-hidden="true" />
        New project
      </Button>
    </div>
  );
}

export default ProjectsToolbar;
