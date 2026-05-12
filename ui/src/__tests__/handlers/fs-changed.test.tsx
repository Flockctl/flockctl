/**
 * Contract tests for the fs-changed handler — exercises the three axes
 * the handler is responsible for: cache invalidation, transient tree
 * highlight, and open-tab conflict resolution.
 *
 * The pure `applyFsChangedFrame` is the integration boundary; everything
 * a real `useFsChangedHandler` does on a frame eventually funnels into
 * it, so we drive it directly with a stub `QueryClient` (the global ws
 * singleton is irrelevant for these axes — a separate test in this file
 * covers the React hook lifecycle by stubbing `globalWs.subscribeFs`).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  applyFsChangedFrame,
  dirnamePosix,
  fsHighlightStore,
  fsTabStore,
  useFileHighlight,
  useFsChangedHandler,
  useTabState,
} from "@/lib/handlers/fs-changed";
import type { FsChangedFrame } from "@/lib/global-ws";

// --- Module mocks ----------------------------------------------------------
//
// `globalWs` is a singleton; mock its `subscribeFs` so the React hook
// test can drive a frame through without standing up a fake WebSocket.

vi.mock("@/lib/global-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/global-ws")>();
  let lastHandler:
    | ((frame: FsChangedFrame) => void)
    | null = null;
  let lastProjectId: string | null = null;
  const unsubMock = vi.fn();
  return {
    ...actual,
    globalWs: {
      subscribeFs: vi.fn((projectId: string, handler: (f: FsChangedFrame) => void) => {
        lastProjectId = projectId;
        lastHandler = handler;
        return unsubMock;
      }),
      __getLastHandler: () => lastHandler,
      __getLastProjectId: () => lastProjectId,
      __getUnsubMock: () => unsubMock,
    },
  };
});

import { globalWs } from "@/lib/global-ws";

// --- Helpers ---------------------------------------------------------------

function makeFrame(over: Partial<FsChangedFrame> = {}): FsChangedFrame {
  return {
    kind: "fs.changed",
    projectId: "proj-1",
    path: "src/foo.ts",
    sha: "sha-disk",
    event: "change",
    source: "agent",
    ts: 1000,
    ...over,
  };
}

// React-Query QueryClient with `invalidateQueries` spied on so we can
// assert the exact keys the handler hit.
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

beforeEach(() => {
  vi.useFakeTimers();
  fsHighlightStore.__resetForTests();
  fsTabStore.__resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- dirnamePosix --------------------------------------------------------

describe("dirnamePosix", () => {
  it("returns parent of a nested file", () => {
    expect(dirnamePosix("src/foo/bar.ts")).toBe("src/foo");
  });

  it("returns empty string for a top-level file (project root)", () => {
    expect(dirnamePosix("README.md")).toBe("");
  });

  it("returns empty string for an empty input", () => {
    expect(dirnamePosix("")).toBe("");
  });

  it("strips a trailing slash before computing the parent", () => {
    expect(dirnamePosix("src/foo/")).toBe("src");
  });
});

// --- Cache invalidation --------------------------------------------------

describe("applyFsChangedFrame — cache invalidation", () => {
  it("invalidates the file query and the parent listing", () => {
    const { qc, spy } = makeQc();
    applyFsChangedFrame(qc, makeFrame({ path: "src/foo.ts" }));

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["project-file", "proj-1", "src/foo.ts"]);
    expect(keys).toContainEqual(["fs-list", "proj-1", "src"]);
  });

  it("uses an empty parent for a top-level file", () => {
    const { qc, spy } = makeQc();
    applyFsChangedFrame(qc, makeFrame({ path: "README.md" }));

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["fs-list", "proj-1", ""]);
  });

  it("skips invalidation when held sha matches (self-write)", () => {
    const { qc, spy } = makeQc();
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "sha-disk",
      dirty: false,
      conflict: { kind: "none" },
    });

    const result = applyFsChangedFrame(qc, makeFrame({ sha: "sha-disk" }));
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- Highlight store -----------------------------------------------------

describe("applyFsChangedFrame — highlight store", () => {
  it("flips a path on, then off after the 3s TTL", () => {
    const { qc } = makeQc();
    applyFsChangedFrame(qc, makeFrame({ path: "src/foo.ts" }));

    // Within the window — entry exists.
    expect(fsHighlightStore.getSnapshot().expiresAt.has("src/foo.ts")).toBe(
      true,
    );

    // Past the TTL — the timer clears the entry.
    vi.advanceTimersByTime(3000);
    expect(fsHighlightStore.getSnapshot().expiresAt.has("src/foo.ts")).toBe(
      false,
    );
  });

  it("a back-to-back touch extends the window from the latest event", () => {
    const { qc } = makeQc();
    applyFsChangedFrame(qc, makeFrame({ path: "src/foo.ts" }));
    vi.advanceTimersByTime(2000);

    // Re-touch — should NOT expire 1s from now (which would be when
    // the original timer fires); instead, 3s from this point.
    applyFsChangedFrame(qc, makeFrame({ path: "src/foo.ts", sha: "sha2" }));
    vi.advanceTimersByTime(1500); // total: 3.5s past first, 1.5s past second
    expect(fsHighlightStore.getSnapshot().expiresAt.has("src/foo.ts")).toBe(
      true,
    );
    vi.advanceTimersByTime(1600);
    expect(fsHighlightStore.getSnapshot().expiresAt.has("src/foo.ts")).toBe(
      false,
    );
  });
});

// --- Open-tab conflict resolution ----------------------------------------

describe("applyFsChangedFrame — open-tab semantics", () => {
  it("self-write: held sha matches → noop on cache + tab", () => {
    const { qc, spy } = makeQc();
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "sha-self",
      dirty: false,
      conflict: { kind: "none" },
    });
    applyFsChangedFrame(qc, makeFrame({ sha: "sha-self" }));

    expect(spy).not.toHaveBeenCalled();
    const tab = fsTabStore.get("proj-1", "src/foo.ts");
    expect(tab?.heldSha).toBe("sha-self");
    expect(tab?.conflict.kind).toBe("none");
  });

  it("clean tab + sha differs: silent roll-forward of held sha", () => {
    const { qc } = makeQc();
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "sha-prev",
      dirty: false,
      conflict: { kind: "none" },
    });

    applyFsChangedFrame(qc, makeFrame({ sha: "sha-new", source: "agent" }));

    const tab = fsTabStore.get("proj-1", "src/foo.ts");
    expect(tab?.heldSha).toBe("sha-new");
    expect(tab?.dirty).toBe(false);
    expect(tab?.conflict.kind).toBe("none");
  });

  it("dirty tab + sha differs: conflict banner + held sha untouched", () => {
    const { qc } = makeQc();
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "sha-prev",
      dirty: true,
      conflict: { kind: "none" },
    });

    applyFsChangedFrame(
      qc,
      makeFrame({ sha: "sha-new", source: "external", ts: 12345 }),
    );

    const tab = fsTabStore.get("proj-1", "src/foo.ts");
    // Held sha must NOT change — Reload reads the disk sha from the
    // conflict record and updates from there.
    expect(tab?.heldSha).toBe("sha-prev");
    expect(tab?.dirty).toBe(true);
    expect(tab?.conflict).toEqual({
      kind: "conflict",
      source: "external",
      diskSha: "sha-new",
      ts: 12345,
    });
  });

  it("propagates the agent vs external attribution onto the conflict record", () => {
    const { qc } = makeQc();
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "sha-prev",
      dirty: true,
      conflict: { kind: "none" },
    });

    applyFsChangedFrame(qc, makeFrame({ sha: "x", source: "agent" }));
    let tab = fsTabStore.get("proj-1", "src/foo.ts");
    expect(tab?.conflict.kind === "conflict" && tab.conflict.source).toBe(
      "agent",
    );

    fsTabStore.update("proj-1", "src/foo.ts", { conflict: { kind: "none" } });
    applyFsChangedFrame(qc, makeFrame({ sha: "y", source: "external" }));
    tab = fsTabStore.get("proj-1", "src/foo.ts");
    expect(tab?.conflict.kind === "conflict" && tab.conflict.source).toBe(
      "external",
    );
  });

  it("no tab open → invalidation + highlight only", () => {
    const { qc, spy } = makeQc();
    applyFsChangedFrame(qc, makeFrame({ path: "src/foo.ts" }));

    expect(spy).toHaveBeenCalled();
    expect(fsHighlightStore.getSnapshot().expiresAt.has("src/foo.ts")).toBe(
      true,
    );
    // No tab to update; nothing to assert on the tab store.
    expect(fsTabStore.get("proj-1", "src/foo.ts")).toBeUndefined();
  });
});

// --- React hooks ---------------------------------------------------------

describe("useFileHighlight", () => {
  it("returns true while highlighted, false after expiry", () => {
    let snapshot = false;
    function Probe({ path }: { path: string }) {
      snapshot = useFileHighlight(path);
      return null;
    }
    render(<Probe path="src/foo.ts" />);
    expect(snapshot).toBe(false);

    act(() => {
      fsHighlightStore.touch("src/foo.ts");
    });
    expect(snapshot).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(snapshot).toBe(false);
  });

  it("returns false when path is null (matches the !isDir guard in TreeNode)", () => {
    let snapshot = true;
    function Probe() {
      snapshot = useFileHighlight(null);
      return null;
    }
    render(<Probe />);
    expect(snapshot).toBe(false);
  });
});

describe("useTabState", () => {
  it("reflects live updates from fsTabStore.update", () => {
    const ref: { current: ReturnType<typeof useTabState> } = { current: undefined };
    function Probe() {
      ref.current = useTabState("proj-1", "src/foo.ts");
      return null;
    }
    fsTabStore.register({
      projectId: "proj-1",
      path: "src/foo.ts",
      heldSha: "a",
      dirty: false,
      conflict: { kind: "none" },
    });
    render(<Probe />);
    expect(ref.current?.heldSha).toBe("a");

    act(() => {
      fsTabStore.update("proj-1", "src/foo.ts", { heldSha: "b" });
    });
    expect(ref.current?.heldSha).toBe("b");
  });
});

describe("useFsChangedHandler", () => {
  function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("subscribes to globalWs.subscribeFs on mount and unsubscribes on unmount", () => {
    const subSpy = globalWs.subscribeFs as unknown as ReturnType<typeof vi.fn>;
    subSpy.mockClear();
    const unsubMock = (globalWs as unknown as {
      __getUnsubMock: () => ReturnType<typeof vi.fn>;
    }).__getUnsubMock();
    unsubMock.mockClear();

    function Probe() {
      useFsChangedHandler("proj-1");
      return null;
    }
    const { unmount } = render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );

    expect(subSpy).toHaveBeenCalledTimes(1);
    expect(subSpy).toHaveBeenCalledWith("proj-1", expect.any(Function));

    unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });

  it("delivered frames flow through applyFsChangedFrame (highlight observable)", () => {
    function Probe() {
      useFsChangedHandler("proj-2");
      return null;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );

    const handler = (globalWs as unknown as {
      __getLastHandler: () => (f: FsChangedFrame) => void;
    }).__getLastHandler();

    act(() => {
      handler(makeFrame({ projectId: "proj-2", path: "lib/x.ts" }));
    });

    expect(fsHighlightStore.getSnapshot().expiresAt.has("lib/x.ts")).toBe(true);
  });
});
