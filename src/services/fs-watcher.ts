import path from "path";
import fs from "fs";
import crypto from "crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { loadGitignoreMatcher } from "./fs-gitignore.js";
import { AgentWriteTracker } from "./agent-write-tracker.js";
import { wsManager } from "./ws-manager.js";

/**
 * fs-watcher — recursively watch a project's working tree and broadcast
 * `fs.changed` frames to every WS subscriber of that project. The watcher
 * is the live counterpart to the snapshot listing produced by
 * `fs-operations.ts`: the UI fetches the initial tree once and then keeps
 * it in sync from the watcher stream.
 *
 * Why chokidar: native `fs.watch` is per-platform inconsistent (no
 * recursive on Linux, fires partial events on macOS) and doesn't expose
 * write-finish coalescing. Chokidar normalises both, plus its
 * `awaitWriteFinish` setting waits for the file size to stabilise before
 * firing — so we don't fire on the half-written byte stream of a large
 * save.
 *
 * Output frame contract (matches `ui/src/lib/hooks/fs.ts` consumer):
 *   { kind: "fs.changed", path, sha, event, source, ts }
 *
 *   - `path`     — POSIX-relative to the project root (forward slashes).
 *   - `sha`      — sha256 of file contents at debounce-end, or null on
 *                  unlink / read-failure.
 *   - `event`    — "add" | "change" | "unlink".
 *   - `source`   — "agent" if the path was tagged via AgentWriteTracker
 *                  in the last 5s, else "external".
 *   - `ts`       — Unix epoch milliseconds at broadcast time.
 *
 * Failure mode: any error event from chokidar emits a one-shot
 * `{ kind: "fs.watch.degraded", projectId }` frame so the UI can drop
 * back to manual refresh — better than silently lying about file state.
 */

const DEBOUNCE_MS = 100;
const AWAIT_WRITE_FINISH_MS = 100;
const POLL_INTERVAL_MS = 50;

/**
 * .git internals churn rapidly during operations (commit, checkout,
 * stash) — many writes to HEAD/index/refs/heads in a short burst. The
 * UI only cares about the settled state so we coalesce aggressively.
 *
 * Why a separate constant from `DEBOUNCE_MS` (100): a 100 ms working-
 * tree debounce is tuned for "user save → editor sees the new sha";
 * git internals don't have an equivalent latency budget, and broadcasting
 * three `git-status-changed` frames in 250 ms during a checkout would
 * cause three redundant porcelain refetches in the UI tree.
 */
const GIT_DEBOUNCE_MS = 300;

/**
 * Compute a SHA-256 hash of a file's contents. Returns null on read
 * failure (file already gone, permission denied, etc.). The watcher
 * settles on `null` rather than retrying because by the time we hash
 * the path could already have changed again — the next event will be
 * the source of truth.
 */
async function sha256File(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(absPath);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

type FsEvent = "add" | "change" | "unlink";

export interface FsChangedFrame {
  kind: "fs.changed";
  path: string;
  sha: string | null;
  event: FsEvent;
  source: "agent" | "external";
  ts: number;
}

export interface FsDegradedFrame {
  kind: "fs.watch.degraded";
  projectId: string;
}

interface PerProject {
  watcher: FSWatcher;
  debouncers: Map<string, NodeJS.Timeout>;
  /**
   * The most recent event observed for a given path during a debounce
   * window. We coalesce events so a transient flurry of `add → change →
   * change` settles to one `change` (or `add` if the file didn't exist
   * before the burst). `unlink` always wins — a file that ends the
   * window deleted is unlinked, no matter what came before.
   */
  pendingEvents: Map<string, FsEvent>;
  projectPath: string;
  /**
   * Memoised matcher loaded once at watcher start. The gitignore module
   * already TTL-caches reads at 1s, so re-calling `loadGitignoreMatcher`
   * inside the hot path would be cheap — but we still pin one reference
   * so a cache eviction mid-stream doesn't briefly let `.git/objects`
   * leak through while the next read fires.
   */
  matcher: { ignores: (relPath: string) => boolean };
}

/**
 * Decide whether chokidar should ignore a path BEFORE wiring an event.
 * The matcher honours the project's `.gitignore` (plus the always-on
 * `.git` / `node_modules` defaults) AND lets a small whitelist of
 * `.git/HEAD`, `.git/index`, `.git/refs/heads/*` through so the UI can
 * react to branch swaps and commit advances without subscribing to the
 * git operation API.
 *
 * Path arguments arrive as ABSOLUTE paths from chokidar — the function
 * relativises before consulting the matcher so gitignore rules apply
 * to the project-relative form (the form the rules were authored for).
 */
function makeIgnoredFn(
  projectPath: string,
  matcher: { ignores: (relPath: string) => boolean },
): (p: string) => boolean {
  const rootResolved = path.resolve(projectPath);
  return (absPath: string) => {
    if (absPath === rootResolved) return false;
    const rel = path.relative(rootResolved, absPath);
    if (rel === "" || rel.startsWith("..")) return false;
    const posixRel = rel.split(path.sep).join("/");
    // .git whitelist — let HEAD, index, and refs/heads/* through.
    // Allow `.git`, `.git/refs`, `.git/refs/heads` as DIRECTORIES so
    // chokidar will descend into them — otherwise a `true` return on a
    // parent dir prunes the entire subtree and our HEAD/index/refs
    // whitelist never fires. The actual whitelist for files lives below.
    if (posixRel === ".git" || posixRel === ".git/refs" || posixRel === ".git/refs/heads") {
      return false;
    }
    if (posixRel.startsWith(".git/")) {
      if (
        posixRel === ".git/HEAD" ||
        posixRel === ".git/index" ||
        posixRel.startsWith(".git/refs/heads/")
      ) {
        return false;
      }
      return true;
    }
    return matcher.ignores(posixRel);
  };
}

/**
 * Minimal state for the secondary `.git` watcher. The fs-watcher's main
 * chokidar instance excludes most of `.git/` (gitignore default, plus
 * the explicit prune in `makeIgnoredFn`) — opening `.git` to that
 * instance would fire on every loose-object write, every reflog tick,
 * every pack/index churn. The dedicated git watcher subscribes to a
 * narrow whitelist (HEAD + index + refs/heads/*) and broadcasts a
 * single coalesced `git-status-changed` frame regardless of how many
 * underlying file events arrived.
 *
 * State is kept SEPARATE from `PerProject` so the two debounce queues
 * never collide — a working-tree save must not delay a HEAD broadcast,
 * and vice versa.
 */
interface PerProjectGit {
  watcher: FSWatcher;
  /**
   * Single project-scoped debounce timer — we don't track per-path
   * because every git-internals event collapses to the same broadcast
   * frame.
   */
  debouncer: NodeJS.Timeout | null;
  projectPath: string;
}

class FsWatcher {
  private watchers = new Map<string, PerProject>();
  private gitWatchers = new Map<string, PerProjectGit>();

  /**
   * Start a chokidar watcher for `projectId` rooted at `projectPath`. If
   * a watcher already exists for `projectId` the call is a no-op — re-
   * subscribing UI tabs should reuse the running watcher instead of
   * piling up duplicates.
   */
  async start(projectId: string, projectPath: string): Promise<void> {
    if (this.watchers.has(projectId)) return;

    const rootResolved = path.resolve(projectPath);
    const matcher = await loadGitignoreMatcher(rootResolved);
    const ignored = makeIgnoredFn(rootResolved, matcher);

    const watcher = chokidar.watch(rootResolved, {
      ignored,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: AWAIT_WRITE_FINISH_MS,
        pollInterval: POLL_INTERVAL_MS,
      },
    });

    const state: PerProject = {
      watcher,
      debouncers: new Map(),
      pendingEvents: new Map(),
      projectPath: rootResolved,
      matcher,
    };
    this.watchers.set(projectId, state);

    const handle = (event: FsEvent, abs: string) => {
      const rel = path.relative(rootResolved, abs).split(path.sep).join("/");
      if (rel === "" || rel.startsWith("..")) return;

      // Coalesce policy:
      //   - `unlink` is sticky — the file is gone at the end of the burst
      //      no matter what the intermediate events were.
      //   - `add` is sticky against `change` — chokidar typically fires
      //     `add` then `change` for a new file (especially with
      //     `awaitWriteFinish` enabled). The user-meaningful event is
      //     "this file appeared," so we keep the `add`.
      //   - Otherwise the latest event wins (e.g. `unlink → add`
      //     legitimately becomes `add` for a re-created file).
      const prior = state.pendingEvents.get(rel);
      if (prior === "unlink") {
        // unlink is sticky UNLESS the file came back: unlink → add → file exists again.
        if (event === "add") state.pendingEvents.set(rel, "add");
        // unlink → change is impossible in practice; ignore if it happens.
      } else if (prior === "add" && event === "change") {
        // keep `add` — see comment above.
      } else {
        state.pendingEvents.set(rel, event);
      }

      const existing = state.debouncers.get(rel);
      if (existing) clearTimeout(existing);
      state.debouncers.set(
        rel,
        setTimeout(() => {
          void this.flush(projectId, rel);
        }, DEBOUNCE_MS),
      );
    };

    watcher.on("add", (p) => handle("add", p));
    watcher.on("change", (p) => handle("change", p));
    watcher.on("unlink", (p) => handle("unlink", p));
    // Wait for chokidar's initial scan to finish before returning. Without
    // this, the caller can race the watcher: writes that happen "after
    // start()" may actually land before chokidar has subscribed to
    // inotify, and the resulting event silently drops on the floor.
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
    watcher.on("error", (err) => {
      console.warn(
        `[fs-watcher] error for project ${projectId}, going degraded:`,
        err,
      );
      const frame: FsDegradedFrame = {
        kind: "fs.watch.degraded",
        projectId,
      };
      wsManager.broadcastToProject(projectId, frame as unknown as Record<string, unknown>);
    });
  }

  /**
   * Stop watching `projectId`. Pending debounce timers are cancelled —
   * any unsettled events are dropped (the next subscribe will re-load
   * the snapshot from listProjectDir, so no information is lost).
   */
  async stop(projectId: string): Promise<void> {
    const state = this.watchers.get(projectId);
    if (!state) return;
    for (const t of state.debouncers.values()) clearTimeout(t);
    state.debouncers.clear();
    state.pendingEvents.clear();
    this.watchers.delete(projectId);
    try {
      await state.watcher.close();
    } catch (err) {
      console.warn(`[fs-watcher] watcher.close() for ${projectId} threw:`, err);
    }
  }

  /**
   * Stop every active watcher. Called from `closeAll` paths during
   * graceful shutdown so we don't leak inotify FDs into the next test
   * run / process.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.watchers.keys()];
    const gitIds = [...this.gitWatchers.keys()];
    await Promise.all([
      ...ids.map((id) => this.stop(id)),
      ...gitIds.map((id) => this.stopGit(id)),
    ]);
  }

  /**
   * Start a secondary chokidar instance scoped to the project's `.git`
   * directory and broadcast a coalesced `git-status-changed` frame on
   * any change to HEAD, index, or `refs/heads/*`.
   *
   * Why a dedicated watcher: the main fs-watcher prunes `.git` (it would
   * otherwise fire constantly on loose objects + reflog + pack churn).
   * Running a second chokidar with a tight scope is the simplest way to
   * surface "interesting" git events without polluting the working-tree
   * stream — and lets us debounce git churn at a different cadence
   * (`GIT_DEBOUNCE_MS` 300 ms vs working-tree's 100 ms).
   *
   * Frame contract:
   *   { kind: "git-status-changed", projectId, ts }
   *
   * No per-file detail — the UI's contract is "porcelain peek + branches
   * list are stale, refetch them"; the wire frame stays tiny.
   *
   * No-op if the project's `.git` directory does not exist (a non-git
   * project, e.g. fresh `mkdir`). Calling `startGit` again after the dir
   * appears will succeed; the wireToWsManager hook calls `startGit`
   * eagerly once per first-subscriber so a `git init` mid-session is
   * not picked up automatically — that's acceptable: the operator who
   * just ran `git init` is also the one who will navigate into Code mode
   * and re-trigger a subscribe.
   */
  async startGit(projectId: string, projectPath: string): Promise<void> {
    if (this.gitWatchers.has(projectId)) return;
    const rootResolved = path.resolve(projectPath);
    const gitDir = path.join(rootResolved, ".git");
    // Bail early if `.git` is missing — chokidar would still create a
    // watcher, but it would never fire and we'd leak an FD per non-git
    // project.
    try {
      const stat = fs.statSync(gitDir);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    const targets = [
      path.join(gitDir, "HEAD"),
      path.join(gitDir, "index"),
      path.join(gitDir, "refs", "heads"),
    ];

    // No `awaitWriteFinish`: git writes via atomic rename of a `.lock`
    // file into place, so any event we see is already on a stable
    // file. The 300 ms debounce above the broadcast handles the
    // "many writes in a burst" case without needing chokidar's per-
    // file stability polling — and removing awaitWriteFinish dodges a
    // known macOS quirk where zero-byte files (e.g. an empty `.git/
    // index` on a fresh repo) can produce phantom events past the
    // ready boundary.
    const watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 10,
    });

    const state: PerProjectGit = {
      watcher,
      debouncer: null,
      projectPath: rootResolved,
    };
    this.gitWatchers.set(projectId, state);

    // Chokidar's `ignoreInitial: true` only suppresses synthetic `add`
    // events for files present during the initial scan — it does NOT
    // suppress late `change` events that fire shortly after `ready`
    // when the FS reports a stat for a file whose mtime was set right
    // before the watcher subscribed (e.g. a seed `.git/refs/heads/main`
    // written milliseconds before `startGit`). Drop events for a brief
    // warmup window after ready so a session start doesn't broadcast a
    // phantom git-status-changed frame.
    let warmedUp = false;

    const schedule = () => {
      if (!warmedUp) return;
      if (state.debouncer) clearTimeout(state.debouncer);
      state.debouncer = setTimeout(() => {
        state.debouncer = null;
        // Re-check we're still watching — a stop() during the debounce
        // window must not produce a phantom broadcast.
        if (!this.gitWatchers.has(projectId)) return;
        const frame = {
          kind: "git-status-changed",
          projectId,
          ts: Date.now(),
        };
        wsManager.broadcastToProject(
          projectId,
          frame as unknown as Record<string, unknown>,
        );
      }, GIT_DEBOUNCE_MS);
    };

    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
    // 200 ms post-ready warmup — enough time for chokidar to flush
    // any "the seed file just changed" stragglers from the initial
    // scan, fast enough that an operator who saves immediately after
    // opening the tab still sees the live update.
    setTimeout(() => {
      warmedUp = true;
    }, 200);
    watcher.on("error", (err) => {
      console.warn(
        `[fs-watcher/git] error for project ${projectId}:`,
        err,
      );
    });
  }

  /**
   * Stop the dedicated git watcher for `projectId`. Cancels any pending
   * debounce so a tear-down mid-burst can't fire a phantom broadcast.
   */
  async stopGit(projectId: string): Promise<void> {
    const state = this.gitWatchers.get(projectId);
    if (!state) return;
    if (state.debouncer) clearTimeout(state.debouncer);
    state.debouncer = null;
    this.gitWatchers.delete(projectId);
    try {
      await state.watcher.close();
    } catch (err) {
      console.warn(`[fs-watcher/git] close() for ${projectId} threw:`, err);
    }
  }

  /**
   * Test-only: introspection on whether a git watcher is live for a
   * given project — saves tests from poking the private map directly.
   */
  isWatchingGit(projectId: string): boolean {
    return this.gitWatchers.has(projectId);
  }

  /**
   * Flush a debounced path: hash it (or set sha=null on unlink/read-fail),
   * tag agent vs external, broadcast the frame.
   */
  private async flush(projectId: string, rel: string): Promise<void> {
    const state = this.watchers.get(projectId);
    if (!state) return;
    state.debouncers.delete(rel);
    const event = state.pendingEvents.get(rel);
    state.pendingEvents.delete(rel);
    if (!event) return;

    const abs = path.join(state.projectPath, ...rel.split("/"));
    const sha = event === "unlink" ? null : await sha256File(abs);
    const source = AgentWriteTracker.consume(projectId, rel)
      ? ("agent" as const)
      : ("external" as const);

    const frame: FsChangedFrame = {
      kind: "fs.changed",
      path: rel,
      sha,
      event,
      source,
      ts: Date.now(),
    };
    wsManager.broadcastToProject(
      projectId,
      frame as unknown as Record<string, unknown>,
    );
  }

  /**
   * Test-only: introspection on whether a watcher is live for a given
   * project — saves tests from poking the private map directly.
   */
  isWatching(projectId: string): boolean {
    return this.watchers.has(projectId);
  }
}

export const fsWatcher = new FsWatcher();

/**
 * Wire the WSManager lifecycle hooks so a project's chokidar watcher
 * starts on the first WS subscriber and stops on the last unsubscriber.
 * The caller (server-entry / boot) supplies a `projectPathLookup` that
 * resolves a `projectId` to its absolute working-tree path — the
 * watcher itself doesn't know about the projects table.
 *
 * Calling `wireToWsManager` again replaces the previous hooks.
 */
export function wireToWsManager(
  projectPathLookup: (projectId: string) => string | null,
): void {
  wsManager.setProjectSubscriberHooks({
    onFirstSubscriber: async (projectId) => {
      const projectPath = projectPathLookup(projectId);
      if (!projectPath) {
        console.warn(
          `[fs-watcher] cannot start for ${projectId}: project path not resolvable`,
        );
        return;
      }
      // Start working-tree + git internals watchers in parallel — they
      // own independent state (separate chokidar instances, separate
      // debounce timers) and a slow `.git` stat call must not block the
      // primary tree from going live.
      await Promise.all([
        fsWatcher.start(projectId, projectPath),
        fsWatcher.startGit(projectId, projectPath),
      ]);
    },
    onLastUnsubscriber: async (projectId) => {
      await Promise.all([
        fsWatcher.stop(projectId),
        fsWatcher.stopGit(projectId),
      ]);
    },
  });
}

/**
 * Test-only: expose internals so unit tests can simulate hot paths
 * without spinning up real chokidar instances when that's overkill.
 */
export const _internals = {
  sha256File,
  makeIgnoredFn,
  DEBOUNCE_MS,
  GIT_DEBOUNCE_MS,
};
