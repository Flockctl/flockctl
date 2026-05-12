import { apiFetch } from "./core";

// --- Project / workspace file read (jailed to entity root) ---
//
// Backed by `GET /:scope/:id/fs/file?path=<rel>`. The daemon enforces the
// jail and answers with a discriminated `{ ok, ... }` envelope (HTTP 200
// even on `fs_not_found`); see fs-route-handlers.ts. Modelling the failure
// branch in the type keeps the read-side hooks honest — empty/missing files
// are routine for AGENTS.md / TODO.md and shouldn't reach the caller as a
// thrown promise.

export type FsReadErrorCode =
  | "fs_no_path"
  | "fs_invalid_path"
  | "fs_path_outside_project"
  | "fs_not_found"
  | "fs_not_a_file"
  | "fs_too_large"
  | "fs_binary"
  | "fs_no_project_path"
  | "fs_permission_denied"
  | "fs_io_error"
  | "fs_internal_error"
  | "fs_missing_path";

export interface FsReadSuccess {
  ok: true;
  /** UTF-8 contents of the file. */
  content: string;
  /** Content hash (sha256 hex) — used by save flows for conflict detection. */
  sha: string;
  /** File size in bytes. */
  size: number;
  /** Mtime in epoch milliseconds. */
  mtime: number;
  /** Always `"utf-8"` today; kept for forward compatibility. */
  encoding: "utf-8";
}

/**
 * Successful partial-read envelope. Mirrors the daemon's
 * `FsRangeReadSuccess` shape — the discriminator is the `partial: true`
 * literal so the consumer can switch between whole-file and slice reads
 * without re-fetching. `totalSize` is the byte length of the whole file
 * on disk (so the UI can render "showing 64 KB of 12.3 MB"), `range.length`
 * is the number of bytes actually returned (post-clamp; may be shorter
 * than requested when the offset is near EOF).
 */
export interface FsReadPartialSuccess {
  ok: true;
  partial: true;
  /** UTF-8 decoding of the slice. */
  content: string;
  /** SHA-256 of the WHOLE file (identity token, not the slice). */
  sha: string;
  /** Mtime in epoch milliseconds. */
  mtime: number;
  /** Total file size in bytes — denominator for the "you're 2% in" UX. */
  totalSize: number;
  /** Echo of the actual window served, post-clamping. */
  range: { offset: number; length: number };
  encoding: "utf-8";
}

export interface FsReadFailure {
  ok: false;
  error_code: FsReadErrorCode;
  message?: string;
}

export type FsReadResponse =
  | FsReadSuccess
  | FsReadPartialSuccess
  | FsReadFailure;

/**
 * Optional byte-range. Present when the caller wants to opt into a
 * partial read (e.g. operator clicked "Open first 64 KB read-only" on
 * an `fs_too_large` empty state). Encoded onto the wire as
 * `?range=bytes=<offset>-<last>` so the server's HTTP-Range parser
 * accepts it unchanged. Both ends are inclusive.
 */
export interface FsReadRange {
  offset: number;
  /** Number of bytes to read. Server clamps at `RANGE_SLICE_CAP` (1 MiB). */
  length: number;
}

function buildFileQuery(path: string, range?: FsReadRange): string {
  const qs = new URLSearchParams({ path });
  if (range) {
    const last = range.offset + Math.max(range.length, 1) - 1;
    qs.set("range", `bytes=${range.offset}-${last}`);
  }
  return qs.toString();
}

/**
 * Read a single file inside a project's repository.
 *
 * The endpoint refuses any `path` that escapes the project root (either by
 * resolution or via symlink) — the client doesn't try to anticipate that, it
 * just propagates whatever envelope the server returns. `path` is project-
 * relative (`src/foo.ts`, never `/Users/...`); leading slashes are accepted and
 * stripped by the server.
 *
 * Pass `range` to opt into a partial read — used by the large-file flow
 * after the operator clicks "Open first 64 KB read-only" on the
 * `fs_too_large` empty state. The server answers with HTTP 206 + a
 * `partial: true` body on success; on parse / FS errors it falls back to
 * the same `{ ok: false }` envelope as the whole-file path.
 */
export function fetchProjectFile(
  projectId: string,
  path: string,
  range?: FsReadRange,
): Promise<FsReadResponse> {
  return apiFetch<FsReadResponse>(
    `/projects/${projectId}/fs/file?${buildFileQuery(path, range)}`,
  );
}

/**
 * Read a single file inside a workspace's repository. Symmetric mirror of
 * `fetchProjectFile`; the server-side route shares its handler factory.
 */
export function fetchWorkspaceFile(
  workspaceId: string,
  path: string,
  range?: FsReadRange,
): Promise<FsReadResponse> {
  return apiFetch<FsReadResponse>(
    `/workspaces/${workspaceId}/fs/file?${buildFileQuery(path, range)}`,
  );
}

// --- Project file write (PUT, with sha-conflict detection) ---
//
// Backed by `PUT /projects/:id/fs/file?path=<rel>` with a JSON body of
// `{ content, expectedSha, allowCreate? }`. The server answers with the same
// HTTP-200 + discriminated `{ ok, ... }` envelope shape as the read endpoint
// — including the conflict branch — so the UI can react to `fs_sha_conflict`
// without crossing the throw/catch boundary. `apiFetch` would otherwise
// surface a non-2xx as a thrown `Error`, eating the structured `currentSha`
// the conflict-resolution UI needs.
//
// We use `rawKeys: true` so that:
//   1. Outgoing — `expectedSha` / `allowCreate` survive untouched (the default
//      camelCase pass-through is a no-op on already-camel keys, but pinning
//      `rawKeys` documents the intent and removes a future-refactor footgun).
//   2. Incoming — `currentSha` from the conflict envelope reaches the caller
//      verbatim instead of being snake-cased to `current_sha`. The UI matches
//      on the field as the server wrote it.

export type FsWriteErrorCode =
  | "fs_no_path"
  | "fs_invalid_path"
  | "fs_path_outside_project"
  | "fs_not_found"
  | "fs_too_large"
  | "fs_no_project_path"
  | "fs_io_error"
  | "fs_internal_error"
  | "fs_missing_path"
  /** Caller's `expectedSha` did not match the file's on-disk sha. */
  | "fs_sha_conflict";

export interface FsWriteSuccess {
  ok: true;
  /** SHA-256 of the content that just landed on disk (post-rename). */
  sha: string;
  /** Mtime of the freshly-renamed file, in epoch milliseconds. */
  mtime: number;
  /** Bytes written. */
  size: number;
}

export interface FsWriteFailure {
  ok: false;
  error_code: FsWriteErrorCode;
  /**
   * On `fs_sha_conflict`, the server includes the current on-disk sha so
   * the UI can offer a three-way merge / overwrite-with-current flow without
   * a follow-up read round-trip. Empty string means "the file does not exist
   * and `allowCreate` was false" (caller passed an `expectedSha` that implied
   * an existing file).
   */
  currentSha?: string;
  message?: string;
}

export type FsWriteResponse = FsWriteSuccess | FsWriteFailure;

/**
 * Write a single text file inside a project's repository, with optimistic-
 * concurrency control via the caller-supplied `expectedSha`. The server
 * rejects the write (returning `fs_sha_conflict` + `currentSha`) whenever the
 * on-disk sha has drifted since the caller last read the file — this is the
 * dirty-buffer guard that lets the editor reason about "save what I see".
 *
 * `expectedSha` is the empty string when the caller wants to create a new
 * file; pair with `opts.allowCreate=true` to opt into creation.
 */
export function saveProjectFile(
  projectId: string,
  path: string,
  content: string,
  expectedSha: string,
  opts?: { allowCreate?: boolean },
): Promise<FsWriteResponse> {
  const qs = new URLSearchParams({ path });
  return apiFetch<FsWriteResponse>(
    `/projects/${projectId}/fs/file?${qs.toString()}`,
    {
      method: "PUT",
      body: JSON.stringify({
        content,
        expectedSha,
        allowCreate: opts?.allowCreate ?? false,
      }),
      // See section header comment for why `rawKeys` is mandatory here.
      rawKeys: true,
    },
  );
}

// --- Project directory listing (file-tree backing API) ---
//
// Backed by `GET /projects/:id/fs/list?path=<rel>`. The endpoint always
// answers HTTP 200 once the entity + path shape checks pass — actual FS
// failures are reported as `{ ok: false, error_code }` so the UI can switch
// per-error without losing the response body to a thrown exception.

export type FsListErrorCode =
  | "fs_no_path"
  | "fs_invalid_path"
  | "fs_path_outside_root"
  | "fs_not_found"
  | "fs_not_a_directory"
  | "fs_permission_denied"
  | "fs_internal_error";

export interface FsListEntry {
  /** Basename of the entry (no slashes). */
  name: string;
  type: "file" | "dir";
  /** File size in bytes — undefined for directories. */
  size?: number;
  /** Epoch-ms mtime, undefined when stat() failed (broken symlink, race). */
  mtime?: number;
  /** Cheap probe — set on directories, undefined on files. */
  hasChildren?: boolean;
  /** True when the entry matches the project's `.gitignore`. */
  ignored: boolean;
}

export interface FsListSuccess {
  ok: true;
  /** Echoed relative path; "." for the root listing. */
  path: string;
  entries: FsListEntry[];
  /** True when the directory exceeded the server's per-listing cap. */
  truncated: boolean;
}

export interface FsListFailure {
  ok: false;
  error_code: FsListErrorCode;
  message?: string;
}

export type FsListResponse = FsListSuccess | FsListFailure;

/**
 * List one directory level inside a project's repository.
 *
 * The endpoint is intentionally non-recursive — the file-tree expands one
 * node at a time and re-calls this per directory. `path` is project-relative
 * (empty string lists the project root). The discriminated `ok` envelope
 * lets callers branch on `error_code` for FS-level failures (jail escapes,
 * missing dir, permission denied) without throwing.
 */
export function fetchFsList(
  projectId: string,
  path: string,
): Promise<FsListResponse> {
  const qs = new URLSearchParams();
  if (path) qs.set("path", path);
  const suffix = qs.toString();
  return apiFetch<FsListResponse>(
    `/projects/${projectId}/fs/list${suffix ? `?${suffix}` : ""}`,
  );
}

// --- Project filesystem mutations (mkdir / create / rename / delete) ---
//
// Backed by `POST /projects/:id/fs/op`. The endpoint is a single discriminated
// mutation surface: the wire body's `op` field selects between mkdir, create,
// rename and delete, and the response shape is the same `{ ok, ... }` envelope
// the read endpoints use — including FS-domain failures (HTTP 200 with `ok:
// false`). Routing all four through one endpoint keeps the audit row uniform
// and lets the route-level rate-limit treat tree mutation as one bucket.
//
// `rawKeys: true` is mandatory: the server's Zod schema is keyed on
// camelCase (`from`, `to`, `recursive`) and the daemon-wide key-conversion
// pass would otherwise rewrite them as `from`/`to` (no-op) or, worse,
// silently drop the canonical names if a future field crosses the
// camel/snake boundary.

/** Discriminated union of every possible failure code the mutation endpoint
 *  emits. Matches `FsErrorCode` on the server side; kept in lock-step. */
export type FsMutateErrorCode =
  | "fs_no_path"
  | "fs_invalid_path"
  | "fs_invalid_name"
  | "fs_path_outside_project"
  | "fs_not_found"
  | "fs_not_a_file"
  | "fs_not_a_directory"
  | "fs_already_exists"
  | "fs_not_empty"
  | "fs_permission_denied"
  | "fs_too_large"
  | "fs_no_project_path"
  | "fs_io_error"
  | "fs_internal_error";

export interface FsMutateSuccess {
  ok: true;
}

export interface FsMutateFailure {
  ok: false;
  error_code: FsMutateErrorCode;
  message?: string;
}

export type FsMutateResponse = FsMutateSuccess | FsMutateFailure;

/** Body shape for the `POST /:id/fs/op` endpoint — discriminated on `op`. */
export type FsOpBody =
  | { op: "mkdir"; path: string }
  | { op: "create"; path: string; content?: string }
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; path: string; recursive?: boolean };

/**
 * Issue a discriminated FS mutation against a project. The server answers
 * with HTTP 200 + `{ ok: true }` on success, or HTTP 200 + `{ ok: false,
 * error_code, message? }` on every FS-domain failure. Caller branches on
 * `result.ok`; non-FS errors (404 / 422) still throw via `apiFetch`.
 */
export function fsOp(
  projectId: string,
  body: FsOpBody,
): Promise<FsMutateResponse> {
  return apiFetch<FsMutateResponse>(`/projects/${projectId}/fs/op`, {
    method: "POST",
    body: JSON.stringify(body),
    rawKeys: true,
  });
}

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
