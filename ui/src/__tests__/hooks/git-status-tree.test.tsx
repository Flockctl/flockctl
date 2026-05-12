import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import {
  deriveTreeStatus,
  useDocumentVisibility,
  useGitStatusForTree,
} from "@/lib/hooks/git-status-tree";

/**
 * Unit tests for the polled git-status-tree hook.
 *
 * The contract under test:
 *   1. On mount the hook fires `GET /projects/:id/git-status` and exposes
 *      a `Map<path, status>` derived from the porcelain entries via the
 *      precedence rules in {@link deriveTreeStatus}.
 *   2. While `document.hidden === false`, the hook re-runs the request
 *      every 5s. We use Vitest's fake timers to advance the clock and
 *      assert the second fetch.
 *   3. When `document.hidden` flips to `true`, polling pauses (no
 *      additional fetches even after multiple 5s windows). Flipping it
 *      back to `false` and dispatching `visibilitychange` resumes
 *      polling.
 *   4. The `select` projection collapses a structured failure (HTTP 200
 *      with `ok:false`) to an empty Map — the tree just renders without
 *      badges in that branch.
 *
 * `setup.ts` installs a fresh `fetch` mock per test, so we attach a
 * Vitest-controlled implementation on each test and inspect the call
 * count.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrap() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

beforeEach(() => {
  // Reset visibility for each test. JSDOM exposes `document.hidden`
  // as a non-configurable getter; we redefine it as a plain prop so
  // we can flip it from inside the test.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deriveTreeStatus — porcelain XY → coarse bucket", () => {
  it("returns ?? for untracked entries", () => {
    expect(deriveTreeStatus("?", "?")).toBe("??");
  });

  it("returns U for any unmerged code on either side", () => {
    expect(deriveTreeStatus("U", " ")).toBe("U");
    expect(deriveTreeStatus(" ", "U")).toBe("U");
    // Symmetric AA / DD — both-added / both-deleted are conflicts too.
    expect(deriveTreeStatus("A", "A")).toBe("U");
    expect(deriveTreeStatus("D", "D")).toBe("U");
  });

  it("prefers the worktree side over index when both are non-space", () => {
    // Staged add but then modified in worktree — operator wants to see
    // M (the actual on-disk delta) not A.
    expect(deriveTreeStatus("A", "M")).toBe("M");
  });

  it("falls back to index when worktree is space", () => {
    expect(deriveTreeStatus("M", " ")).toBe("M");
    expect(deriveTreeStatus("A", " ")).toBe("A");
    expect(deriveTreeStatus("D", " ")).toBe("D");
  });

  it("returns null for unsupported codes (renames, copies, clean)", () => {
    expect(deriveTreeStatus(" ", " ")).toBeNull();
    expect(deriveTreeStatus("R", " ")).toBeNull();
    expect(deriveTreeStatus("C", " ")).toBeNull();
  });
});

describe("useGitStatusForTree", () => {
  it("returns Map<path, status> from a successful fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        reason: "ok",
        branch: "main",
        entries: [
          { path: "src/foo.ts", index: " ", worktree: "M" },
          { path: "src/bar.ts", index: "A", worktree: " " },
          { path: "old.ts", index: "D", worktree: " " },
          { path: "new.ts", index: "?", worktree: "?" },
          { path: "conflict.ts", index: "U", worktree: "U" },
          // Renames currently fall through (status = null) — assert
          // they don't pollute the map.
          { path: "renamed.ts", index: "R", worktree: " " },
        ],
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitStatusForTree("p1"), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toContain("/projects/p1/git-status");
    const map = result.current.data!;
    expect(map.get("src/foo.ts")).toBe("M");
    expect(map.get("src/bar.ts")).toBe("A");
    expect(map.get("old.ts")).toBe("D");
    expect(map.get("new.ts")).toBe("??");
    expect(map.get("conflict.ts")).toBe("U");
    expect(map.has("renamed.ts")).toBe(false);
  });

  it("returns an empty Map on structured failure (ok:false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, reason: "not_a_repo", message: "not a repo" }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitStatusForTree("p1"), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.size).toBe(0);
  });

  it("polls every 30s while the document is visible and the WS is disconnected", async () => {
    // The hook reads `useWsConnected()` which defaults to `false` in
    // a test that doesn't drive a real socket — that's the
    // poll-fallback branch under test here.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, reason: "ok", entries: [] }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitStatusForTree("p1"), {
      wrapper: Wrapper,
    });

    // First call lands synchronously after the microtask queue flushes.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 5s in — the old cadence boundary — must still be ONE fetch (the
    // new fallback poll interval is 30s, not 5s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance to 30s total — the poll fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // And again at 60s — cadence is steady.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Sanity: the data still parses cleanly on each tick.
    expect(result.current.data!.size).toBe(0);
  });

  it("pauses polling when document.hidden flips to true and resumes on visibilitychange", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, reason: "ok", entries: [] }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    renderHook(() => useGitStatusForTree("p1"), { wrapper: Wrapper });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Hide the tab.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Advance past two full 30s cadences — no additional fetches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Show the tab again — polling resumes from the next tick.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("useDocumentVisibility", () => {
  it("starts as visible and flips on visibilitychange", async () => {
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(true);
  });
});
