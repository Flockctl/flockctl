import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { browseFs, type FsBrowseResponse } from "../api";
import { queryKeys } from "./core";

// --- Filesystem browse hook ---

/**
 * Cached directory listing for the DirectoryPicker. Undefined `path` tells
 * the server to default to `$HOME`. The query is always enabled — callers
 * that want to gate on dialog-open state can simply not mount the hook.
 *
 * `showHidden` is part of the query key so toggling it fetches a fresh
 * listing rather than reusing the filtered one. The cache survives the
 * dialog being closed and re-opened, giving directories you've already
 * visited an instantaneous render.
 */
export function useFsBrowse(
  path: string | undefined,
  showHidden = false,
  options?: Partial<UseQueryOptions<FsBrowseResponse>>,
) {
  return useQuery<FsBrowseResponse>({
    queryKey: queryKeys.fsBrowse(path, showHidden),
    queryFn: () => browseFs(path, showHidden),
    // Directory contents change rarely during a picker session — 30s stale
    // time is plenty to keep the UI snappy without serving truly stale data.
    staleTime: 30_000,
    ...options,
  });
}
