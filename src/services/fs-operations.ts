import path from "path";
import fs from "fs/promises";
import { realpathSync, createReadStream, type Stats } from "fs";
import { createHash, randomUUID } from "crypto";
import { loadGitignoreMatcher } from "./fs-gitignore.js";

/**
 * fs-operations — read-only filesystem helpers backing the project / workspace
 * file-tree UI. Everything in this module shares one invariant: the resolved
 * absolute path MUST stay inside the entity root (`projectRoot` /
 * `workspaceRoot`). Callers pass the entity root once; the service is
 * responsible for jail-checking every relative path before touching the FS.
 *
 * The contract is:
 *   - **Discriminated outcomes.** Every public function returns either
 *     `{ ok: true, ... }` or `{ ok: false, error_code, message? }` — the
 *     caller (route handler) translates the error_code into HTTP status.
 *     Throwing is reserved for genuinely unexpected failures (and is caught
 *     by the global error handler).
 *   - **No symlink-target leakage.** We `stat` rather than `lstat` only to
 *     classify entries as file vs directory; we never expose the link target.
 *     Symlink escape is prevented by canonicalising the resolved path with
 *     `realpath` and re-checking it against the canonical root.
 *   - **Bounded work.** Listings cap at `LIST_ENTRY_CAP` (5000) so a
 *     pathological directory does not blow up the request thread; the
 *     `truncated` flag tells the UI we're not showing everything.
 */

export type FsErrorCode =
  // Codes used by listProjectDir / resolveSafePath.
  | "fs_no_path"
  | "fs_invalid_path"
  | "fs_path_outside_root"
  | "fs_not_found"
  | "fs_not_a_directory"
  | "fs_permission_denied"
  | "fs_internal_error"
  // Codes used by readProjectFile (M04 slice 00 / read-file route).
  // Naming intentionally divergent from the listProjectDir set so the
  // read-file response shape stays aligned with the public API spec
  // (see docs/API.md once the route lands). Mapping from the list-flow
  // codes happens inside readProjectFile.
  | "fs_path_outside_project"
  | "fs_too_large"
  | "fs_binary"
  | "fs_no_project_path"
  | "fs_io_error"
  | "fs_missing_path"
  // Range-read specific.
  | "fs_invalid_range"
  // Write-specific (M01 slice 03 / write-file route).
  // Surfaces when the caller's `expectedSha` does not match the on-disk
  // sha at write time — the route returns this in-body so the UI can prompt
  // a refresh-and-retry rather than silently overwriting concurrent changes.
  | "fs_sha_conflict"
  // Mutation-flow codes (POST /:id/fs/op — mkdir/create/rename/delete).
  // Kept distinct from the read-flow set so the audit-row error_code can
  // round-trip through `fs_audit_log.error_code` without re-mapping.
  | "fs_invalid_name"
  | "fs_already_exists"
  | "fs_not_empty";

export interface FsEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
  hasChildren?: boolean;
  ignored: boolean;
}

export type FsListSuccess = {
  ok: true;
  path: string;
  entries: FsEntry[];
  truncated: boolean;
};

export type FsListFailure = {
  ok: false;
  error_code: FsErrorCode;
  message?: string;
};

export type FsListResult = FsListSuccess | FsListFailure;

export const LIST_ENTRY_CAP = 5000;

/**
 * Has-children probe cap: we read at most this many dirents to decide whether
 * a directory has any visible children. The exact count doesn't matter — we
 * just need a boolean. Bounded so a directory with a million files doesn't
 * cost more than reading 1 dirent to render its parent's "expandable" caret.
 */
const HAS_CHILDREN_PROBE_CAP = 1;

/**
 * Resolve a user-supplied relative path against an entity root, refusing any
 * input that escapes the root or carries shell-meaningful characters.
 *
 * The check happens in three layers, each catching a different attack:
 *   1. Reject absolute paths up front — `/etc/passwd` is not a valid relative
 *      input even if it would, by accident, resolve back inside the root.
 *   2. Reject NUL bytes (`\0`) — Node's path APIs throw on these but later
 *      code paths (`fs.readFile` etc.) interpret them as string terminators
 *      on some platforms. Belt-and-braces.
 *   3. After joining and resolving, the absolute path string must start with
 *      `root + sep` (or equal `root`). This catches `..` traversal that
 *      `path.join` collapses but does not reject.
 *
 * Symlink-based escape is handled by the caller: after `resolveSafePath`
 * returns `ok`, the caller should `fs.realpath` the absolute path and re-run
 * the prefix check against the canonicalised root if symlink jail enforcement
 * is required for the operation. For the listing path (read-only directory
 * traversal of the user's own project) we accept the simpler check — symlinks
 * are rare in source trees and the worst case is "the listing surfaces names
 * from a directory the operator deliberately linked into their own project".
 */
export function resolveSafePath(
  root: string,
  relPath: string,
):
  | { ok: true; absolute: string; relative: string }
  | { ok: false; error_code: FsErrorCode; message?: string } {
  if (!root) {
    return { ok: false, error_code: "fs_no_path", message: "no root configured" };
  }

  // Treat empty / whitespace as "list the root itself".
  const raw = (relPath ?? "").trim();
  const candidate = raw === "" ? "." : raw;

  // Layer 1: reject absolute inputs outright. `path.isAbsolute` handles both
  // POSIX `/foo` and platform-specific cases. Even if the absolute path
  // resolves back inside `root`, accepting it would let a caller probe FS
  // shape (does `/etc` exist? does `/var` exist?) by watching the error code.
  if (path.isAbsolute(candidate)) {
    return {
      ok: false,
      error_code: "fs_invalid_path",
      message: "path must be relative to the entity root",
    };
  }

  // Layer 2: NUL byte → invalid. Some Node FS calls would throw later; failing
  // here gives a stable error_code instead of leaking a thrown error message.
  if (candidate.indexOf("\0") !== -1) {
    return { ok: false, error_code: "fs_invalid_path", message: "path contains NUL byte" };
  }

  const absoluteRoot = path.resolve(root);
  const joined = path.resolve(absoluteRoot, candidate);

  // Layer 3: prefix check after `path.resolve`, which collapses `..`.
  if (joined !== absoluteRoot && !joined.startsWith(absoluteRoot + path.sep)) {
    return {
      ok: false,
      error_code: "fs_path_outside_root",
      message: "path escapes the entity root",
    };
  }

  const relative = path.relative(absoluteRoot, joined) || ".";
  return { ok: true, absolute: joined, relative };
}

/**
 * List the contents of `relPath` inside `projectRoot`, returning a
 * directory-first / alphabetical entry list with cheap `hasChildren` probes
 * for sub-directories and `ignored` flags pulled from the project's
 * `.gitignore` (plus the always-on `.git` / `node_modules` defaults).
 *
 * The function is intentionally NON-recursive — the UI expands one level at a
 * time and re-calls this endpoint per node. Eager recursion would be both
 * slow on large monorepos and pointless when 90% of the tree never gets
 * expanded.
 *
 * Stat policy: we DO call `fs.stat` per entry so the response includes
 * `size` (files) and `mtime` (everything). On a 5000-entry cap that is at
 * worst 5000 stats — still well under the 200ms target on a warm cache, and
 * the UI uses `mtime` for the "modified ago" tooltip. Errors stat-ing a
 * specific entry are swallowed: the entry is still included with `size` /
 * `mtime` undefined rather than dropped (the alternative — losing entries —
 * is a worse UX than missing a tooltip).
 */
export async function listProjectDir(
  projectRoot: string,
  relPath: string,
): Promise<FsListResult> {
  const safe = resolveSafePath(projectRoot, relPath);
  if (!safe.ok) return safe;

  let stat;
  try {
    stat = await fs.stat(safe.absolute);
  } catch (err) {
    return mapFsError(err, "stat");
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error_code: "fs_not_a_directory",
      message: "path is not a directory",
    };
  }

  let dirents;
  try {
    dirents = await fs.readdir(safe.absolute, { withFileTypes: true });
  } catch (err) {
    return mapFsError(err, "readdir");
  }

  // Resolve the project root ONCE for the gitignore matcher — using the same
  // canonicalised string the matcher cached against guarantees the same
  // gitignore rule set is consulted across every entry in this listing.
  const matcher = await loadGitignoreMatcher(path.resolve(projectRoot));

  // Sort BEFORE truncating so a 6000-entry directory doesn't lose its
  // alphabetically-last 1000 directories under a wave of files.
  // Use the raw dirent.is* hint for sort, then promote to FsEntry with stats.
  const sorted = dirents.slice().sort((a, b) => {
    const ad = a.isDirectory();
    const bd = b.isDirectory();
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const truncated = sorted.length > LIST_ENTRY_CAP;
  const slice = truncated ? sorted.slice(0, LIST_ENTRY_CAP) : sorted;

  const entries: FsEntry[] = await Promise.all(
    slice.map(async (d) => {
      const entryAbs = path.join(safe.absolute, d.name);
      const entryRel = safe.relative === "."
        ? d.name
        : `${safe.relative}/${d.name}`;
      // Symlink classification: if the dirent is a symlink, follow once to
      // decide file vs dir. Broken links collapse to "file" so the UI still
      // renders them (and a click would surface the EBADLINK).
      let type: "file" | "dir";
      let size: number | undefined;
      let mtime: number | undefined;
      try {
        const s = await fs.stat(entryAbs);
        type = s.isDirectory() ? "dir" : "file";
        if (!s.isDirectory()) size = s.size;
        mtime = s.mtimeMs;
      } catch {
        // Broken symlink / racing delete: fall back to the dirent hint.
        type = d.isDirectory() ? "dir" : "file";
      }

      let hasChildren: boolean | undefined;
      if (type === "dir") {
        hasChildren = await probeHasChildren(entryAbs);
      }

      const ignored = matcher.ignores(
        type === "dir" ? `${entryRel}/` : entryRel,
      );

      return {
        name: d.name,
        type,
        size,
        mtime,
        hasChildren,
        ignored,
      };
    }),
  );

  return {
    ok: true,
    path: safe.relative,
    entries,
    truncated,
  };
}

/**
 * Cheap "does this directory have any children?" probe. Reading the first
 * dirent is enough — we never need an exact count — so we open a handle and
 * pull a single batch instead of paying for a full `readdir`. On EACCES we
 * return `undefined` upstream (see caller) but here we collapse to `false`:
 * a directory we can't read isn't expandable from the UI's perspective.
 */
async function probeHasChildren(absolute: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.opendir(absolute, { bufferSize: 1 });
  } catch {
    return false;
  }
  try {
    let read = 0;
    for await (const _ of handle) {
      read += 1;
      if (read >= HAS_CHILDREN_PROBE_CAP) break;
    }
    return read > 0;
  } catch {
    return false;
  }
}

/**
 * Map a Node `fs` errno onto our `FsErrorCode` enum. The caller picks an HTTP
 * status from the code; concentrating the mapping here keeps the route
 * handler free of error-code spelling.
 */
function mapFsError(err: unknown, op: string): FsListFailure {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return { ok: false, error_code: "fs_not_found", message: `${op}: not found` };
  }
  if (e?.code === "ENOTDIR") {
    return {
      ok: false,
      error_code: "fs_not_a_directory",
      message: `${op}: not a directory`,
    };
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") {
    return {
      ok: false,
      error_code: "fs_permission_denied",
      message: `${op}: permission denied`,
    };
  }
  if (
    e?.code === "ENAMETOOLONG" ||
    e?.code === "ELOOP" ||
    e?.code === "EINVAL"
  ) {
    return {
      ok: false,
      error_code: "fs_invalid_path",
      message: `${op}: ${e.code?.toLowerCase()}`,
    };
  }
  return {
    ok: false,
    error_code: "fs_internal_error",
    message: e?.message || `${op}: failed`,
  };
}

// ─── readProjectFile ───────────────────────────────────────────────────────
//
// Read a single text file rooted in `projectRoot`, returning a
// `{ ok, content, sha, mtime, size, encoding }` envelope on success, or a
// discriminated `{ ok:false, error_code, message? }` on every recoverable
// failure (path traversal, missing file, oversize, binary content, I/O error).
//
// Defence-in-depth invariants — every read flows through ALL of these:
//
//   1. **No absolute / NUL / empty input.** Caught up-front by both the
//      `decodeURIComponent` step (against double-encoded `..%2f..` smuggling)
//      and the existing `resolveSafePath` prefix check.
//   2. **No symlink escape.** After `path.resolve` lands inside the root, we
//      `realpath` the deepest existing prefix and re-verify the canonical
//      path still sits under `realpath(projectRoot)`. This catches symlinks
//      planted INSIDE the project (e.g. `<root>/escape -> /etc`).
//   3. **No oversize reads.** `MAX_READ_BYTES` is a hard 2 MiB ceiling (range
//      reads ship in M04 slice 03). The size check uses `stat.size` so we
//      reject before opening the file — the alternative (read-then-check)
//      would still allocate a multi-megabyte buffer.
//   4. **No binary leakage.** The first 4096 bytes are scanned for a NUL byte
//      (the same heuristic git itself uses for `is_binary`). Binary files
//      surface as `error_code='fs_binary'` rather than UTF-8-corrupted text.
//   5. **Strong identity.** SHA-256 of the raw bytes is returned with every
//      success response so the UI can build optimistic "file unchanged since
//      last read" comparisons before write support lands in slice 01.
//
// Symlink-jail rationale: `listProjectDir` deliberately accepts the simpler
// prefix check because the listing path is read-only directory traversal of
// the operator's own source tree, where the worst case is "the listing
// surfaces names from a directory the operator deliberately linked into
// their own project". `readProjectFile` is stricter because the response
// payload — actual file contents — is a much higher-value escape target;
// we'd rather refuse a legitimate-but-symlinked file than serve `/etc/passwd`
// because someone left a `secrets -> /etc` symlink inside the project root.

export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Bytes scanned at the start of the buffer for binary-content detection. */
const BINARY_SNIFF_BYTES = 4096;

export type FsReadSuccess = {
  ok: true;
  content: string;
  sha: string;
  mtime: number;
  size: number;
  encoding: "utf-8";
};

export type FsReadFailure = {
  ok: false;
  error_code: FsErrorCode;
  message?: string;
};

export type FsReadResult = FsReadSuccess | FsReadFailure;

/**
 * Cache the canonicalised project root so we don't pay a `realpath` syscall
 * on every read for the same project. Keys are the raw `projectRoot` string
 * the caller passed (typically a database column value), not the canonical
 * form — caller-equality is what matters for cache-hit semantics.
 *
 * Capped at `REAL_ROOT_CACHE_MAX` entries with LRU eviction so a
 * long-running daemon that sees a churning set of project paths (renames,
 * temp project creations, fuzzed paths) doesn't grow this map unbounded.
 * Realistic ceiling is ~50-100 active projects per host; 256 is a 2-3×
 * comfort margin over any sane workload.
 */
const REAL_ROOT_CACHE_MAX = 256;
const realRootCache = new Map<string, string>();

function getRealRoot(projectRoot: string): string | null {
  const cached = realRootCache.get(projectRoot);
  if (cached !== undefined) {
    // Touch: move to end (LRU bump). Map preserves insertion order, so
    // delete + set re-positions this entry as most-recently-used.
    realRootCache.delete(projectRoot);
    realRootCache.set(projectRoot, cached);
    return cached;
  }
  try {
    const real = realpathSync(projectRoot);
    if (realRootCache.size >= REAL_ROOT_CACHE_MAX) {
      // Evict the least-recently-used entry (the first one in insertion order).
      const firstKey = realRootCache.keys().next().value;
      if (firstKey !== undefined) realRootCache.delete(firstKey);
    }
    realRootCache.set(projectRoot, real);
    return real;
  } catch {
    return null;
  }
}

/**
 * `realpath` walks up the path until it finds an existing prefix, then
 * re-appends the (still-non-existent) tail. Without this, a symlink check on
 * a missing file would always throw ENOENT and we'd lose the symlink-escape
 * defence on the partial-prefix component.
 */
function deepRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    const parent = path.dirname(p);
    /* v8 ignore next — root is always realpath-able once cached, so the
       recursion always finds a base case before reaching `/`. */
    if (parent === p) throw err;
    const base = path.basename(p);
    return path.join(deepRealpath(parent), base);
  }
}

/**
 * Map the `FsErrorCode` values that `resolveSafePath` emits for the listing
 * flow onto the read-flow's narrower / different-named set. Centralising the
 * mapping keeps `readProjectFile` itself readable.
 */
function mapResolveError(
  code: FsErrorCode,
): "fs_no_project_path" | "fs_path_outside_project" {
  if (code === "fs_no_path") return "fs_no_project_path";
  // fs_invalid_path (absolute / NUL byte) and fs_path_outside_root (escape via
  // ..) both land on fs_path_outside_project — the read flow doesn't need to
  // distinguish "you tried an absolute path" from "you tried `..` traversal".
  return "fs_path_outside_project";
}

/**
 * Read a UTF-8 text file inside `projectRoot`. Returns a discriminated
 * result envelope; never throws. See the section header above for the full
 * security contract.
 */
export async function readProjectFile(
  projectRoot: string,
  relPath: string,
): Promise<FsReadResult> {
  if (!projectRoot) {
    return {
      ok: false,
      error_code: "fs_no_project_path",
      message: "no project path configured",
    };
  }
  if (relPath === undefined || relPath === null || relPath === "") {
    return {
      ok: false,
      error_code: "fs_missing_path",
      message: "path query parameter is required",
    };
  }

  // Defence-in-depth: URL-decode against double-encoded smuggling. Hono has
  // already URL-decoded the query string once; this catches an attacker who
  // sent `%252e%252e%252fetc%252fpasswd` (which decodes once to
  // `%2e%2e%2fetc%2fpasswd` and then to `../etc/passwd`).
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return {
      ok: false,
      error_code: "fs_path_outside_project",
      message: "malformed path encoding",
    };
  }

  // Prefix-check via the existing helper (handles absolute / NUL / `..`).
  const safe = resolveSafePath(projectRoot, decoded);
  if (!safe.ok) {
    return {
      ok: false,
      error_code: mapResolveError(safe.error_code),
      message: safe.message,
    };
  }

  // Symlink-escape check. We canonicalise both the project root and the
  // resolved absolute path; the canonical path MUST still sit under the
  // canonical root or one of its sub-paths.
  const realRoot = getRealRoot(projectRoot);
  if (realRoot === null) {
    /* v8 ignore next 5 — projectRoot comes from the DB row's `path` column
       which is checked for existence by the route's `requirePath` guard; a
       realpath failure here means the row points at a now-missing directory,
       which is an operator-visible config issue rather than a request-level
       failure. */
    return {
      ok: false,
      error_code: "fs_no_project_path",
      message: "project root cannot be resolved",
    };
  }
  let canonical: string;
  try {
    canonical = deepRealpath(safe.absolute);
  } catch (err) {
    /* v8 ignore next 6 — deepRealpath swallows ENOENT/ENOTDIR by walking up;
       the only way out is a non-ENOENT errno (EACCES, ELOOP, ENAMETOOLONG)
       which we surface as fs_io_error so the operator sees the real cause. */
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "realpath failed",
    };
  }
  if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
    return {
      ok: false,
      error_code: "fs_path_outside_project",
      message: "path escapes project root via symlink",
    };
  }

  // Stat — distinguishes ENOENT (404-equivalent) from genuine I/O failures
  // and lets us refuse oversize reads before allocating a buffer.
  let stat;
  try {
    stat = await fs.stat(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        error_code: "fs_not_found",
        message: "file does not exist",
      };
    }
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "stat failed",
    };
  }
  if (stat.isDirectory()) {
    // The route is /fs/file — a directory under the path is a 404 from the
    // file-read perspective, not a 200 listing. Mirror the spec rather than
    // surface a separate fs_not_a_directory code only readers would consult.
    return {
      ok: false,
      error_code: "fs_not_found",
      message: "path is a directory, not a file",
    };
  }
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: false,
      error_code: "fs_too_large",
      message: `file is ${stat.size} bytes; ${MAX_READ_BYTES}-byte cap exceeded`,
    };
  }

  // Read whole-file. Range support comes in M04 slice 03; for now the size
  // check above is the only ceiling.
  let buf: Buffer;
  try {
    buf = await fs.readFile(canonical);
  } catch (err) {
    /* v8 ignore next 8 — between stat and readFile the file could be
       deleted (TOCTOU); the resulting ENOENT is mapped here for parity
       with the stat branch. Other errno values (EACCES, EIO) collapse to
       fs_io_error. */
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, error_code: "fs_not_found", message: "file disappeared" };
    }
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "read failed",
    };
  }

  // Binary detection: a single NUL byte in the first 4096 bytes is the same
  // heuristic git uses (`buffer_is_binary`). It's cheap, correct for the vast
  // majority of source files, and avoids forcing the UI to render a UTF-8
  // mojibake stream of binary content.
  const sniffEnd = Math.min(BINARY_SNIFF_BYTES, buf.length);
  for (let i = 0; i < sniffEnd; i += 1) {
    if (buf[i] === 0) {
      return {
        ok: false,
        error_code: "fs_binary",
        message: "file appears to be binary",
      };
    }
  }

  const sha = createHash("sha256").update(buf).digest("hex");
  return {
    ok: true,
    content: buf.toString("utf-8"),
    sha,
    mtime: stat.mtimeMs,
    size: stat.size,
    encoding: "utf-8",
  };
}

/**
 * Reset the realpath cache. Test-only — exported under a `__` prefix so the
 * production runtime never reaches for it. Tests that move a project root
 * between cases need to invalidate the cache to avoid cross-test bleed.
 */
export function __resetRealRootCacheForTests(): void {
  realRootCache.clear();
  fileWriteLocks.clear();
}

// ─── writeProjectFile ──────────────────────────────────────────────────────
//
// Write a single text file rooted in `projectRoot` with optimistic-concurrency
// control: the caller proves it's writing on top of a known on-disk version
// by passing the SHA-256 it last read; mismatch → `fs_sha_conflict` and the
// write is refused. Returns a discriminated `{ ok, ... }` envelope; never
// throws.
//
// Defence-in-depth invariants — every write flows through ALL of these:
//
//   1. **Path jail.** Same `resolveSafePath` prefix check that gates the read
//      path. Absolute / NUL / `..` / outside-root inputs are rejected with
//      `fs_path_outside_project` before we ever touch the FS.
//   2. **Body cap.** `Buffer.byteLength(content, 'utf-8')` is checked against
//      `MAX_READ_BYTES` (2 MiB) BEFORE we open any handle. The route layer
//      duplicates the check via a Zod `max(MAX_READ_BYTES)` schema, but the
//      service-layer guard means the invariant is preserved even when callers
//      bypass the route (e.g. internal background tasks).
//   3. **Sha-check + atomic rename inside a per-file lock.** Two writers that
//      both read sha-X and try to overwrite at the same time would, without
//      a lock, both pass the sha-check and both succeed — the second rename
//      silently destroys the first writer's work. We hold a process-local
//      mutex keyed on `(projectRoot, relPath)` across the entire
//      check-then-rename critical section so the operation is linearisable.
//      This does NOT defend against a SECOND flockctl process writing the
//      same file — single-daemon-per-project is the documented assumption
//      for v1, matching the rest of the audit-log + scheduler design.
//   4. **Atomic write.** Content lands in a sibling temp file
//      (`<absolute>.flockctl-tmp-<uuid>`) and is committed via `fs.rename`,
//      which is atomic on a single POSIX filesystem. Any failure mid-write
//      unlinks the temp before returning so an ENOSPC / EACCES partial
//      write cannot leave stale temp files on disk.
//   5. **Re-stat after rename.** The returned `mtime` / `size` are stat'd
//      from the file at `absolute` AFTER the rename completes, so the caller
//      can use the returned `sha` as the next round-trip's `expectedSha`
//      without a separate read.

/**
 * Discriminated return type for `writeProjectFile`. Mirrors the read-side
 * shape (`FsReadResult`) so route handlers can use the same `result.ok`
 * narrowing. The failure variant carries an extra `currentSha` field
 * specifically for the `fs_sha_conflict` case so the UI can show a precise
 * "your version was X, current is Y" diff prompt without a follow-up read.
 */
export type FsWriteSuccess = {
  ok: true;
  sha: string;
  mtime: number;
  size: number;
};

export type FsWriteFailure = {
  ok: false;
  error_code: FsErrorCode;
  message?: string;
  /**
   * Current sha-256 of the file at `relPath`. Only set on `fs_sha_conflict`;
   * empty string when the file does not exist (caller passed a non-empty
   * `expectedSha` against a missing file). `undefined` for every other
   * failure mode (path jail, oversize, I/O error).
   */
  currentSha?: string;
};

export type FsWriteResult = FsWriteSuccess | FsWriteFailure;

/**
 * Per-file in-process lock table. The key is `<projectRoot>::<relPath>` so
 * two routes targeting the same file across different projects never block
 * each other, but two writes against the same `(project, file)` pair are
 * strictly serialised. The lock is released by chaining a `.finally()` onto
 * the stored promise — the next caller awaits the previous one before
 * starting its own check-then-rename critical section.
 */
const fileWriteLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileWriteLocks.get(key) ?? Promise.resolve();
  // The new entry awaits the previous holder before running `fn`. We swallow
  // the prior promise's rejection so a thrown error in one writer does not
  // poison the lock chain for the next.
  const next = previous.catch(() => undefined).then(() => fn());
  fileWriteLocks.set(key, next);
  try {
    return await next;
  } finally {
    // Only clear if we're still the latest holder — otherwise a faster
    // caller may have already chained on top of us.
    if (fileWriteLocks.get(key) === next) {
      fileWriteLocks.delete(key);
    }
  }
}

/**
 * Compute the sha-256 of the file at `absolute`, or `null` if it does not
 * exist. Throws on every other I/O error so the caller can map it onto
 * `fs_io_error`. We deliberately re-read the bytes (rather than caching the
 * sha computed at write time) because between the writer's `expectedSha`
 * and our check, an external process may have replaced the file.
 */
async function shaOfFileOrNull(absolute: string): Promise<string | null> {
  try {
    // Stream-hash so a 50 MiB read-modify-write conflict check holds only
    // ~64 KiB at a time instead of slurping the whole file. Mirrors the
    // existing `computeFileSha` (line ~1483); we cannot just call that
    // helper because it throws on ENOENT and we need to map that to
    // `null` here. Catch ENOENT/ENOTDIR explicitly and return `null`;
    // every other error propagates so the caller maps to `fs_io_error`.
    return await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(absolute);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", (err) => {
        stream.destroy();
        reject(err);
      });
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Write `content` to `relPath` under `projectRoot`, refusing to overwrite
 * unless the on-disk SHA-256 matches `expectedSha` at the moment of the
 * write (read-modify-write linearisability). Pass `expectedSha = ""` plus
 * `opts.allowCreate = true` to permit creating a new file; any other
 * mismatch — including "file did not exist" without `allowCreate` — is
 * surfaced as `fs_sha_conflict`.
 *
 * On success returns the post-rename sha so the caller can use it as the
 * next round-trip's `expectedSha` without an extra read. The returned
 * `mtime` / `size` are stat'd from the renamed file, not the temp.
 *
 * Concurrency contract: per-file linearisable across the same process.
 * Cross-process safety relies on the documented single-daemon-per-project
 * assumption (see module header).
 */
export async function writeProjectFile(
  projectRoot: string,
  relPath: string,
  content: string,
  expectedSha: string,
  opts: { allowCreate?: boolean } = {},
): Promise<FsWriteResult> {
  if (!projectRoot) {
    return {
      ok: false,
      error_code: "fs_no_project_path",
      message: "no project path configured",
    };
  }
  if (relPath === undefined || relPath === null || relPath === "") {
    return {
      ok: false,
      error_code: "fs_missing_path",
      message: "path query parameter is required",
    };
  }

  // Path jail — reuses the read-side helper so the rejection set (absolute,
  // NUL, traversal, outside-root) is identical between read and write.
  const safe = resolveSafePath(projectRoot, relPath);
  if (!safe.ok) {
    return {
      ok: false,
      error_code: mapResolveError(safe.error_code),
      message: safe.message,
    };
  }

  // Body cap. We measure the utf-8 byte length BEFORE allocating the temp
  // file or touching the lock table — an oversize payload should fail fast
  // and never block another writer waiting on the same lock.
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_READ_BYTES) {
    return {
      ok: false,
      error_code: "fs_too_large",
      message: `payload is ${bytes} bytes; ${MAX_READ_BYTES}-byte cap exceeded`,
    };
  }

  const absolute = safe.absolute;
  const allowCreate = opts.allowCreate === true;
  const lockKey = `${path.resolve(projectRoot)}::${safe.relative}`;

  return withFileLock(lockKey, async () => {
    // Re-check sha INSIDE the lock so concurrent writers serialised through
    // here see each other's renames. The earlier (pre-lock) check would race.
    let currentSha: string | null;
    try {
      currentSha = await shaOfFileOrNull(absolute);
    } catch (err) {
      return {
        ok: false,
        error_code: "fs_io_error",
        message: (err as Error).message ?? "stat-for-sha failed",
      };
    }

    if (currentSha === null) {
      // File does not exist. Allowed iff caller passed `expectedSha=""`
      // AND `allowCreate=true` — anything else is a conflict the caller
      // must resolve (either by reading the new state or opting in to
      // create).
      if (!(expectedSha === "" && allowCreate)) {
        return {
          ok: false,
          error_code: "fs_sha_conflict",
          message: "file does not exist",
          currentSha: "",
        };
      }
    } else if (currentSha !== expectedSha) {
      return {
        ok: false,
        error_code: "fs_sha_conflict",
        message: "on-disk sha does not match expectedSha",
        currentSha,
      };
    }

    // Atomic write: tempfile sibling + rename. The sibling lives in the same
    // directory so the rename is on the same filesystem (cross-fs renames
    // are NOT atomic on POSIX). The temp suffix is randomUUID() so two
    // racing creates don't collide.
    const tempPath = `${absolute}.flockctl-tmp-${randomUUID()}`;

    // Ensure the parent directory exists. We accept the small O(1) stat
    // cost to surface a clear ENOENT error_code (fs_not_found) instead of
    // an opaque "writeFile: ENOENT, open '<temp>'" stack trace.
    const parent = path.dirname(absolute);
    try {
      const st = await fs.stat(parent);
      if (!st.isDirectory()) {
        return {
          ok: false,
          error_code: "fs_not_found",
          message: "parent path is not a directory",
        };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          ok: false,
          error_code: "fs_not_found",
          message: "parent directory does not exist",
        };
      }
      return {
        ok: false,
        error_code: "fs_io_error",
        message: (err as Error).message ?? "parent stat failed",
      };
    }

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8" });
    } catch (err) {
      // Best-effort cleanup — the temp may not exist if the writeFile
      // failed before opening, in which case unlink will EBUSY/ENOENT.
      await fs.unlink(tempPath).catch(() => undefined);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EACCES" || e.code === "EPERM") {
        return {
          ok: false,
          error_code: "fs_permission_denied",
          message: e.message ?? "write permission denied",
        };
      }
      return {
        ok: false,
        error_code: "fs_io_error",
        message: e.message ?? "write failed",
      };
    }

    try {
      await fs.rename(tempPath, absolute);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => undefined);
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        error_code: "fs_io_error",
        message: e.message ?? "rename failed",
      };
    }

    // Post-rename: re-stat from the file at `absolute` so the caller's
    // next-write `expectedSha` matches what's actually on disk. The sha is
    // computed from the bytes we held in memory (NOT a re-read) because
    // between our rename and the re-read another writer could have raced
    // through the same lock — for the post-rename receipt we want the sha
    // of OUR content, which is what we just persisted.
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (err) {
      return {
        ok: false,
        error_code: "fs_io_error",
        message: (err as Error).message ?? "post-rename stat failed",
      };
    }
    const sha = createHash("sha256").update(content).digest("hex");
    return {
      ok: true,
      sha,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  });
}

// ─── FS mutations ──────────────────────────────────────────────────────────
//
// Mutation helpers backing `POST /:id/fs/op` (mkdir / create / rename /
// delete). All four share the read-flow's defence-in-depth invariants:
//
//   1. **Path jail.** Every relative path goes through `resolveSafePath`,
//      which catches absolute paths, NUL bytes, and `..` traversal before any
//      `fs.*` syscall is issued.
//   2. **Always-protected paths.** `.git`, anything starting with `.git/`,
//      and a top-level `node_modules` are refused with `fs_invalid_name`.
//      The intent is "no API surface can ever delete the repo's git
//      metadata" — operators who genuinely want to do this can use a
//      terminal. The check sits ABOVE the FS call so a `delete recursive`
//      against `.git` never even attempts an `fs.rm`.
//   3. **Discriminated outcomes.** Same `{ ok: true }` / `{ ok: false,
//      error_code, message? }` shape as the read flow — the route handler
//      projects the result onto a single audit row and an HTTP-200 response
//      regardless of which branch fired.
//
// Every mutation is intended to be safe to call from an in-flight chat /
// task: the route handler is responsible for the audit row, this layer
// guarantees no syscalls run with a path that escapes the entity root.

/** Hard upper bound on how many bytes we accept in a `create` body. Aligned
 *  with the read flow's MAX_READ_BYTES (2 MiB) so a file we just wrote can
 *  immediately be read back without tripping `fs_too_large`. */
export const MAX_CREATE_BYTES = MAX_READ_BYTES;

export type FsMutateSuccess = { ok: true };
export type FsMutateFailure = {
  ok: false;
  error_code: FsErrorCode;
  message?: string;
};
export type FsMutateResult = FsMutateSuccess | FsMutateFailure;

/**
 * Shared pre-flight gates for every mutating `*InRoot` helper. Returns
 * `null` when the path is acceptable; otherwise returns the same
 * `FsMutateFailure` envelope the callers used to inline. The `verb`
 * controls only the "cannot {verb} root" message, so the four mutators
 * stay byte-identical on the wire.
 */
function rejectRootOrProtected(
  safeRelative: string,
  verb: "create" | "rename" | "delete",
): FsMutateFailure | null {
  if (safeRelative === ".") {
    return {
      ok: false,
      error_code: "fs_invalid_name",
      message: `cannot ${verb} root`,
    };
  }
  if (isProtectedRelative(safeRelative)) {
    return {
      ok: false,
      error_code: "fs_invalid_name",
      message: "path is protected",
    };
  }
  return null;
}

/**
 * Reject paths that would touch always-protected on-disk locations.
 *
 * Intentional list:
 *   - `.git` exactly                 — refusing to nuke the repo metadata.
 *   - paths starting with `.git/`    — same, but for nested entries.
 *   - top-level `node_modules`       — refusing to nuke the install tree
 *                                      via the API. Sub-paths under
 *                                      `node_modules/...` are NOT blocked
 *                                      (a nested package's stray file is
 *                                      not catastrophic).
 *
 * Operates on the canonicalised relative path (`safe.relative` from
 * `resolveSafePath`), which uses POSIX-style separators after Node's
 * `path.relative` collapses any leading `./` and platform separators.
 */
function isProtectedRelative(rel: string): boolean {
  // resolveSafePath returns "." for the root itself; treat that as not
  // protected here (the per-op handler checks "cannot delete root").
  if (rel === "." || rel === "") return false;
  // Normalise to POSIX so `\` on a hypothetical future Windows host (we
  // don't support Windows, but a defensive check costs nothing) is treated
  // identically to `/`.
  const norm = rel.replace(/\\/g, "/");
  if (norm === ".git" || norm.startsWith(".git/")) return true;
  if (norm === "node_modules") return true;
  return false;
}

/**
 * Generic errno → FsErrorCode mapper for the mutation flow. Wider surface
 * than `mapFsError` (which is tuned for the listing flow): mutations can
 * additionally surface EEXIST / ENOTEMPTY / EISDIR / ENOTDIR.
 */
function mapMutateError(err: unknown, op: string): FsMutateFailure {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return { ok: false, error_code: "fs_not_found", message: `${op}: not found` };
  }
  if (e?.code === "EEXIST") {
    return {
      ok: false,
      error_code: "fs_already_exists",
      message: `${op}: target already exists`,
    };
  }
  if (e?.code === "ENOTEMPTY") {
    return {
      ok: false,
      error_code: "fs_not_empty",
      message: `${op}: directory is not empty`,
    };
  }
  if (e?.code === "ENOTDIR" || e?.code === "EISDIR") {
    return {
      ok: false,
      error_code: "fs_not_a_directory",
      message: `${op}: ${e.code?.toLowerCase()}`,
    };
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") {
    return {
      ok: false,
      error_code: "fs_permission_denied",
      message: `${op}: permission denied`,
    };
  }
  if (
    e?.code === "ENAMETOOLONG" ||
    e?.code === "ELOOP" ||
    e?.code === "EINVAL"
  ) {
    return {
      ok: false,
      error_code: "fs_invalid_path",
      message: `${op}: ${e.code?.toLowerCase()}`,
    };
  }
  return {
    ok: false,
    error_code: "fs_internal_error",
    message: e?.message || `${op}: failed`,
  };
}

/**
 * Create a directory at `relPath` inside `root`. Non-recursive — the parent
 * MUST already exist (matches the UI's "right-click → New folder" UX where
 * the user is always operating inside a visible parent). Returns
 * `fs_already_exists` if the path is already a file or directory.
 */
export async function mkdirInRoot(
  root: string,
  relPath: string,
): Promise<FsMutateResult> {
  if (!root) {
    return { ok: false, error_code: "fs_no_path", message: "no root configured" };
  }
  const safe = resolveSafePath(root, relPath);
  if (!safe.ok) return safe;
  const rejection = rejectRootOrProtected(safe.relative, "create");
  if (rejection) return rejection;
  try {
    await fs.mkdir(safe.absolute, { recursive: false });
  } catch (err) {
    return mapMutateError(err, "mkdir");
  }
  return { ok: true };
}

/**
 * Create a file at `relPath` inside `root` with optional `content`. Refuses
 * to overwrite an existing file (use the future write/edit endpoint for
 * that). The write goes through `wx` (open-exclusive-write) so the kernel
 * itself enforces the no-overwrite invariant atomically — there is no
 * stat-then-write TOCTOU race.
 */
export async function createFileInRoot(
  root: string,
  relPath: string,
  content?: string,
): Promise<FsMutateResult> {
  if (!root) {
    return { ok: false, error_code: "fs_no_path", message: "no root configured" };
  }
  const body = content ?? "";
  if (Buffer.byteLength(body, "utf-8") > MAX_CREATE_BYTES) {
    return {
      ok: false,
      error_code: "fs_too_large",
      message: `content exceeds ${MAX_CREATE_BYTES}-byte cap`,
    };
  }
  const safe = resolveSafePath(root, relPath);
  if (!safe.ok) return safe;
  const rejection = rejectRootOrProtected(safe.relative, "create");
  if (rejection) return rejection;
  // `wx`: write, fail if exists. Kernel-atomic — no TOCTOU window between a
  // pre-flight `stat` and the actual write.
  try {
    await fs.writeFile(safe.absolute, body, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    return mapMutateError(err, "create");
  }
  return { ok: true };
}

/**
 * Rename / move a file or directory inside `root`. Both `from` and `to` are
 * jailed against the entity root; either side touching `.git` (or
 * top-level `node_modules`) is refused. The pre-flight existence check on
 * `to` is the contract — `fs.rename` would otherwise atomically replace an
 * existing target on POSIX.
 */
export async function renameInRoot(
  root: string,
  fromRel: string,
  toRel: string,
): Promise<FsMutateResult> {
  if (!root) {
    return { ok: false, error_code: "fs_no_path", message: "no root configured" };
  }
  const safeFrom = resolveSafePath(root, fromRel);
  if (!safeFrom.ok) return safeFrom;
  const safeTo = resolveSafePath(root, toRel);
  if (!safeTo.ok) return safeTo;

  // Both sides of the rename go through the same protect-root gate. The
  // `from` check fires first so "cannot rename root" wins over a destination
  // that also happens to land on the root — the operator-meaningful error is
  // "you tried to rename the root", regardless of which side they picked.
  const rejectionFrom = rejectRootOrProtected(safeFrom.relative, "rename");
  if (rejectionFrom) return rejectionFrom;
  const rejectionTo = rejectRootOrProtected(safeTo.relative, "rename");
  if (rejectionTo) return rejectionTo;

  // Pre-flight: if `to` exists, refuse rather than letting `fs.rename`
  // overwrite it. `lstat` (not `stat`) deliberately catches a symlink
  // sitting at `to` — a refusal there is correct (it counts as "exists")
  // and we never follow the link to learn what it points at.
  try {
    await fs.lstat(safeTo.absolute);
    return {
      ok: false,
      error_code: "fs_already_exists",
      message: "target already exists",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return mapMutateError(err, "rename");
    // ENOENT — good, target is free.
  }

  try {
    await fs.rename(safeFrom.absolute, safeTo.absolute);
  } catch (err) {
    return mapMutateError(err, "rename");
  }
  return { ok: true };
}

/**
 * Delete a file or directory at `relPath` inside `root`. Default
 * non-recursive: a non-empty directory returns `fs_not_empty` rather than
 * silently succeeding. Pass `recursive: true` to opt into a deep remove —
 * still constrained to entries under the entity root (the path-jail check
 * runs first), and still refused for `.git` / top-level `node_modules`.
 */
export async function deleteInRoot(
  root: string,
  relPath: string,
  opts: { recursive?: boolean } = {},
): Promise<FsMutateResult> {
  if (!root) {
    return { ok: false, error_code: "fs_no_path", message: "no root configured" };
  }
  const safe = resolveSafePath(root, relPath);
  if (!safe.ok) return safe;
  const rejection = rejectRootOrProtected(safe.relative, "delete");
  if (rejection) return rejection;

  const recursive = opts.recursive === true;

  // `lstat` (not `stat`): we do NOT follow symlinks here. Deleting a
  // symlink-to-directory should remove the link, not the target. `fs.rm`
  // honours that by default; this lstat is purely so we can enforce the
  // "non-empty without recursive" rule without resolving the symlink.
  let stat;
  try {
    stat = await fs.lstat(safe.absolute);
  } catch (err) {
    return mapMutateError(err, "delete");
  }

  // Directory branch: `fs.rm({ recursive: false })` throws EISDIR on a
  // directory regardless of whether it's empty, so the empty case routes
  // through `fs.rmdir` instead. The pre-flight readdir gives us a clean
  // `fs_not_empty` discriminator without relying on errno mapping.
  if (stat.isDirectory()) {
    if (!recursive) {
      let entries: string[];
      try {
        entries = await fs.readdir(safe.absolute);
      } catch (err) {
        return mapMutateError(err, "delete");
      }
      if (entries.length > 0) {
        return {
          ok: false,
          error_code: "fs_not_empty",
          message: "directory is not empty",
        };
      }
      try {
        await fs.rmdir(safe.absolute);
      } catch (err) {
        return mapMutateError(err, "delete");
      }
      return { ok: true };
    }
    try {
      await fs.rm(safe.absolute, { recursive: true, force: false });
    } catch (err) {
      return mapMutateError(err, "delete");
    }
    return { ok: true };
  }

  // File / symlink branch: `force: false` so a TOCTOU-disappearing target
  // surfaces ENOENT here instead of being silently swallowed by `fs.rm`'s
  // default `force=true`.
  try {
    await fs.rm(safe.absolute, { recursive: false, force: false });
  } catch (err) {
    return mapMutateError(err, "delete");
  }
  return { ok: true };
}

// ─── readProjectFileRange ──────────────────────────────────────────────────
//
// Partial-slice reader. Same path-jail guarantees as `readProjectFile`, but
// instead of refusing files larger than 2 MiB outright, the caller picks the
// `[offset, offset+length)` window they want and we open the file just long
// enough to fill that window. Use case: the UI's code editor opening a 50 MiB
// log file at line ~1.2M without dragging the daemon's RSS up by 50 MiB.
//
// Two design points worth pinning here because they look like bugs from the
// outside:
//
//   1. **`sha` is computed over the WHOLE file** — not the slice. The sha is
//      really an identity token: it lets a future "save" that started life
//      as a partial open prove that the file the operator was editing
//      against is still the file on disk. A slice-only hash would be
//      ambiguous (two different files can collide on a 64 KiB chunk). Cost:
//      one full read of the file purely for hashing. v1 accepts that; if a
//      multi-GB file ever blocks the event loop here, v2 caches sha+mtime
//      keyed on inode and skips the rehash on cache hits.
//   2. **`fs_too_large` is NOT the gate** here. The 2 MiB whole-file ceiling
//      lives only on the non-ranged path. Range reads accept files up to
//      whatever your filesystem exposes; the only ceiling is the slice cap
//      (`RANGE_SLICE_CAP`, 1 MiB) on `length`, so the buffer we allocate for
//      the response stays bounded regardless of file size.

/** Maximum slice size returned by a single range read. 1 MiB. */
export const RANGE_SLICE_CAP = 1 * 1024 * 1024;

export interface FsRangeReadOptions {
  /** Byte offset to start reading from. Must be a non-negative integer ≤ totalSize. */
  offset: number;
  /**
   * Number of bytes to read. If omitted, reads from `offset` to either EOF or
   * `RANGE_SLICE_CAP` bytes — whichever is smaller. Must be a positive
   * integer ≤ `RANGE_SLICE_CAP` when provided.
   */
  length?: number;
}

export type FsRangeReadSuccess = {
  ok: true;
  /** UTF-8 decoding of the slice. Boundary bytes that fall inside a multi-byte sequence become U+FFFD. */
  content: string;
  /** SHA-256 of the WHOLE file (see section header for rationale). */
  sha: string;
  mtime: number;
  /** Total file size in bytes — the denominator the UI uses for "you're 2% in". */
  totalSize: number;
  /** Echo of the actual window served, post-clamping. `length` may be ≤ requested. */
  range: { offset: number; length: number };
  /** Always `true` on this surface — distinguishes the partial response shape from the whole-file one. */
  partial: true;
  encoding: "utf-8";
};

export type FsRangeReadResult = FsRangeReadSuccess | FsReadFailure;

/**
 * Resolve a request-supplied relative path to a canonical absolute path
 * + `Stats` snapshot, applying every defence the read flow needs (decode,
 * jail, symlink-escape, stat). The body is intentionally a copy of the
 * pre-flight that lives inline inside `readProjectFile`; centralising the
 * helper here lets the range reader share the same security contract
 * without touching the existing read path (which has wide test coverage we
 * don't want to risk perturbing).
 */
async function resolveReadablePath(
  projectRoot: string,
  relPath: string,
): Promise<
  | { ok: true; canonical: string; stat: Stats }
  | FsReadFailure
> {
  if (!projectRoot) {
    return {
      ok: false,
      error_code: "fs_no_project_path",
      message: "no project path configured",
    };
  }
  if (relPath === undefined || relPath === null || relPath === "") {
    return {
      ok: false,
      error_code: "fs_missing_path",
      message: "path query parameter is required",
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return {
      ok: false,
      error_code: "fs_path_outside_project",
      message: "malformed path encoding",
    };
  }

  const safe = resolveSafePath(projectRoot, decoded);
  if (!safe.ok) {
    return {
      ok: false,
      error_code: mapResolveError(safe.error_code),
      message: safe.message,
    };
  }

  const realRoot = getRealRoot(projectRoot);
  if (realRoot === null) {
    /* v8 ignore next 5 — see same-shaped guard in readProjectFile. */
    return {
      ok: false,
      error_code: "fs_no_project_path",
      message: "project root cannot be resolved",
    };
  }
  let canonical: string;
  try {
    canonical = deepRealpath(safe.absolute);
  } catch (err) {
    /* v8 ignore next 5 — see same-shaped guard in readProjectFile. */
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "realpath failed",
    };
  }
  if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
    return {
      ok: false,
      error_code: "fs_path_outside_project",
      message: "path escapes project root via symlink",
    };
  }

  let st: Stats;
  try {
    st = await fs.stat(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        error_code: "fs_not_found",
        message: "file does not exist",
      };
    }
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "stat failed",
    };
  }
  if (st.isDirectory()) {
    return {
      ok: false,
      error_code: "fs_not_found",
      message: "path is a directory, not a file",
    };
  }

  return { ok: true, canonical, stat: st };
}

/**
 * Stream a file through SHA-256 without buffering the whole thing. Used by
 * `readProjectFileRange` so we can hash a 50 MiB file while only holding the
 * 64 KiB Node default-chunk buffer in memory at any point.
 */
async function computeFileSha(absolute: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    /* v8 ignore start — stream errors on a file we just stat'ed are EACCES /
       EIO territory; the caller maps to fs_io_error. The success path is
       what the integration tests cover. `stream.destroy()` is the explicit
       teardown — `createReadStream`'s default behaviour leaves the FD open
       on error in some Node versions, so we close defensively before
       rejecting. */
    stream.on("error", (err) => {
      stream.destroy();
      reject(err);
    });
    /* v8 ignore stop */
  });
}

/**
 * Read a `[offset, offset+length)` window of `relPath` inside `projectRoot`.
 *
 * Validation order matters: range params are validated BEFORE the path-jail /
 * stat work because (a) it lets a malformed range fail without touching the
 * filesystem at all and (b) it keeps the audit row's error_code stable
 * regardless of whether the path also happened to be invalid.
 */
export async function readProjectFileRange(
  projectRoot: string,
  relPath: string,
  opts: FsRangeReadOptions,
): Promise<FsRangeReadResult> {
  const { offset } = opts;
  const requestedLength = opts.length;

  // Range param validation — keep the gates explicit so a future refactor
  // can't silently accept negative lengths via type-coercion.
  if (
    typeof offset !== "number" ||
    !Number.isFinite(offset) ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return {
      ok: false,
      error_code: "fs_invalid_range",
      message: "offset must be a non-negative integer",
    };
  }
  if (requestedLength !== undefined) {
    if (
      typeof requestedLength !== "number" ||
      !Number.isFinite(requestedLength) ||
      !Number.isInteger(requestedLength) ||
      requestedLength <= 0
    ) {
      return {
        ok: false,
        error_code: "fs_invalid_range",
        message: "length must be a positive integer",
      };
    }
    if (requestedLength > RANGE_SLICE_CAP) {
      return {
        ok: false,
        error_code: "fs_invalid_range",
        message: `length exceeds slice cap (${RANGE_SLICE_CAP} bytes)`,
      };
    }
  }

  const resolved = await resolveReadablePath(projectRoot, relPath);
  if (!resolved.ok) return resolved;
  const { canonical, stat: fileStat } = resolved;
  const totalSize = fileStat.size;

  if (offset > totalSize) {
    return {
      ok: false,
      error_code: "fs_invalid_range",
      message: `offset ${offset} is past end of file (${totalSize} bytes)`,
    };
  }

  // Effective slice length: min(requested-or-cap, bytes-remaining, slice-cap).
  // The request can ask for more bytes than the file holds (e.g. an always-1
  // MiB pre-fetch in the UI); we just serve what's actually there.
  const remaining = totalSize - offset;
  const desired = requestedLength ?? RANGE_SLICE_CAP;
  const effectiveLength = Math.min(desired, remaining, RANGE_SLICE_CAP);

  // Open + partial read. We deliberately use `fs.open` + `read(buffer, ...)`
  // rather than `createReadStream({ start, end })` because the partial-read
  // contract is "give me exactly these bytes, then close" — there's no
  // streaming consumer downstream to justify the stream overhead.
  let slice: Buffer;
  let handle: import("fs/promises").FileHandle;
  try {
    handle = await fs.open(canonical, "r");
  } catch (err) {
    /* v8 ignore next 8 — between resolveReadablePath's stat and this open
       the file could disappear (TOCTOU); the resulting ENOENT is mapped
       here. Other errno values (EACCES, EIO) collapse to fs_io_error. */
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, error_code: "fs_not_found", message: "file disappeared" };
    }
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "open failed",
    };
  }

  try {
    if (effectiveLength === 0) {
      slice = Buffer.alloc(0);
    } else {
      const buffer = Buffer.alloc(effectiveLength);
      const { bytesRead } = await handle.read(buffer, 0, effectiveLength, offset);
      slice = bytesRead === effectiveLength ? buffer : buffer.subarray(0, bytesRead);
    }
  } catch (err) {
    /* v8 ignore next 5 — read failures on a successfully-opened handle are
       EIO territory; the success path is exercised by the slice tests. */
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "read failed",
    };
  } finally {
    await handle.close().catch(() => undefined);
  }

  // Binary detection on the slice we actually serve. Same heuristic as the
  // whole-file path — a NUL byte in the first 4 KiB → fs_binary. We can't
  // sniff bytes we never read, so a binary file whose first NUL falls
  // outside the requested slice may slip through as ok=true with garbled
  // UTF-8; this is an acceptable degradation for ranged reads (the UI shows
  // the slice anyway, and offset=0 reads of binary files always catch it).
  const sniffEnd = Math.min(BINARY_SNIFF_BYTES, slice.length);
  for (let i = 0; i < sniffEnd; i += 1) {
    if (slice[i] === 0) {
      return {
        ok: false,
        error_code: "fs_binary",
        message: "file appears to be binary",
      };
    }
  }

  // Whole-file SHA. Streamed so a multi-MB file doesn't allocate a buffer the
  // size of the file purely to compute a hash — see section header.
  let sha: string;
  try {
    sha = await computeFileSha(canonical);
  } catch (err) {
    /* v8 ignore next 5 — file-disappears-during-hash is the only realistic
       failure here; surfaces as fs_io_error so the operator sees the real
       errno through the stderr log. */
    return {
      ok: false,
      error_code: "fs_io_error",
      message: (err as Error).message ?? "sha computation failed",
    };
  }

  return {
    ok: true,
    content: slice.toString("utf-8"),
    sha,
    mtime: fileStat.mtimeMs,
    totalSize,
    range: { offset, length: slice.length },
    partial: true,
    encoding: "utf-8",
  };
}

// ─── indexProjectPaths ─────────────────────────────────────────────────────
//
// Whole-tree flat path enumeration backing the `GET /:id/fs/index` endpoint.
// Returns every non-ignored, non-`.git` FILE path under `projectRoot` (relative,
// POSIX-separated), capped at `INDEX_PATH_CAP` entries with a `truncated` flag
// so the UI can render a "results truncated" banner without a separate code.
//
// Why a flat list at all: the UI's quick-open / fuzzy-finder needs O(N) lookup
// across all files in the project. The per-directory `listProjectDir` is great
// for tree expansion but pessimal when the user wants to jump to a file two
// levels deep — they'd have to expand each ancestor first. The index endpoint
// is the cheap "give me everything" companion.
//
// Two cost knobs to keep this fast on a warm cache:
//   1. **Best-effort 30-second TTL cache** keyed on `${projectRoot}::${rootMtimeMs}`.
//      Same matcher-cache philosophy as `fs-gitignore`: a tree-expand burst
//      shouldn't rebuild the index per call. The mtime is a coarse invalidator
//      — a file written deep inside a sub-tree won't bump the root's mtime,
//      but a top-level create/delete will. The 30 s ceiling means the worst
//      case for a stale index is "a file you just added in `src/foo/`
//      doesn't show up in fuzzy search for up to 30 seconds". Acceptable for
//      v1; M04's watcher-driven incremental index supersedes this.
//   2. **Skip ignored directories WITHOUT recursing into them.** The listing
//      flow already runs the `ignore` matcher on each entry; we additionally
//      avoid descending into a `node_modules` or `.git` whose entries are
//      ignored as a whole, which would otherwise dominate the walk on
//      monorepos.
export const INDEX_PATH_CAP = 50_000;
const INDEX_TTL_MS = 30_000;

interface IndexCacheEntry {
  paths: string[];
  truncated: boolean;
  expiresAt: number;
  rootMtimeMs: number;
}

// `indexCache` already had per-entry TTL but no overall size bound. A
// daemon serving a high-churn set of projects (workspace explorers,
// fuzzed paths, restart loops) would accumulate stale entries until each
// one's 30-s window elapsed. Cap the total at 64 distinct projects with
// LRU eviction — Map preserves insertion order, so delete + set on every
// hit moves the entry to the most-recently-used position.
const INDEX_CACHE_MAX = 64;
const indexCache = new Map<string, IndexCacheEntry>();

export type FsIndexSuccess = {
  ok: true;
  paths: string[];
  truncated: boolean;
};

export type FsIndexFailure = {
  ok: false;
  error_code: FsErrorCode;
  message?: string;
};

export type FsIndexResult = FsIndexSuccess | FsIndexFailure;

/**
 * Walk `projectRoot` depth-first and collect every non-ignored FILE's
 * project-relative path, capped at `INDEX_PATH_CAP`. Results are cached for
 * `INDEX_TTL_MS` keyed on `(projectRoot, rootMtimeMs)` — see the section
 * header above for the cache contract.
 *
 * Directories that the gitignore matcher classifies as ignored are NOT
 * descended into (saving the cost of e.g. enumerating a 50 k-file
 * `node_modules`). The always-on defaults from `fs-gitignore` cover `.git`
 * and `node_modules` even when the project ships without a `.gitignore`.
 */
export async function indexProjectPaths(
  projectRoot: string,
): Promise<FsIndexResult> {
  if (!projectRoot) {
    return {
      ok: false,
      error_code: "fs_no_path",
      message: "no project path configured",
    };
  }

  const absoluteRoot = path.resolve(projectRoot);

  // Stat the root once — both for cache-key composition (mtime) and to surface
  // a clean fs_not_found / fs_not_a_directory when the project's `.path`
  // points at something that doesn't exist or isn't a directory.
  let rootStat;
  try {
    rootStat = await fs.stat(absoluteRoot);
  } catch (err) {
    return mapFsError(err, "stat");
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      error_code: "fs_not_a_directory",
      message: "project root is not a directory",
    };
  }

  const now = Date.now();
  const rootMtimeMs = rootStat.mtimeMs;
  const cacheKey = absoluteRoot;
  const cached = indexCache.get(cacheKey);
  if (
    cached &&
    cached.expiresAt > now &&
    cached.rootMtimeMs === rootMtimeMs
  ) {
    // LRU bump: re-insert so this entry moves to the most-recently-used
    // tail of the Map's insertion-order iteration.
    indexCache.delete(cacheKey);
    indexCache.set(cacheKey, cached);
    return {
      ok: true,
      paths: cached.paths,
      truncated: cached.truncated,
    };
  }

  const matcher = await loadGitignoreMatcher(absoluteRoot);
  const paths: string[] = [];
  let truncated = false;

  // Iterative DFS. We push directory-relative paths onto a stack rather than
  // recursing so a 30-deep symlink loop or a nested-tens-of-thousands-of-dirs
  // monorepo doesn't blow the JS stack.
  const stack: string[] = [""];
  while (stack.length > 0) {
    if (paths.length >= INDEX_PATH_CAP) {
      truncated = true;
      break;
    }
    const rel = stack.pop()!;
    const absolute = rel === "" ? absoluteRoot : path.join(absoluteRoot, rel);

    let dirents;
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      // Permission denied / racing delete on a sub-directory: skip it. The
      // worst case is a few missing entries; the alternative — bubbling the
      // error and discarding everything we've collected — is strictly worse
      // for the fuzzy-finder use case.
      continue;
    }

    // Sort for deterministic output. Directory-first matches the listing
    // flow's ordering convention so paths that share an ancestor group
    // together in the resulting flat list.
    dirents.sort((a, b) => {
      const ad = a.isDirectory();
      const bd = b.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    for (const d of dirents) {
      if (paths.length >= INDEX_PATH_CAP) {
        truncated = true;
        break;
      }
      const erel = rel === "" ? d.name : `${rel}/${d.name}`;

      // Symlinks: classify by the dirent hint (don't follow). A symlink to a
      // directory is treated as a file path here — descending into it could
      // loop, and the index is supposed to be a flat enumeration anyway.
      if (d.isDirectory()) {
        // `ignore` matches directory patterns when the path ends with `/`.
        if (matcher.ignores(`${erel}/`)) continue;
        stack.push(erel);
        continue;
      }
      if (!d.isFile()) continue;
      if (matcher.ignores(erel)) continue;
      paths.push(erel);
    }
  }

  // Evict LRU entry before inserting if at the size cap. The Map's
  // iteration order is insertion order, so `.keys().next()` yields the
  // oldest (least-recently-used after our delete-and-reinsert hit path).
  if (indexCache.size >= INDEX_CACHE_MAX) {
    const firstKey = indexCache.keys().next().value;
    if (firstKey !== undefined) indexCache.delete(firstKey);
  }
  indexCache.set(cacheKey, {
    paths,
    truncated,
    expiresAt: now + INDEX_TTL_MS,
    rootMtimeMs,
  });

  return { ok: true, paths, truncated };
}

/**
 * Test-only: clear the in-process index cache. Mirrors the
 * `_clearGitignoreCacheForTests` posture so tests can deterministically force
 * a re-walk between fixtures without resorting to fake-timer dances.
 */
export function _clearIndexCacheForTests(): void {
  indexCache.clear();
}
