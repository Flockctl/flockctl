import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed tab state for the workspace detail page.
 *
 * Thin wrapper over `useSearchParams` that reads/writes the `?tab=` query
 * param against a strict allow-list. Unlike `useViewMode`, this hook is
 * session-ephemeral — the URL is the sole source of truth, no localStorage
 * persistence. Closing the tab and reopening the workspace drops you back
 * on the default.
 *
 * Resolution:
 *   - validated `?tab=` query param wins
 *   - anything else (missing, empty, XSS payload, wrong case, …) silently
 *     falls back to `'plan'` — never throws, never redirects
 *
 * The returned `setTab` is referentially stable across renders and merges
 * into the existing search params (other query keys on the URL are
 * preserved).
 */

export type WorkspaceTab = "plan" | "runs" | "templates" | "config";

const ALLOWED_TABS: readonly WorkspaceTab[] = [
  "plan",
  "runs",
  "templates",
  "config",
] as const;
const DEFAULT_TAB: WorkspaceTab = "plan";

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return (
    typeof value === "string" &&
    (ALLOWED_TABS as readonly string[]).includes(value)
  );
}

export function useWorkspaceTab(): [WorkspaceTab, (tab: WorkspaceTab) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawParam = searchParams.get("tab");

  const tab: WorkspaceTab = useMemo(() => {
    if (rawParam !== null && isWorkspaceTab(rawParam)) return rawParam;
    return DEFAULT_TAB;
  }, [rawParam]);

  const setTab = useCallback(
    (next: WorkspaceTab) => {
      if (!isWorkspaceTab(next)) return;
      setSearchParams(
        (prev) => {
          // Merge: preserve every other query param on the URL.
          const params = new URLSearchParams(prev);
          params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [tab, setTab];
}
