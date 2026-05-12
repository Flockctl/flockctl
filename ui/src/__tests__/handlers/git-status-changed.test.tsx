/**
 * Contract tests for the git-status-changed handler — exercises the
 * two query keys it must invalidate (`git-status-tree` and the
 * project-scoped `git-branches` key) plus the React hook lifecycle
 * (`useGitStatusChangedHandler` subscribes on mount, unsubscribes on
 * unmount).
 *
 * The pure `applyGitStatusChanged` is the cache-invalidation seam; the
 * hook is a thin glue layer over `globalWs.subscribeGit`.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  applyGitStatusChanged,
  useGitStatusChangedHandler,
} from "@/lib/handlers/git-status-changed";
import { gitBranchesQueryKey } from "@/lib/hooks/git-branches";
import type { GitStatusChangedFrame } from "@/lib/global-ws";

// --- Module mocks ----------------------------------------------------------

vi.mock("@/lib/global-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/global-ws")>();
  let lastHandler: ((frame: GitStatusChangedFrame) => void) | null = null;
  let lastProjectId: string | null = null;
  const unsubMock = vi.fn();
  return {
    ...actual,
    globalWs: {
      ...actual.globalWs,
      subscribeGit: vi.fn(
        (projectId: string, handler: (f: GitStatusChangedFrame) => void) => {
          lastProjectId = projectId;
          lastHandler = handler;
          return unsubMock;
        },
      ),
      __getLastHandler: () => lastHandler,
      __getLastProjectId: () => lastProjectId,
      __getUnsubMock: () => unsubMock,
    },
  };
});

import { globalWs } from "@/lib/global-ws";

// --- Helpers ---------------------------------------------------------------

function makeFrame(over: Partial<GitStatusChangedFrame> = {}): GitStatusChangedFrame {
  return {
    kind: "git-status-changed",
    projectId: "proj-1",
    ts: 1000,
    ...over,
  };
}

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
  vi.clearAllMocks();
});

// --- Cache invalidation --------------------------------------------------

describe("applyGitStatusChanged — cache invalidation", () => {
  it("invalidates ['git-status-tree', projectId]", () => {
    const { qc, spy } = makeQc();
    applyGitStatusChanged(qc, makeFrame({ projectId: "proj-1" }));

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["git-status-tree", "proj-1"]);
  });

  it("invalidates the project-scoped git-branches key", () => {
    const { qc, spy } = makeQc();
    applyGitStatusChanged(qc, makeFrame({ projectId: "proj-2" }));

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-2"));
  });

  it("invalidates exactly two queries per frame", () => {
    const { qc, spy } = makeQc();
    applyGitStatusChanged(qc, makeFrame());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("scopes invalidations to the frame's projectId", () => {
    const { qc, spy } = makeQc();
    applyGitStatusChanged(qc, makeFrame({ projectId: "proj-other" }));

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    // Both keys must reference proj-other, not the default proj-1.
    expect(keys).toContainEqual(["git-status-tree", "proj-other"]);
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-other"));
  });
});

// --- React hook ----------------------------------------------------------

describe("useGitStatusChangedHandler", () => {
  function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("subscribes via globalWs.subscribeGit on mount and unsubscribes on unmount", () => {
    const subSpy = globalWs.subscribeGit as unknown as ReturnType<typeof vi.fn>;
    subSpy.mockClear();
    const unsubMock = (globalWs as unknown as {
      __getUnsubMock: () => ReturnType<typeof vi.fn>;
    }).__getUnsubMock();
    unsubMock.mockClear();

    function Probe() {
      useGitStatusChangedHandler("proj-1");
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

  it("no-ops when projectId is null/undefined", () => {
    const subSpy = globalWs.subscribeGit as unknown as ReturnType<typeof vi.fn>;
    subSpy.mockClear();

    function Probe() {
      useGitStatusChangedHandler(null);
      return null;
    }
    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );
    expect(subSpy).not.toHaveBeenCalled();
  });

  it("delivered frames flow through applyGitStatusChanged (queries marked stale)", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");

    function Probe() {
      useGitStatusChangedHandler("proj-2");
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );

    const handler = (globalWs as unknown as {
      __getLastHandler: () => (f: GitStatusChangedFrame) => void;
    }).__getLastHandler();

    act(() => {
      handler(makeFrame({ projectId: "proj-2" }));
    });

    const keys = spy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["git-status-tree", "proj-2"]);
    expect(keys).toContainEqual(gitBranchesQueryKey("projects", "proj-2"));
  });
});
