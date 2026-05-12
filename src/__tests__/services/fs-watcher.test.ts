import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import crypto from "crypto";

// Reuse the singleton from the service module — fs-watcher writes through it.
import { wsManager } from "../../services/ws-manager.js";
import { fsWatcher, _internals, type FsChangedFrame } from "../../services/fs-watcher.js";
import { AgentWriteTracker, _resetForTests as resetTracker } from "../../services/agent-write-tracker.js";
import { _clearGitignoreCacheForTests } from "../../services/fs-gitignore.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-watcher-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Hook a fake project subscriber into wsManager.broadcastToProject by
 * registering a stub WS client via addProjectClient. Returns the captured
 * frames as parsed JSON objects.
 */
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

function makeProject(name: string, files: Record<string, string> = {}): string {
  const root = join(tmpRoot, name + "-" + crypto.randomBytes(4).toString("hex"));
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/**
 * Wait for the next frame matching `predicate` (or any frame if omitted).
 * Times out via vitest's default rather than spinning forever.
 */
async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  predicate: (f: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 2000,
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

describe("FsWatcher", () => {
  // Each test gets a fresh manager state + tracker so frames don't bleed.
  beforeEach(() => {
    resetTracker();
    _clearGitignoreCacheForTests();
    // Reset wsManager state — no public reset, so we close all and re-init the
    // hooks to no-op so addProjectClient doesn't try to start a watcher.
    wsManager.closeAll();
    wsManager.setProjectSubscriberHooks({
      onFirstSubscriber: null,
      onLastUnsubscriber: null,
    });
  });

  afterEach(async () => {
    await fsWatcher.stopAll();
  });

  it("debounces rapid changes into a single 'change' frame and computes sha", async () => {
    const root = makeProject("debounce", { "a.txt": "v0" });
    const projectId = "p-debounce";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);

    // Burst three writes well within the debounce window.
    await writeFile(join(root, "a.txt"), "v1");
    await writeFile(join(root, "a.txt"), "v2");
    await writeFile(join(root, "a.txt"), "v3");

    const frame = (await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === "a.txt",
    )) as unknown as FsChangedFrame;

    expect(frame.event).toBe("change");
    // sha is the digest of the FINAL settled content ("v3").
    const expected = crypto.createHash("sha256").update("v3").digest("hex");
    expect(frame.sha).toBe(expected);
    expect(frame.source).toBe("external");
    expect(typeof frame.ts).toBe("number");

    // Coalescing — only ONE frame for a.txt despite three writes.
    const aFrames = frames.filter(
      (f) => f.kind === "fs.changed" && f.path === "a.txt",
    );
    expect(aFrames.length).toBe(1);
  });

  it("tags writes preceded by AgentWriteTracker.track as source:'agent'", async () => {
    const root = makeProject("agent-tag", { "b.txt": "x" });
    const projectId = "p-agent-tag";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);

    // Agent runtime tags the path right before the write.
    AgentWriteTracker.track(projectId, "b.txt");
    await writeFile(join(root, "b.txt"), "y");

    const frame = (await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === "b.txt",
    )) as unknown as FsChangedFrame;

    expect(frame.source).toBe("agent");
    expect(frame.event).toBe("change");
  });

  it("emits sha:null and event:'unlink' when a file is deleted", async () => {
    const root = makeProject("unlink", { "gone.txt": "boom" });
    const projectId = "p-unlink";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);

    unlinkSync(join(root, "gone.txt"));

    const frame = (await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === "gone.txt",
    )) as unknown as FsChangedFrame;

    expect(frame.event).toBe("unlink");
    expect(frame.sha).toBeNull();
  });

  it("emits 'add' with sha for a new file", async () => {
    const root = makeProject("add-new");
    const projectId = "p-add";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);

    await writeFile(join(root, "fresh.md"), "hello");

    const frame = (await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === "fresh.md",
    )) as unknown as FsChangedFrame;

    expect(frame.event).toBe("add");
    expect(frame.sha).toBe(
      crypto.createHash("sha256").update("hello").digest("hex"),
    );
  });

  it("does not start a duplicate watcher if start() is called twice", async () => {
    const root = makeProject("dup");
    const projectId = "p-dup";
    captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);
    expect(fsWatcher.isWatching(projectId)).toBe(true);
    // Second call is a no-op — we just want it not to throw and to stay live.
    await fsWatcher.start(projectId, root);
    expect(fsWatcher.isWatching(projectId)).toBe(true);
  });

  it("stop() releases the watcher and silences further events", async () => {
    const root = makeProject("stop", { "x.txt": "0" });
    const projectId = "p-stop";
    const { frames } = captureFramesFor(projectId);

    await fsWatcher.start(projectId, root);
    await fsWatcher.stop(projectId);
    expect(fsWatcher.isWatching(projectId)).toBe(false);

    // Edits after stop should not produce any fs.changed frames.
    await writeFile(join(root, "x.txt"), "1");
    await new Promise((r) => setTimeout(r, 350));
    const fsFrames = frames.filter((f) => f.kind === "fs.changed");
    expect(fsFrames.length).toBe(0);
  });

  it("ignores .gitignore-listed files but lets through .git/HEAD changes", async () => {
    const root = makeProject("gitignore", {
      ".gitignore": "ignored.log\n",
      "kept.txt": "k",
      "ignored.log": "junk",
    });
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

    const projectId = "p-gi";
    const { frames } = captureFramesFor(projectId);
    await fsWatcher.start(projectId, root);

    // Touch ignored.log — should produce NO frame.
    await writeFile(join(root, "ignored.log"), "more junk");
    // Also bump kept.txt — proves the watcher is alive.
    await writeFile(join(root, "kept.txt"), "k2");

    await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === "kept.txt",
    );

    const ignoredFrames = frames.filter(
      (f) => f.kind === "fs.changed" && f.path === "ignored.log",
    );
    expect(ignoredFrames.length).toBe(0);

    // Mutate .git/HEAD — should fire a frame (whitelisted).
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feature\n");
    await waitForFrame(
      frames,
      (f) => f.kind === "fs.changed" && f.path === ".git/HEAD",
    );
  });

  it("makeIgnoredFn unit: filters gitignored, allows .git whitelist", async () => {
    const root = makeProject("ign-unit", { ".gitignore": "build/\n" });
    _clearGitignoreCacheForTests();
    const matcher = await (await import("../../services/fs-gitignore.js")).loadGitignoreMatcher(root);
    const isIgnored = _internals.makeIgnoredFn(root, matcher);

    expect(isIgnored(root)).toBe(false);
    expect(isIgnored(join(root, "src", "x.ts"))).toBe(false);
    expect(isIgnored(join(root, "build", "out.js"))).toBe(true);
    // node_modules always-on.
    expect(isIgnored(join(root, "node_modules", "p"))).toBe(true);
    // .git is ignored EXCEPT for the whitelist.
    expect(isIgnored(join(root, ".git", "objects", "00", "abc"))).toBe(true);
    expect(isIgnored(join(root, ".git", "HEAD"))).toBe(false);
    expect(isIgnored(join(root, ".git", "index"))).toBe(false);
    expect(isIgnored(join(root, ".git", "refs", "heads", "main"))).toBe(false);
  });

  it("sha256File returns null for a missing path", async () => {
    const r = await _internals.sha256File(join(tmpRoot, "definitely-not-here"));
    expect(r).toBeNull();
  });
});

describe("AgentWriteTracker", () => {
  beforeEach(() => resetTracker());

  it("track + consume returns true once, then false", () => {
    AgentWriteTracker.track("p1", "a.txt");
    expect(AgentWriteTracker.consume("p1", "a.txt")).toBe(true);
    expect(AgentWriteTracker.consume("p1", "a.txt")).toBe(false);
  });

  it("consume returns false for an unknown path", () => {
    expect(AgentWriteTracker.consume("p1", "never-tracked.txt")).toBe(false);
  });

  it("scopes entries per project — same path in two projects is independent", () => {
    AgentWriteTracker.track("p1", "x.ts");
    AgentWriteTracker.track("p2", "x.ts");
    expect(AgentWriteTracker.consume("p1", "x.ts")).toBe(true);
    expect(AgentWriteTracker.consume("p2", "x.ts")).toBe(true);
  });

  it("expires entries older than the 5s TTL", () => {
    vi.useFakeTimers();
    try {
      AgentWriteTracker.track("p", "stale.txt");
      vi.advanceTimersByTime(5_001);
      expect(AgentWriteTracker.consume("p", "stale.txt")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
