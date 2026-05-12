import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchFsList,
  fetchProjectFile,
  fetchWorkspaceFile,
  fsOp,
  saveProjectFile,
  type FsListResponse,
  type FsMutateResponse,
  type FsReadRange,
  type FsReadResponse,
  type FsWriteResponse,
} from "../api/fs";

// --- Tab-store rename hook ---
//
// Lazy import: the tab-store lives under `components/code-mode/` and we
// don't want a hooks/ → components/ dependency for callers that never
// touch tabs (e.g. an internal tool that just renames a file). The
// `fsOp`-mutation hooks below resolve the rename hook at call time so
// the import graph stays clean and a stub can be swapped in for tests.
type TabRenameHandler = (from: string, to: string) => void;
let tabRenameHandler: TabRenameHandler | null = null;

/**
 * Register the tab-store's rename handler. Called once at module load by
 * `tab-store.ts` so the FS hooks below can notify the editor without an
 * import cycle. Tests can call this with a spy and reset to `null`.
 */
export function __setTabRenameHandler(fn: TabRenameHandler | null): void {
  tabRenameHandler = fn;
}

function notifyTabRename(from: string, to: string): void {
  if (tabRenameHandler) tabRenameHandler(from, to);
}

// --- Project / workspace file read hooks ---
//
// Wraps `GET /:scope/:id/fs/file?path=...` in React Query. `staleTime: 0`
// is intentional: this slice ships read-only loading; live updates land in
// M04 once we have the FS watcher pushing invalidations through the global
// WebSocket. Until then, "always refetch on remount" is the correct trade
// — the only alternative is stale buffers in the editor, which is worse
// than an extra round-trip.

export const projectFileQueryKey = (
  projectId: string,
  path: string | null,
  range?: FsReadRange,
) =>
  // Range participates in the cache key so a partial open and a future
  // whole-file open don't share an entry — the partial response carries
  // a different envelope shape (`partial: true`, `totalSize`) and the
  // editor branches on it. `null` keeps the key stable for the common
  // (non-range) case so existing tests / consumers keep their key
  // shape.
  range
    ? (["project-file", projectId, path, "range", range.offset, range.length] as const)
    : (["project-file", projectId, path] as const);

export interface UseProjectFileOptions {
  /**
   * Opt into a partial read — the editor's "Open first 64 KB read-only"
   * flow on `fs_too_large` files. The offset is in bytes; `length` is
   * clamped server-side at `RANGE_SLICE_CAP` (1 MiB).
   */
  range?: FsReadRange;
}

export function useProjectFile(
  projectId: string,
  path: string | null,
  options?: UseProjectFileOptions,
) {
  const range = options?.range;
  return useQuery<FsReadResponse>({
    queryKey: projectFileQueryKey(projectId, path, range),
    queryFn: () => fetchProjectFile(projectId, path as string, range),
    // The non-null assertion is safe — `enabled` gates the call.
    enabled: !!projectId && !!path,
    staleTime: 0,
  });
}

// --- Project file save (PUT, sha-checked) ---
//
// The mutation is the write counterpart to `useProjectFile`. On a clean save
// it patches the read-cache in place — same `['project-file', projectId, path]`
// key the editor reads from — so the next render sees the just-saved sha
// without paying for a re-fetch (we already know what's on disk; we just put
// it there).
//
// On `fs_sha_conflict` the mutation deliberately leaves the cache alone. The
// rationale is buffer-safety: the editor's dirty buffer represents the user's
// in-flight edits, and `expectedSha` in the cache is the baseline we compare
// against. If we invalidated on conflict, React Query would refetch the
// server's CURRENT state and silently update the baseline sha — making the
// next save attempt look like a fresh edit on top of the new content rather
// than a conflict the user still needs to resolve. Returning the conflict
// envelope to the caller hands the merge decision back to the UI.
//
// Note that conflicts are NOT mutation errors — the HTTP response is 200 with
// `{ ok: false, ... }`, so `mutation.isError` stays false. Callers branch on
// `result.ok` themselves.

export interface SaveProjectFileVars {
  /** Project-relative path (`src/foo.ts`, never absolute). */
  path: string;
  /** New file contents. UTF-8. */
  content: string;
  /**
   * SHA-256 of the contents the editor last read. Empty string indicates a
   * create-new-file intent and pairs with `allowCreate: true`.
   */
  expectedSha: string;
  /**
   * When true, a missing file is allowed (server creates it). When false (the
   * default), a missing file surfaces as `fs_sha_conflict` with `currentSha`
   * = "" so the UI can offer "create" as an explicit recovery path.
   */
  allowCreate?: boolean;
}

export function useSaveProjectFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsWriteResponse, Error, SaveProjectFileVars>({
    mutationFn: ({ path, content, expectedSha, allowCreate }) =>
      saveProjectFile(projectId, path, content, expectedSha, { allowCreate }),
    onSuccess: (res, vars) => {
      // Conflict / FS error envelope — DO NOT touch the cache. See the
      // section header above for the buffer-safety reasoning.
      if (!res.ok) return;

      // Patch the read-cache in place so the editor's view of "what's on
      // disk" matches reality without a re-fetch. We rebuild the full
      // FsReadSuccess envelope (rather than merge into `prev`) because
      // `prev` may be undefined on first save, and the read query's success
      // shape is fully determined by the four values we just got back from
      // the server (content + sha + mtime + size) plus the static
      // `encoding: "utf-8"` contract.
      qc.setQueryData<FsReadResponse>(projectFileQueryKey(projectId, vars.path), {
        ok: true,
        content: vars.content,
        sha: res.sha,
        mtime: res.mtime,
        size: res.size,
        encoding: "utf-8",
      });
    },
  });
}

export const workspaceFileQueryKey = (
  workspaceId: string,
  path: string | null,
  range?: FsReadRange,
) =>
  range
    ? (["workspace-file", workspaceId, path, "range", range.offset, range.length] as const)
    : (["workspace-file", workspaceId, path] as const);

export function useWorkspaceFile(
  workspaceId: string,
  path: string | null,
  options?: UseProjectFileOptions,
) {
  const range = options?.range;
  return useQuery<FsReadResponse>({
    queryKey: workspaceFileQueryKey(workspaceId, path, range),
    queryFn: () => fetchWorkspaceFile(workspaceId, path as string, range),
    enabled: !!workspaceId && !!path,
    staleTime: 0,
  });
}

// --- Project directory listing query key ---
//
// Stable key shape used by both `useFsList` (for callers that just want the
// listing once) and `useFsTree` (which prefills the React Query cache via
// `qc.setQueryData` after a manual fetch so a later component requesting
// the same path renders synchronously). The empty-string path is the project
// root; we keep it as-is in the key rather than coercing to "." so the cache
// shape matches the URL the server saw.

export const fsListQueryKey = (projectId: string, path: string) =>
  ["fs-list", projectId, path] as const;

export function useFsList(
  projectId: string,
  path: string,
  enabled = true,
) {
  return useQuery<FsListResponse>({
    queryKey: fsListQueryKey(projectId, path),
    queryFn: () => fetchFsList(projectId, path),
    enabled: !!projectId && enabled,
    // Listings are cheap to refetch but stable for the duration of an
    // expand/collapse interaction. 5s gives the user time to drill several
    // levels deep without a stampede of refetches as they navigate.
    staleTime: 5_000,
  });
}

// --- FS mutation hooks (mkdir / create / rename / delete) ---
//
// All four hooks share two invalidation invariants on success:
//
//   1. The parent directory's listing query is invalidated so the tree
//      reflects the new shape on its next render — `fs-list` is the
//      source of truth for both `useFsList` consumers and the
//      lazy-loading `useFsTree` (which prefills the same cache via
//      `qc.fetchQuery` and falls back to `useFsList` for siblings).
//   2. For `rename` we ALSO notify the tab-store so any open buffer
//      whose path is being moved follows the new path — matching
//      what Monaco itself does when a model URI changes underneath an
//      open editor view. The notification is delivered through
//      `__setTabRenameHandler` (registered once by `tab-store.ts`) so
//      the hooks file stays free of a components/ import.
//
// On failure we DO NOT invalidate — the on-disk shape didn't change
// and a refetch would only pay an unnecessary round-trip. Callers
// branch on `result.ok` themselves; the mutation's `isError` flag is
// reserved for non-FS network errors that `apiFetch` actually throws.

/** Project-relative POSIX dirname. Returns "" for paths that have no
 *  separator (root-level entries). Pure helper — exported so tests can
 *  exercise it without driving a mutation. */
export function fsDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export interface MkdirVars {
  /** Project-relative path of the directory to create. */
  path: string;
}

export function useFsMkdir(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsMutateResponse, Error, MkdirVars>({
    mutationFn: ({ path }) => fsOp(projectId, { op: "mkdir", path }),
    onSuccess: (res, vars) => {
      if (!res.ok) return;
      void qc.invalidateQueries({
        queryKey: fsListQueryKey(projectId, fsDirname(vars.path)),
      });
    },
  });
}

export interface CreateFileVars {
  /** Project-relative path of the file to create. */
  path: string;
  /** Initial contents. Defaults to an empty file when omitted. */
  content?: string;
}

export function useFsCreateFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsMutateResponse, Error, CreateFileVars>({
    mutationFn: ({ path, content }) =>
      fsOp(projectId, { op: "create", path, ...(content !== undefined ? { content } : {}) }),
    onSuccess: (res, vars) => {
      if (!res.ok) return;
      void qc.invalidateQueries({
        queryKey: fsListQueryKey(projectId, fsDirname(vars.path)),
      });
    },
  });
}

export interface RenameVars {
  /** Project-relative source path. */
  from: string;
  /** Project-relative destination path. */
  to: string;
}

export function useFsRename(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsMutateResponse, Error, RenameVars>({
    mutationFn: ({ from, to }) => fsOp(projectId, { op: "rename", from, to }),
    onSuccess: (res, vars) => {
      if (!res.ok) return;
      // Invalidate BOTH the source-parent and destination-parent
      // listings — when the rename crosses directories they are
      // distinct entries in the cache.
      void qc.invalidateQueries({
        queryKey: fsListQueryKey(projectId, fsDirname(vars.from)),
      });
      void qc.invalidateQueries({
        queryKey: fsListQueryKey(projectId, fsDirname(vars.to)),
      });
      // Hand the rename off to the tab-store so any open buffer for
      // `from` follows along to `to`. Safe to call when no buffer is
      // open — the handler is a no-op in that case.
      notifyTabRename(vars.from, vars.to);
    },
  });
}

export interface DeleteVars {
  /** Project-relative path of the file or directory to remove. */
  path: string;
  /** When true, recursively remove a non-empty directory. Default false
   *  matches the server's opt-in contract — a non-empty dir without the
   *  flag returns `fs_not_empty`. */
  recursive?: boolean;
}

export function useFsDelete(projectId: string) {
  const qc = useQueryClient();
  return useMutation<FsMutateResponse, Error, DeleteVars>({
    mutationFn: ({ path, recursive }) =>
      fsOp(projectId, {
        op: "delete",
        path,
        ...(recursive !== undefined ? { recursive } : {}),
      }),
    onSuccess: (res, vars) => {
      if (!res.ok) return;
      void qc.invalidateQueries({
        queryKey: fsListQueryKey(projectId, fsDirname(vars.path)),
      });
    },
  });
}
