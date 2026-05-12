import { Hono } from "hono";
import { homedir } from "os";
import path from "path";
import fs from "fs/promises";
import { requireLoopback } from "../middleware/remote-auth.js";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.js";

export const fsRoutes = new Hono();

/**
 * Map an `ErrnoException` from a path-resolution / stat / readdir call to
 * an `AppError`. Returns `null` when the errno isn't one of the known
 * "this is the user's fault" codes — caller should then throw a 500.
 *
 * Centralises the three near-identical error blocks that used to live
 * inline at every fs call site below; the only thing that varies between
 * call sites is whether `EINVAL`-class codes are reachable (they're not
 * for `readdir`, since by then the path was already resolved).
 */
function mapPathErrno(e: NodeJS.ErrnoException): AppError | null {
  if (e.code === "ENOENT" || e.code === "ENOTDIR") {
    return new NotFoundError("Path");
  }
  if (e.code === "EACCES" || e.code === "EPERM") {
    return new ForbiddenError("Permission denied");
  }
  // ENAMETOOLONG: path exceeded PATH_MAX (e.g. a 5 000-char input).
  // ELOOP: too many levels of symbolic links.
  // EINVAL / ERR_INVALID_ARG_VALUE: NUL byte or other illegal input.
  if (
    e.code === "ENAMETOOLONG" ||
    e.code === "ELOOP" ||
    e.code === "EINVAL" ||
    e.code === "ERR_INVALID_ARG_VALUE" ||
    e.code === "ERR_INVALID_ARG_TYPE"
  ) {
    return new BadRequestError("Invalid path");
  }
  return null;
}

// Loopback-only gate for the entire /fs router. Filesystem browsing reveals
// the shape of the developer's $HOME, which is far more sensitive than the
// control-plane entities a remote bearer token is normally scoped for. The
// gate is intentionally additive: remoteAuth still runs globally for other
// routes; this extra middleware only applies to /fs/* and returns 403 for
// any non-localhost caller — even ones holding a valid bearer token.
fsRoutes.use("/*", requireLoopback);

const MAX_ENTRIES = 500;

function isInsideHome(p: string, home: string): boolean {
  return p === home || p.startsWith(home + path.sep);
}

// GET /fs/browse?path=<abs>&show_hidden=0|1
//
// Jail: the resolved path and its realpath (after symlink resolution) MUST
// both stay inside $HOME, otherwise the handler returns 403. This prevents
// both direct escapes (e.g. /etc) and symlink-based escapes (e.g. a dangling
// link inside $HOME pointing at /).
//
// Default path when no ?path= is provided is $HOME itself. Entries are capped
// at MAX_ENTRIES after sorting (directories first, then alphabetical).
fsRoutes.get("/browse", async (c) => {
  const rawHome = homedir();
  // Canonicalize home once. On macOS homedir() can return a path under /var
  // while realpath of any child resolves through the /var → /private/var
  // symlink — comparing the two directly would 403 legitimate lookups. We
  // keep BOTH the raw and canonical forms: the pre-realpath fast path uses
  // rawHome (cheap string check against user input), while the post-realpath
  // jail check uses canonicalHome (accurate against fs-canonical paths).
  let canonicalHome = rawHome;
  try {
    canonicalHome = await fs.realpath(rawHome);
  } catch {
    /* fall back to raw */
  }

  const query = c.req.query();

  // show_hidden is only truthy when it is the literal "1". Non-numeric or
  // missing values behave the same — hidden files stay hidden. This matches
  // the documented `0|1` contract.
  const showHidden = query.show_hidden === "1";

  const rawInput =
    typeof query.path === "string" && query.path.length > 0
      ? query.path
      : rawHome;

  // Absolute-ify the request without touching the filesystem yet.
  const resolved = path.resolve(rawInput);

  // Fast path: the resolved string itself is outside $HOME. Compare against
  // rawHome because `resolved` has not yet been canonicalized.
  if (!isInsideHome(resolved, rawHome) && !isInsideHome(resolved, canonicalHome)) {
    throw new ForbiddenError("Path is outside of $HOME");
  }

  // Follow symlinks exactly once. If realpath pops out of $HOME → 403.
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch (err) {
    const mapped = mapPathErrno(err as NodeJS.ErrnoException);
    if (mapped) throw mapped;
    throw new AppError(500, (err as Error).message || "Failed to resolve path");
  }

  // Post-realpath check uses the canonicalized home anchor.
  if (!isInsideHome(real, canonicalHome)) {
    throw new ForbiddenError("Path is outside of $HOME");
  }

  // Reject file paths early — callers must pass a directory.
  let stat;
  try {
    stat = await fs.lstat(real);
  } catch (err) {
    const mapped = mapPathErrno(err as NodeJS.ErrnoException);
    if (mapped) throw mapped;
    throw new AppError(500, (err as Error).message || "Failed to stat path");
  }
  if (!stat.isDirectory()) {
    throw new BadRequestError("Path is not a directory");
  }

  let dirents;
  try {
    dirents = await fs.readdir(real, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // readdir can't surface ENAMETOOLONG/ELOOP/EINVAL — by this point we've
    // already realpath'd. Only the EACCES/EPERM branch of mapPathErrno
    // applies. Fall through to 500 for anything else.
    if (e.code === "EACCES" || e.code === "EPERM") {
      throw new ForbiddenError("Permission denied");
    }
    throw new AppError(500, e.message || "Failed to read directory");
  }

  // lstat each entry so we can report symlinks WITHOUT following them. If an
  // entry is a symlink we still call stat() to surface whether the target is
  // a directory (useful for the UI's directory-first sort), but we do NOT
  // leak the target path — only the boolean.
  const rawEntries = await Promise.all(
    dirents.map(async (d) => {
      const isSymlink = d.isSymbolicLink();
      let isDirectory = d.isDirectory();
      if (isSymlink) {
        try {
          const s = await fs.stat(path.join(real, d.name));
          isDirectory = s.isDirectory();
        } catch {
          // Broken symlink → not a directory.
          isDirectory = false;
        }
      }
      return {
        name: d.name,
        isDirectory,
        isSymlink,
        isHidden: d.name.startsWith("."),
      };
    }),
  );

  const visible = showHidden
    ? rawEntries
    : rawEntries.filter((e) => !e.isHidden);

  // Sort FIRST, then cap at MAX_ENTRIES, so that truncation doesn't silently
  // drop top-sorted directories.
  visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const truncated = visible.length > MAX_ENTRIES;
  const entries = truncated ? visible.slice(0, MAX_ENTRIES) : visible;

  // At $HOME itself, parent is null so the UI can stop "going up".
  const parent = real === canonicalHome ? null : path.dirname(real);

  return c.json({
    path: real,
    parent,
    entries,
    truncated,
  });
});
