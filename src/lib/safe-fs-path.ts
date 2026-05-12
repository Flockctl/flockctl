import { resolve, isAbsolute, sep } from "path";
import { homedir } from "os";
import { ValidationError } from "./errors.js";

/**
 * Filesystem locations that no Flockctl-created workspace or project may ever
 * land in, regardless of which user requested the create. The exact list is
 * macOS- and Linux-flavoured (Windows is unsupported per CLAUDE.md rule 6).
 *
 * **Threat model.** A remote-token holder posting `{ path: "/etc/cron.d" }`
 * to `POST /workspaces` should not be able to `mkdirSync` or `git clone` into
 * privileged directories. The list below covers the well-known
 * non-user-writable Unix system roots and macOS's /System.
 *
 * **Why some plausibly-system roots are NOT blocked:**
 *   - `/var` — macOS's `tmpdir()` lives at `/var/folders/...` and Linux uses
 *     `/var/tmp` for legitimate temp paths. Blocking `/var` outright would
 *     trip every test that uses `mkdtempSync(tmpdir(), ...)` and also forbid
 *     legitimate `/var/log/myapp/*` setups. Operators willing to clobber
 *     `/var/lib/...` already have shell access.
 *   - `/private` — on macOS this is the actual location backing `/var`,
 *     `/etc`, `/tmp` symlinks. The targets are blocked individually below.
 *   - `/Applications`, `/Volumes`, `/Library`, `/opt`, `/srv` — non-system
 *     on most setups; a project there is unusual but not security-relevant.
 *
 * The check is exact-segment: `/etc` blocks `/etc` and `/etc/anything` but
 * NOT `/etcetera`. This is enforced by the `path === root || startsWith(root + sep)`
 * idiom (the `+ sep` is the critical bit — without it, a prefix-only check
 * leaks a class of bypasses, e.g. `/etc-something`).
 */
const FORBIDDEN_PATH_ROOTS = [
  "/",          // exact OS root only — joining a slug under `/` is fine
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/root",
  "/lib",
  "/lib32",
  "/lib64",
  "/System",    // macOS only — the OS bundle
];

/**
 * Validate that `inputPath` is a sane location for Flockctl to create a
 * workspace or project directory. Used by the create/adopt routes that take
 * a user-supplied `body.path` and proceed to `mkdirSync` / `git clone` into it.
 *
 * Rules:
 *  - Must be a non-empty string.
 *  - Must be absolute. We do NOT silently `path.resolve(homedir(), p)` for
 *    relative inputs — relative resolution depends on the daemon's CWD and
 *    leads to surprises (the agent-public CLAUDE.md rule 3 starts the daemon
 *    from `dist/`, but a relative path would resolve from there).
 *  - Must not contain a NUL byte (some Node FS calls would mis-throw).
 *  - Must not equal or live inside a system root from `FORBIDDEN_PATH_ROOTS`.
 *  - Special case: `/` itself is forbidden (would let a remote-token holder
 *    `git clone` directly into the OS root).
 *
 * On any violation, throws `ValidationError` so the route layer returns 400.
 *
 * Note: this guards against *accidental* misuse and against a remote-token
 * holder writing to system paths. It does NOT enforce a per-tenant boundary
 * (Flockctl is single-tenant — see security skill). Inside a user's own
 * homedir we trust them.
 */
export function assertSafeWritePath(inputPath: string): void {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new ValidationError("path must be a non-empty string");
  }
  if (inputPath.indexOf("\0") !== -1) {
    throw new ValidationError("path contains NUL byte");
  }
  if (!isAbsolute(inputPath)) {
    throw new ValidationError("path must be absolute");
  }

  const abs = resolve(inputPath);

  for (const forbidden of FORBIDDEN_PATH_ROOTS) {
    if (forbidden === "/") {
      // Block `/` itself but allow `/anything` (the per-segment roots below
      // catch the dangerous siblings). A literal `/` would be an absurd
      // location for a workspace anyway.
      if (abs === "/") {
        throw new ValidationError(`path '${inputPath}' is the OS root`);
      }
      continue;
    }
    if (abs === forbidden || abs.startsWith(forbidden + sep)) {
      throw new ValidationError(
        `path '${inputPath}' is inside the protected system directory '${forbidden}'`,
      );
    }
  }

  // Belt-and-braces: also reject paths that try to walk into the user's home
  // *and then back out* via `..`. `path.resolve` already collapsed those, so
  // the remaining check is purely informational.
  if (abs.includes(`${sep}..${sep}`) || abs.endsWith(`${sep}..`)) {
    /* v8 ignore next 2 — `path.resolve` always collapses `..` segments,
       so this branch is structurally unreachable; kept as defence-in-depth. */
    throw new ValidationError(`path '${inputPath}' contains unresolved '..' segments`);
  }
}

/**
 * Resolve a default workspace path under `~/flockctl/workspaces/<slug>`.
 * Centralised so both the workspaces route and any future "create workspace"
 * surface (e.g. CLI) compute the same fallback.
 */
export function defaultWorkspacePath(slug: string): string {
  return resolve(homedir(), "flockctl", "workspaces", slug);
}

/**
 * Resolve a default project path. If a workspace path is provided, the
 * project lands as a sibling under it; otherwise falls back to
 * `~/flockctl/projects/<slug>`.
 */
export function defaultProjectPath(slug: string, workspacePath?: string | null): string {
  if (workspacePath && workspacePath.length > 0) {
    return resolve(workspacePath, slug);
  }
  return resolve(homedir(), "flockctl", "projects", slug);
}
