import fs from "fs/promises";
import path from "path";
import ignoreLib from "ignore";

/**
 * fs-gitignore — load a project's `.gitignore` once per "burst" (a tree-expand
 * sequence in the UI) and reuse the resulting matcher across every entry in
 * that burst.
 *
 * Why a TTL instead of a file-watcher: the listing endpoint runs sub-200ms
 * and is called O(N) times when the user expands a tree node — one call per
 * directory node, fanning out as they click around. Re-reading `.gitignore`
 * on every call costs ~1-3ms each but, more importantly, hits the same disk
 * sector ~10-50 times in a single tree expansion. A 1-second TTL collapses
 * those into a single read for the entire burst while still picking up edits
 * within ~1s of the user saving the file — well below the human "I changed
 * .gitignore, why isn't the tree updating" threshold.
 *
 * Always-on defaults (`.git`, `node_modules`) match the implicit rules every
 * Flockctl agent already operates under and prevent surprising "why is .git
 * showing as un-ignored" UX when a project ships without a `.gitignore`.
 */

const TTL_MS = 1000;

interface CachedMatcher {
  matcher: ReturnType<typeof ignoreLib>;
  expiresAt: number;
}

const cache = new Map<string, CachedMatcher>();

/**
 * Hard cap on cache size. The TTL alone doesn't protect against unbounded
 * growth — a daemon listing many distinct projects accumulates one entry per
 * project until the next miss happens to land inside the same key, but
 * lookups for fresh keys keep adding entries indefinitely. The cap evicts
 * the oldest entry on overflow (Map iteration is insertion-ordered).
 *
 * 256 ≈ a power user with hundreds of workspaces; far above realistic load,
 * far below the order of magnitude that would cost real memory.
 */
const CACHE_MAX = 256;

const ALWAYS_ON: string[] = [".git", "node_modules"];

function evictIfFull(): void {
  if (cache.size < CACHE_MAX) return;
  // Drop expired entries first — they're cheap and likely the bulk of the
  // overrun on a daemon that has been running for a while.
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
    if (cache.size < CACHE_MAX) return;
  }
  // Still over: drop the oldest insert.
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

/**
 * Return a configured `ignore` matcher for `projectRoot`. The matcher is
 * cached for `TTL_MS` so a sequence of `listProjectDir` calls inside the
 * same tree-expand burst share one parsed `.gitignore`. The cache key is the
 * resolved absolute path of `projectRoot` — pass the same string the listing
 * function uses for its jail check so the entries match exactly.
 *
 * If `.gitignore` is missing, ENOENT is silently ignored — the matcher only
 * carries the always-on defaults. Any other read failure is also swallowed:
 * the listing should still work even if the gitignore can't be read; the
 * worst case is a few entries that should be marked `ignored:true` are not.
 */
export async function loadGitignoreMatcher(
  projectRoot: string,
): Promise<{ ignores: (relPath: string) => boolean }> {
  const key = projectRoot;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return wrap(hit.matcher);
  }

  const matcher = ignoreLib();
  matcher.add(ALWAYS_ON);

  try {
    const txt = await fs.readFile(path.join(projectRoot, ".gitignore"), "utf-8");
    matcher.add(txt);
  } catch {
    /* ENOENT or unreadable .gitignore — fall back to always-on defaults. */
  }

  evictIfFull();
  cache.set(key, { matcher, expiresAt: now + TTL_MS });
  return wrap(matcher);
}

/**
 * Wrap the underlying `ignore` instance so callers can't accidentally mutate
 * the cached matcher (e.g. by calling `.add(...)` on the returned object,
 * which would poison the cache for every other in-flight request that shared
 * this entry).
 *
 * The `ignore` library rejects pathnames that begin with `/`, so we strip a
 * leading slash defensively — the caller passes paths relative to the
 * project root and a stray leading slash should still be matched, not
 * thrown.
 */
function wrap(
  matcher: ReturnType<typeof ignoreLib>,
): { ignores: (relPath: string) => boolean } {
  return {
    ignores(relPath: string): boolean {
      const cleaned = relPath.replace(/^\/+/, "");
      if (cleaned === "" || cleaned === ".") return false;
      try {
        return matcher.ignores(cleaned);
      } catch {
        // Malformed pattern in the user's .gitignore should NOT crash a
        // listing — return false (treat as not-ignored) and let the operator
        // notice via UI badges rather than a 500.
        return false;
      }
    },
  };
}

/**
 * Test-only: clear the in-process cache. Exposed as a named export rather
 * than a side-channel so tests can deterministically force a re-read between
 * setups without resorting to fake-timer dances.
 */
export function _clearGitignoreCacheForTests(): void {
  cache.clear();
}
