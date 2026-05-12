import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import crypto from "crypto";

import { wsManager } from "../../services/ws-manager.js";
import { fsWatcher } from "../../services/fs-watcher.js";

/**
 * Tests for the secondary `.git` chokidar watcher (`startGit/stopGit`)
 * that broadcasts coalesced `git-status-changed` frames whenever the
 * UI-relevant slice of `.git` moves: HEAD, index, refs/heads/*.
 *
 * Coverage axes:
 *   - HEAD swap (e.g. `git checkout`) → frame.
 *   - index write (e.g. `git add`) → frame.
 *   - refs/heads/<branch> write (e.g. branch advance) → frame.
 *   - Burst coalescing (300 ms debounce should collapse N writes into
 *     a single frame).
 *   - Working-tree writes do NOT fire git frames (sanity — proves the
 *     watcher is scoped, not eavesdropping on the main fs watcher).
 *   - Non-git project bails out cleanly (`startGit` is a no-op).
 *   - `stopGit` silences subsequent events and cancels in-flight
 *     debounce timers.
 */

const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-watcher-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function captureFramesFor(projectId: string): {
  frames: Array<Record<string, unknown>>;
  client: { send: ReturnType<typeof vi.fn>; readyState: number };
} {
  const frames: Array<Record<string, unknown>> = [];
  const client = {
    send: vi.fn((msg: string) => {
      frames.push(JSON.parse(msg));
    }),
    readyState: 1,
  };
  wsManager.addProjectClient(projectId, client);
  return { frames, client };
}

function makeGitProject(name: string): string {
  const root = join(tmpRoot, name + "-" + crypto.randomBytes(4).toString("hex"));
  mkdirSync(root, { recursive: true });
  // Minimal `.git` skeleton — enough for chokidar to find the targets.
  // We only watch HEAD, index, and refs/heads, so seeding those is
  // sufficient; nothing else in `.git` is needed to drive the watcher.
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "index"), "");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "0".repeat(40) + "\n");
  return root;
}

async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  predicate: (f: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `timeout waiting for matching frame. captured=${JSON.stringify(frames)}`,
  );
}

describe("FsWatcher.startGit", () => {
  beforeEach(() => {
    wsManager.closeAll();
    wsManager.setProjectSubscriberHooks({
      onFirstSubscriber: null,
      onLastUnsubscriber: null,
    });
  });

  afterEach(async () => {
    await fsWatcher.stopAll();
  });

  it("broadcasts a git-status-changed frame when .git/HEAD moves (checkout)", async () => {
    const root = makeGitProject("head-swap");
    const projectId = "p-head";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(true);
    // Wait past the post-ready warmup window so the seed-file
    // stragglers chokidar sometimes fires don't bleed into the
    // assertion below.
    await new Promise((r) => setTimeout(r, 250));

    // Simulate a checkout: HEAD points at a different ref.
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feature\n");

    const frame = await waitForFrame(
      frames,
      (f) => f.kind === "git-status-changed",
    );
    expect(frame.kind).toBe("git-status-changed");
    expect(frame.projectId).toBe(projectId);
    expect(typeof frame.ts).toBe("number");
  });

  it("broadcasts on .git/index write (git add)", async () => {
    const root = makeGitProject("index-write");
    const projectId = "p-index";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    await new Promise((r) => setTimeout(r, 250)); // post-ready warmup

    await writeFile(join(root, ".git", "index"), "blob\0content");

    await waitForFrame(frames, (f) => f.kind === "git-status-changed");
  });

  it("broadcasts on refs/heads/<branch> advance", async () => {
    const root = makeGitProject("ref-advance");
    const projectId = "p-ref";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    await new Promise((r) => setTimeout(r, 250)); // post-ready warmup

    await writeFile(
      join(root, ".git", "refs", "heads", "main"),
      "a".repeat(40) + "\n",
    );

    await waitForFrame(frames, (f) => f.kind === "git-status-changed");
  });

  it("coalesces a burst of churn into a single frame (300ms debounce)", async () => {
    const root = makeGitProject("burst");
    const projectId = "p-burst";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    await new Promise((r) => setTimeout(r, 250)); // post-ready warmup

    // Hammer HEAD + index + refs/heads/main back-to-back well within
    // the 300 ms debounce window. The watcher should emit ONE frame.
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/a\n");
    await writeFile(join(root, ".git", "index"), "x");
    await writeFile(join(root, ".git", "refs", "heads", "main"), "b".repeat(40) + "\n");
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/b\n");

    // Wait through the debounce + safety margin.
    await waitForFrame(frames, (f) => f.kind === "git-status-changed");

    // Give a generous extra window for any duplicate frames to
    // arrive before asserting the coalesce — this is the actual
    // contract being tested.
    await new Promise((r) => setTimeout(r, 500));
    const gitFrames = frames.filter((f) => f.kind === "git-status-changed");
    expect(gitFrames.length).toBe(1);
  });

  it("ignores writes outside the .git whitelist", async () => {
    const root = makeGitProject("non-git-write");
    const projectId = "p-outside";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    // Past the 200 ms warmup — any seed-file stragglers are dropped
    // before this point.
    await new Promise((r) => setTimeout(r, 250));

    // A working-tree file change must NOT fire a git-status frame —
    // this watcher's scope is purely .git internals.
    await writeFile(join(root, "README.md"), "hello");

    // Wait past the debounce window; if a stray frame is going to
    // arrive it will arrive within ~500 ms.
    await new Promise((r) => setTimeout(r, 600));
    const gitFrames = frames.filter((f) => f.kind === "git-status-changed");
    expect(gitFrames.length).toBe(0);
  });

  it("is a no-op for a project without a .git directory", async () => {
    const root = join(tmpRoot, "non-git-" + crypto.randomBytes(4).toString("hex"));
    mkdirSync(root, { recursive: true });
    const projectId = "p-nongit";
    captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(false);
  });

  it("startGit is idempotent (second call is a no-op)", async () => {
    const root = makeGitProject("idem");
    const projectId = "p-idem";
    captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(true);
    await fsWatcher.startGit(projectId, root);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(true);
  });

  it("stopGit silences further events and cancels in-flight debounce", async () => {
    const root = makeGitProject("stop");
    const projectId = "p-stop-git";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.startGit(projectId, root);
    await new Promise((r) => setTimeout(r, 250)); // post-ready warmup
    // Kick off a debounced event then immediately stop — the timer
    // should be cancelled and no frame should arrive.
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/x\n");
    await fsWatcher.stopGit(projectId);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(false);

    await new Promise((r) => setTimeout(r, 600));

    // Further writes must not produce frames either.
    await writeFile(join(root, ".git", "index"), "y");
    await new Promise((r) => setTimeout(r, 500));

    const gitFrames = frames.filter((f) => f.kind === "git-status-changed");
    expect(gitFrames.length).toBe(0);
  });

  it("stopAll tears down both fs and git watchers", async () => {
    const root = makeGitProject("stop-all");
    const projectId = "p-stop-all";
    captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);
    await fsWatcher.startGit(projectId, root);
    expect(fsWatcher.isWatching(projectId)).toBe(true);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(true);

    await fsWatcher.stopAll();
    expect(fsWatcher.isWatching(projectId)).toBe(false);
    expect(fsWatcher.isWatchingGit(projectId)).toBe(false);
  });
});
