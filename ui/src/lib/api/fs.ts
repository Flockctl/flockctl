import { apiFetch } from "./core";

// --- Filesystem browse ($HOME-jailed directory listing) ---

export interface FsBrowseEntry {
  name: string;
  is_directory: boolean;
  is_symlink: boolean;
  is_hidden: boolean;
}

export interface FsBrowseResponse {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
  truncated: boolean;
}

/**
 * List directory entries under `path` (defaults to `$HOME` on the daemon).
 *
 * The endpoint is loopback-only and refuses any path that escapes `$HOME`
 * (either by resolution or via symlink). `showHidden` toggles dotfile
 * visibility; anything outside `1` behaves as `0` on the server.
 */
export function browseFs(
  path?: string,
  showHidden?: boolean,
): Promise<FsBrowseResponse> {
  const qs = new URLSearchParams();
  if (path) qs.set("path", path);
  if (showHidden) qs.set("show_hidden", "1");
  const suffix = qs.toString();
  return apiFetch<FsBrowseResponse>(`/fs/browse${suffix ? `?${suffix}` : ""}`);
}
