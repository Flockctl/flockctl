import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Layers, Plus } from "lucide-react";

import { SectionHeader } from "@/components/design";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { WorkspaceCard, type WorkspaceCardData } from "./WorkspaceCard";
import { AddWorkspaceCard } from "./AddWorkspaceCard";

/**
 * WorkspacesGrid — header + toolbar + 3-column grid of workspace cards
 * for the redesigned `/workspaces` page (slice 23-03 T03).
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ <SectionHeader title="Workspaces" subtitle="…" action={ search +   │
 *   │                                                  + New workspace }/│
 *   │                                                                    │
 *   │  <div class="grid grid-cols-3 gap-3">                              │
 *   │    <WorkspaceCard ... />  <WorkspaceCard ... />  <WorkspaceCard.../│
 *   │    <AddWorkspaceCard onClick={onNewWorkspace}/>                    │
 *   │  </div>                                                            │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Search:
 *   - Driven by the URL `?q=` parameter (mirrors `ProjectsToolbar`).
 *   - Debounced 200 ms on commit so a typing burst does not flood the
 *     address bar even with `replace: true`.
 *   - Filter applied against `name` and `path`, case-insensitive
 *     substring (see {@link filterWorkspacesByQuery}).
 *   - When the filter result is empty (and a non-empty query is active)
 *     the grid is replaced with a full-width `<EmptyState>` carrying a
 *     CTA wired to `onNewWorkspace`.
 *
 * Why a single component instead of a separate WorkspacesToolbar +
 * WorkspacesGrid? Workspaces has only one toolbar widget (search + a
 * single button) — there is no view-toggle. Splitting would just create
 * a thin ceremony layer; folding header + toolbar + grid in one place
 * keeps the URL-state plumbing local to the surface that consumes it.
 */

const DEFAULT_DEBOUNCE_MS = 200;
const QUERY_PARAM = "q";

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

const GRID_CLASSES = "grid grid-cols-3 gap-3";

/**
 * URL-backed `?q=` state with debounced commit.
 *
 * Returns:
 *   - `draft`        — what the input currently shows (uncommitted typing).
 *   - `query`        — what the URL holds (debounced commit).
 *   - `setDraft(v)`  — update the draft. After `debounceMs`, the draft
 *                      is committed to URL `?q=` (using `replace: true`
 *                      so back/forward isn't polluted).
 *
 * Empty / whitespace-only drafts clear the param entirely so a clean
 * URL is `/workspaces` rather than `/workspaces?q=`. Trimming happens on
 * commit, not on every keystroke — so the user can briefly hold a
 * trailing space without the input fighting them.
 */
export function useWorkspacesSearchQuery(
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): {
  draft: string;
  query: string;
  setDraft: (next: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM) ?? "";

  // Draft is local and may diverge from the URL between keystrokes and
  // the debounce flush. Initial draft is whatever the URL says so that
  // landing on /workspaces?q=foo prepopulates the input.
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
 * Filter helper exported so callers (and tests) can apply the same
 * case-insensitive `name`-and-`path` substring match that the grid uses
 * internally. Centralising the predicate keeps the grid's URL state and
 * its rendered list strictly consistent.
 */
export function filterWorkspacesByQuery<
  T extends { name?: string | null; path?: string | null },
>(rows: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const name = (row.name ?? "").toLowerCase();
    const path = (row.path ?? "").toLowerCase();
    return name.includes(trimmed) || path.includes(trimmed);
  });
}

export interface WorkspacesGridProps {
  /** Source list. The grid does not fetch data — the parent does. */
  workspaces: ReadonlyArray<WorkspaceCardData>;
  /**
   * Fired when the user clicks `+ New workspace` (header button, the
   * dashed-border `AddWorkspaceCard`, or the empty-state CTA).
   * Typically opens the create-workspace dialog.
   */
  onNewWorkspace: () => void;
  /**
   * Override the default `nav('/workspaces/:id')` click on each
   * card. Forwarded straight to `<WorkspaceCard onClick>`. When omitted,
   * each card navigates via its built-in `useNavigate()` call.
   */
  onWorkspaceClick?: (id: string) => void;
  /**
   * Override the search debounce. Tests pin this to `0` to keep timer
   * plumbing simple; production uses the 200 ms slice spec default.
   */
  searchDebounceMs?: number;
  /** Page title. Default `"Workspaces"`. */
  title?: string;
  /**
   * Page subtitle. Typically `"N workspaces · M projects total"` —
   * computed by the parent so the count stays in sync with whatever
   * data source the page is using.
   */
  subtitle?: string;
  className?: string;
}

export function WorkspacesGrid({
  workspaces,
  onNewWorkspace,
  onWorkspaceClick,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  title = "Workspaces",
  subtitle,
  className,
}: WorkspacesGridProps) {
  const { draft, query, setDraft } = useWorkspacesSearchQuery(searchDebounceMs);
  const trimmedQuery = query.trim();
  const filtered = filterWorkspacesByQuery(workspaces, query);

  // The grid replaces itself with a full-width empty-state ONLY when the
  // user is actively searching and that search yields nothing. The
  // "no workspaces at all" case is the parent's responsibility (see
  // `workspaces.tsx`'s own `<EmptyState>` for an empty list — that
  // surface is more inviting than a search-result empty state would be).
  const showEmptyState = filtered.length === 0 && trimmedQuery.length > 0;

  return (
    <div data-testid="workspaces-grid" className={className}>
      <SectionHeader
        title={title}
        subtitle={subtitle}
        action={
          <>
            <input
              type="text"
              role="searchbox"
              placeholder="Search workspaces…"
              aria-label="Search workspaces"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={SEARCH_INPUT_CLASSES}
              data-testid="workspaces-search-input"
            />
            <Button
              type="button"
              size="sm"
              onClick={onNewWorkspace}
              data-testid="workspaces-new-workspace-button"
            >
              <Plus aria-hidden="true" />
              New workspace
            </Button>
          </>
        }
      />

      {showEmptyState ? (
        <EmptyState
          icon={Layers}
          title={`No workspaces match “${trimmedQuery}”`}
          description="Try a different name or path."
          action={
            <Button
              type="button"
              size="sm"
              onClick={onNewWorkspace}
              data-testid="workspaces-empty-cta"
            >
              <Plus aria-hidden="true" />
              New workspace
            </Button>
          }
          data-testid="workspaces-grid-empty-state"
        />
      ) : (
        <div data-testid="workspaces-grid-list" className={cn(GRID_CLASSES)}>
          {filtered.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              workspace={ws}
              onClick={
                onWorkspaceClick ? () => onWorkspaceClick(ws.id) : undefined
              }
            />
          ))}
          <AddWorkspaceCard onClick={onNewWorkspace} />
        </div>
      )}
    </div>
  );
}

export default WorkspacesGrid;
