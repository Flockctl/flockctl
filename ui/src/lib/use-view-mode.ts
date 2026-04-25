import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * URL-backed view-mode state machine for the project-detail mission-control
 * layout. Every slice in milestone 09 plugs into this hook.
 *
 * Resolution precedence:
 *   1. validated `?view=` query param
 *   2. last choice persisted in localStorage (per-project if projectId given)
 *   3. default `'tree'`
 *
 * Allow-list is strict: any value outside {'board','tree','swimlane'}
 * (including empty strings, unicode, injection payloads, …) silently falls
 * back to the default instead of throwing. This is deliberate — a corrupted
 * URL param must never crash the page or leak into the DOM unescaped.
 *
 * The returned `setMode` is referentially stable across renders so callers
 * can safely place it in effect dep arrays.
 */

export type ViewMode = "board" | "tree" | "swimlane";

const ALLOWED_VIEW_MODES: readonly ViewMode[] = ["board", "tree", "swimlane"] as const;
const DEFAULT_VIEW_MODE: ViewMode = "tree";
const STORAGE_KEY_PREFIX = "flockctl.viewMode";

function isViewMode(value: unknown): value is ViewMode {
  return (
    typeof value === "string" &&
    (ALLOWED_VIEW_MODES as readonly string[]).includes(value)
  );
}

function storageKey(projectId?: string): string {
  return projectId ? `${STORAGE_KEY_PREFIX}.${projectId}` : STORAGE_KEY_PREFIX;
}

function readStoredMode(projectId?: string): ViewMode | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(projectId));
    return isViewMode(raw) ? raw : null;
  } catch {
    // localStorage disabled (private mode, SSR, SecurityError) — treat as absent.
    return null;
  }
}

function writeStoredMode(mode: ViewMode, projectId?: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(projectId), mode);
  } catch {
    // Quota / disabled — silently degrade; URL param is still authoritative.
  }
}

/**
 * @param projectId - optional scope for the per-project last-choice memory.
 *   When omitted, a single global key is used.
 */
export function useViewMode(
  projectId?: string,
): [ViewMode, (mode: ViewMode) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawParam = searchParams.get("view");

  const mode: ViewMode = useMemo(() => {
    if (rawParam !== null && isViewMode(rawParam)) return rawParam;
    const stored = readStoredMode(projectId);
    if (stored) return stored;
    return DEFAULT_VIEW_MODE;
  }, [rawParam, projectId]);

  const setMode = useCallback(
    (next: ViewMode) => {
      if (!isViewMode(next)) return;
      // Persist first so a synchronous re-read sees the new value even if the
      // setSearchParams flush is batched (same-tick contract).
      writeStoredMode(next, projectId);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("view", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams, projectId],
  );

  return [mode, setMode];
}
