/**
 * Contract tests for the reconnect-drift handler — exercises the four
 * axes the handler is responsible for:
 *
 *   1. Cache invalidation runs once per project at the start (git-status
 *      tree + branches keys).
 *   2. Per-tab fetch reconciles silently on clean-buffer drift.
 *   3. Per-tab fetch raises a `changed` banner on dirty-buffer drift.
 *   4. `fs_not_found` raises a `deleted` banner regardless of dirty
 *      state.
 *
 * Plus the React hook lifecycle (`useReconnectDriftHandler` subscribes
 * via `globalWs.subscribeReconnect` on mount and unsubscribes on
 * unmount) and the concurrency cap on the per-tab walk.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  applyDriftResult,
  makeLimit,
  runDriftCheck,
  useReconnectDriftHandler,
} from "@/lib/handlers/reconnect-drift";
import { gitBranchesQueryKey } from "@/lib/hooks/git-branches";
import {
  tabStore,
  useEditorTabsStore,
  fileTabId,
  __setEditorTabIdGeneratorForTests,
  __resetEditorTabIdGeneratorForTests,
} from "@/components/code-mode/tab-store";
import type { FsReadResponse } from "@/lib/api/fs";

// --- Module mocks ----------------------------------------------------------

vi.mock("@/lib/global-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/global-ws")>();
  let lastListener: (() => void) | null = null;
  const unsubMock = vi.fn();
  return {
    ...actual,
    globalWs: {
      ...actual.globalWs,
      subscribeReconnect: vi.fn((listener: () => void) => {
        lastListener = listener;
        return unsubMock;
      }),
      __getLastReconnectListener: () => lastListener,
      __getReconnectUnsubMock: () => unsubMock,
    },
  };
});

import { globalWs } from "@/lib/global-ws";

// --- Helpers ---------------------------------------------------------------

function makeQc(): {
  qc: QueryClient;
  spy: ReturnType<typeof vi.spyOn>;
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const spy = vi.spyOn(qc, "invalidateQueries");
  return { qc, spy };
}

function ok(content: string, sha: string): FsReadResponse {
  return {
    ok: true,
    content,
    sha,
    size: content.length,
    mtime: 1,
    encoding: "utf-8",
  };
}

function notFound(): FsReadResponse {
  return { ok: false, error_code: "fs_not_found" };
}

beforeEach(() => {
  vi.clearAllMocks();
  tabStore.__resetForTests();
  useEditorTabsStore.getState().__resetForTests();
  __resetEditorTabIdGeneratorForTests();
});

// --- makeLimit -------------------------------------------------------------

describe("makeLimit", () => {
  it("caps active tasks at the configured concurrency", async () => {
    const limit = makeLimit(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it("rejects concurrency < 1", () => {
    expect(() => makeLimit(0)).toThrow();
  });

  it("propagates rejection without stalling the queue", async () => {
    const limit = makeLimit(1);
    const failing = limit(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    // A subsequent task must still run — i.e. the slot was released.
    const ok = await limit(async () => 42);
    expect(ok).toBe(42);
  });
});

// --- applyDriftResult ------------------------------------------------------

describe("applyDriftResult", () => {
  it("noop when fresh sha matches held sha", () => {
    // Open editor tab + shell file tab on the same path.
    __setEditorTabIdGeneratorForTests(() => "ed-1");
    useEditorTabsStore.getState().open("src/foo.ts");
    useEditorTabsStore.getState().setBuffer("ed-1", "old content", "sha-A");

    const id = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-1", path: "src/foo.ts" });

    applyDriftResult(
      { kind: "file", id, projectId: "proj-1", path: "src/foo.ts" },
      ok("old content", "sha-A"),
    );

    // No banner, buffer untouched.
    expect(tabStore.getState().banners.has(id)).toBe(false);
    const ed = useEditorTabsStore.getState().tabs.find((t) => t.id === "ed-1")!;
    expect(ed.buffer).toBe("old content");
    expect(ed.heldSha).toBe("sha-A");
  });

  it("silently rolls heldSha forward on clean-buffer drift", () => {
    __setEditorTabIdGeneratorForTests(() => "ed-2");
    useEditorTabsStore.getState().open("src/foo.ts");
    useEditorTabsStore.getState().setBuffer("ed-2", "old content", "sha-A");

    const id = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-1", path: "src/foo.ts" });

    applyDriftResult(
      { kind: "file", id, projectId: "proj-1", path: "src/foo.ts" },
      ok("new content", "sha-B"),
    );

    expect(tabStore.getState().banners.has(id)).toBe(false);
    const ed = useEditorTabsStore.getState().tabs.find((t) => t.id === "ed-2")!;
    expect(ed.buffer).toBe("new content");
    expect(ed.heldSha).toBe("sha-B");
    expect(ed.dirty).toBe(false);
  });

  it("raises a `changed` banner on dirty-buffer drift", () => {
    __setEditorTabIdGeneratorForTests(() => "ed-3");
    useEditorTabsStore.getState().open("src/foo.ts");
    useEditorTabsStore.getState().setBuffer("ed-3", "loaded", "sha-A");
    useEditorTabsStore.getState().setDirty("ed-3", true);

    const id = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-1", path: "src/foo.ts" });

    applyDriftResult(
      { kind: "file", id, projectId: "proj-1", path: "src/foo.ts" },
      ok("disk wins", "sha-B"),
    );

    const banner = tabStore.getState().banners.get(id);
    expect(banner).toEqual({ kind: "changed", currentSha: "sha-B" });
    // Buffer + heldSha untouched on a dirty conflict.
    const ed = useEditorTabsStore.getState().tabs.find((t) => t.id === "ed-3")!;
    expect(ed.buffer).toBe("loaded");
    expect(ed.heldSha).toBe("sha-A");
    expect(ed.dirty).toBe(true);
  });

  it("raises a `deleted` banner on fs_not_found", () => {
    __setEditorTabIdGeneratorForTests(() => "ed-4");
    useEditorTabsStore.getState().open("src/foo.ts");
    useEditorTabsStore.getState().setBuffer("ed-4", "loaded", "sha-A");

    const id = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-1", path: "src/foo.ts" });

    applyDriftResult(
      { kind: "file", id, projectId: "proj-1", path: "src/foo.ts" },
      notFound(),
    );

    const banner = tabStore.getState().banners.get(id);
    expect(banner).toEqual({ kind: "deleted" });
  });

  it("ignores diff and commit tabs", () => {
    const diffId = "diff:projects:proj-1:src/foo.ts:working";
    tabStore.openTab({
      kind: "diff",
      id: diffId,
      scope: "projects",
      entityId: "proj-1",
      path: "src/foo.ts",
    });
    applyDriftResult(
      {
        kind: "diff",
        id: diffId,
        scope: "projects",
        entityId: "proj-1",
        path: "src/foo.ts",
      },
      ok("anything", "sha-X"),
    );
    expect(tabStore.getState().banners.has(diffId)).toBe(false);
  });

  it("noop when no editor buffer is mounted on the tab path", () => {
    const id = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-1", path: "src/foo.ts" });
    // No editor tab open.
    applyDriftResult(
      { kind: "file", id, projectId: "proj-1", path: "src/foo.ts" },
      ok("anything", "sha-X"),
    );
    expect(tabStore.getState().banners.has(id)).toBe(false);
  });
});

// --- runDriftCheck (orchestration) ----------------------------------------

describe("runDriftCheck", () => {
  it("invalidates git-status-tree + git-branches once per project at the start", async () => {
    const id = fileTabId("proj-A", "src/foo.ts");
    tabStore.openTab({ kind: "file", id, projectId: "proj-A", path: "src/foo.ts" });

    const { qc, spy } = makeQc();
    await runDriftCheck(qc, { fetcher: async () => ok("x", "sha-A") });

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["git-status-tree", "proj-A"]);
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-A"));
  });

  it("derives project-id set from open file tabs (multi-project case)", async () => {
    tabStore.openTab({
      kind: "file",
      id: fileTabId("proj-A", "src/a.ts"),
      projectId: "proj-A",
      path: "src/a.ts",
    });
    tabStore.openTab({
      kind: "file",
      id: fileTabId("proj-B", "src/b.ts"),
      projectId: "proj-B",
      path: "src/b.ts",
    });

    const { qc, spy } = makeQc();
    await runDriftCheck(qc, { fetcher: async () => ok("x", "sha-X") });

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["git-status-tree", "proj-A"]);
    expect(keys).toContainEqual(["git-status-tree", "proj-B"]);
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-A"));
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-B"));
  });

  it("walks file tabs only — diff tabs do not produce a fetch", async () => {
    tabStore.openTab({
      kind: "file",
      id: fileTabId("proj-1", "src/a.ts"),
      projectId: "proj-1",
      path: "src/a.ts",
    });
    tabStore.openTab({
      kind: "diff",
      id: "diff:projects:proj-1:src/b.ts:working",
      scope: "projects",
      entityId: "proj-1",
      path: "src/b.ts",
    });

    const fetcher = vi.fn(async () => ok("x", "sha-A"));
    const { qc } = makeQc();
    await runDriftCheck(qc, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("proj-1", "src/a.ts");
  });

  it("respects the concurrency cap on the per-tab walk", async () => {
    // Six file tabs across projects — concurrency 2 should peak at 2.
    for (let i = 0; i < 6; i += 1) {
      const path = `src/f${i}.ts`;
      tabStore.openTab({
        kind: "file",
        id: fileTabId("proj-1", path),
        projectId: "proj-1",
        path,
      });
    }
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return ok("x", "sha-A");
    });
    const { qc } = makeQc();
    await runDriftCheck(qc, { fetcher, concurrency: 2 });

    expect(peak).toBeLessThanOrEqual(2);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("swallows per-tab fetch errors without aborting the walk", async () => {
    tabStore.openTab({
      kind: "file",
      id: fileTabId("proj-1", "src/a.ts"),
      projectId: "proj-1",
      path: "src/a.ts",
    });
    tabStore.openTab({
      kind: "file",
      id: fileTabId("proj-1", "src/b.ts"),
      projectId: "proj-1",
      path: "src/b.ts",
    });
    let calls = 0;
    const fetcher = vi.fn(async (_pid: string, path: string) => {
      calls += 1;
      if (path === "src/a.ts") throw new Error("network");
      return ok("ok", "sha-B");
    });
    const { qc } = makeQc();
    await expect(runDriftCheck(qc, { fetcher })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("end-to-end: dirty drift produces a banner via fetcher", async () => {
    __setEditorTabIdGeneratorForTests(() => "ed-x");
    useEditorTabsStore.getState().open("src/foo.ts");
    useEditorTabsStore.getState().setBuffer("ed-x", "loaded", "sha-A");
    useEditorTabsStore.getState().setDirty("ed-x", true);

    const tabId = fileTabId("proj-1", "src/foo.ts");
    tabStore.openTab({
      kind: "file",
      id: tabId,
      projectId: "proj-1",
      path: "src/foo.ts",
    });

    const { qc } = makeQc();
    await runDriftCheck(qc, {
      fetcher: async () => ok("disk wins", "sha-B"),
    });

    expect(tabStore.getState().banners.get(tabId)).toEqual({
      kind: "changed",
      currentSha: "sha-B",
    });
  });
});

// --- React hook ------------------------------------------------------------

describe("useReconnectDriftHandler", () => {
  function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("subscribes to globalWs.subscribeReconnect on mount and unsubscribes on unmount", () => {
    const subSpy = globalWs.subscribeReconnect as unknown as ReturnType<
      typeof vi.fn
    >;
    subSpy.mockClear();
    const unsubMock = (
      globalWs as unknown as {
        __getReconnectUnsubMock: () => ReturnType<typeof vi.fn>;
      }
    ).__getReconnectUnsubMock();
    unsubMock.mockClear();

    function Probe() {
      useReconnectDriftHandler();
      return null;
    }
    const { unmount } = render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );

    expect(subSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });

  it("firing the listener triggers cache invalidation", async () => {
    const id = fileTabId("proj-hook", "src/foo.ts");
    tabStore.openTab({
      kind: "file",
      id,
      projectId: "proj-hook",
      path: "src/foo.ts",
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");

    function Probe() {
      useReconnectDriftHandler();
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );

    const listener = (
      globalWs as unknown as {
        __getLastReconnectListener: () => () => void;
      }
    ).__getLastReconnectListener();

    await act(async () => {
      listener();
      // Allow the microtask drain inside `runDriftCheck`.
      await Promise.resolve();
    });

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["git-status-tree", "proj-hook"]);
  });
});
