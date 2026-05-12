import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  gitCommitWorkspace,
  gitPullWorkspace,
  gitPushWorkspace,
} from "@/lib/api";
import {
  useGitCommitWorkspace,
  useGitPullWorkspace,
  useGitPushWorkspace,
} from "@/lib/hooks";
import type {
  GitCommitResult,
  GitPullResult,
  GitPushResult,
} from "@/lib/types";

/**
 * Wire-format + cache-invalidation contract for the workspace git API
 * client functions and their TanStack Query mutation hooks. Direct mirror
 * of `api-projects-git.test.ts` — same backend handler factory
 * (`makeGitRouteHandlers`) sits behind both `/projects/:id/git-*` and
 * `/workspaces/:id/git-*`, so the wire shapes are identical and the only
 * difference is the cache key namespace (`workspaces` vs `projects`).
 *
 * Pinned invariants:
 *   1. Wire shape: URL, method, body keys (snake_case → camelCase
 *      via `apiFetch`'s outgoing conversion), and the snake_case shape
 *      of the response after `toSnakeKeys` runs.
 *   2. Cache invalidation: the `workspace(id)` key is invalidated on
 *      settle for commit and push, regardless of the structured outcome
 *      — a failure may still have left partial state on disk (commit) or
 *      changed upstream tracking (push), so refetching is the correct
 *      next read.
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
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, Wrapper };
}

// ─── gitPullWorkspace (raw API client) ────────────────────────────────────

describe("gitPullWorkspace", () => {
  it("POSTs /workspaces/:id/git-pull with no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        already_up_to_date: false,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitPullWorkspace("42");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/workspaces/42/git-pull");
    expect(init.method).toBe("POST");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branch).toBe("main");
      expect(result.already_up_to_date).toBe(false);
    }
  });

  it("preserves the structured-failure shape on ok:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        reason: "non_fast_forward",
        message: "Cannot fast-forward — branch has diverged.",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitPullWorkspace("7");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non_fast_forward");
      expect(result.message).toMatch(/diverged/);
    }
  });
});

// ─── gitCommitWorkspace (raw API client) ──────────────────────────────────

describe("gitCommitWorkspace", () => {
  it("POSTs /workspaces/:id/git-commit with the body verbatim (camelCase outgoing)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: "deadbeef".repeat(5),
        filesCommitted: 2,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitCommitWorkspace("42", {
      message: "feat: add foo",
      paths: ["a.txt", "b.txt"],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/workspaces/42/git-commit");
    expect(init.method).toBe("POST");
    // `message` and `paths` have no underscores, so they survive
    // toCamelKeys unchanged. The body must round-trip verbatim — the
    // backend's `gitCommitBodySchema` rejects unknown fields with 422.
    expect(JSON.parse(init.body as string)).toEqual({
      message: "feat: add foo",
      paths: ["a.txt", "b.txt"],
    });

    // Response keys have already gone through `toSnakeKeys`, so the
    // backend's camelCase `filesCommitted` surfaces as `files_committed`.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sha).toBe("deadbeef".repeat(5));
      expect(result.files_committed).toBe(2);
      expect(result.reason).toBe("ok");
    }
  });

  it("preserves the structured-failure shape on ok:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        reason: "empty_index",
        message: "Nothing to commit — the index is empty after staging.",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitCommitWorkspace("7", { message: "noop" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_index");
      expect(result.message).toMatch(/Nothing to commit/);
    }
  });
});

// ─── gitPushWorkspace (raw API client) ────────────────────────────────────

describe("gitPushWorkspace", () => {
  it("POSTs /workspaces/:id/git-push with the body verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "feature",
        remote: "origin",
        updated: true,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitPushWorkspace("42", {
      remote: "origin",
      set_upstream: true,
      force: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/workspaces/42/git-push");
    expect(init.method).toBe("POST");
    // `set_upstream` → `setUpstream` via apiFetch's outgoing key
    // conversion. The other two keys have no underscores so they pass
    // through unchanged. Crucially: NO `--all` / `--mirror` keys leak —
    // the backend's `.strict()` schema would 422 on those, and the type
    // doesn't permit them at the source.
    expect(JSON.parse(init.body as string)).toEqual({
      remote: "origin",
      setUpstream: true,
      force: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branch).toBe("feature");
      expect(result.remote).toBe("origin");
      expect(result.updated).toBe(true);
    }
  });

  it("defaults to an empty body when the second arg is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        remote: "origin",
        updated: false,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    await gitPushWorkspace("9");

    const [, init] = fetchMock.mock.calls[0]!;
    // Empty body sends `{}` so the backend can apply its defaults
    // (`remote: 'origin', setUpstream: false, force: false`). Sending
    // a literal `null` or `undefined` body would fail the JSON parse
    // server-side and 500.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("preserves the structured-failure shape on ok:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        branch: "main",
        remote: "origin",
        reason: "protected_branch",
        message: "Refusing to force-push to protected branch 'main'.",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const result = await gitPushWorkspace("7", { force: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("protected_branch");
      expect(result.branch).toBe("main");
      expect(result.message).toMatch(/protected branch/);
    }
  });
});

// ─── useGitPullWorkspace (mutation hook) ──────────────────────────────────

describe("useGitPullWorkspace", () => {
  it("POSTs /workspaces/:id/git-pull and surfaces the result on the mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        already_up_to_date: false,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitPullWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("42");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces/42/git-pull");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
    const data = result.current.data as GitPullResult;
    expect(data.ok).toBe(true);
  });

  it("invalidates the workspace query on success when HEAD moved", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        already_up_to_date: false,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPullWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("7");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });

  // `already_up_to_date` is a no-op on disk — invalidating would just
  // thrash the UI right when we want to show the "nothing to pull" toast
  // cleanly. This pins that we skip the invalidation in that case.
  it("does NOT invalidate when the pull was already up to date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        already_up_to_date: true,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPullWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("7");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── useGitCommitWorkspace (mutation hook) ────────────────────────────────

describe("useGitCommitWorkspace", () => {
  it("POSTs /workspaces/:id/git-commit and surfaces the result on the mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: "abc123def456",
        filesCommitted: 1,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitCommitWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({
        workspaceId: "42",
        body: { message: "feat: test" },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces/42/git-commit");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
    const data = result.current.data as GitCommitResult;
    expect(data.ok).toBe(true);
    if (data.ok) {
      expect(data.sha).toBe("abc123def456");
      expect(data.files_committed).toBe(1);
    }
  });

  it("invalidates the workspace query on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: "abc",
        filesCommitted: 1,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitCommitWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({
        workspaceId: "7",
        body: { message: "feat: x" },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Pinning the queryKey shape so a future namespace split is caught.
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });

  // Critical contract: a structured failure (HTTP 200, body `ok:false`)
  // is STILL a settlement and STILL invalidates. The service may have
  // staged files before detecting `empty_index`, so the workspace query
  // (and any UI driven from it) is stale either way.
  it("invalidates the workspace query on a structured failure (ok:false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        reason: "empty_index",
        message: "Nothing to commit.",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitCommitWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({
        workspaceId: "7",
        body: { message: "noop" },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(false);
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });
});

// ─── useGitPushWorkspace (mutation hook) ──────────────────────────────────

describe("useGitPushWorkspace", () => {
  it("POSTs /workspaces/:id/git-push with the body and surfaces the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "feature",
        remote: "origin",
        updated: true,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitPushWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({
        workspaceId: "42",
        body: { set_upstream: true },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces/42/git-push");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sent).toEqual({ setUpstream: true });

    const data = result.current.data as GitPushResult;
    expect(data.ok).toBe(true);
    if (data.ok) {
      expect(data.branch).toBe("feature");
      expect(data.updated).toBe(true);
    }
  });

  it("supports omitting the body argument entirely (defaults applied server-side)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        remote: "origin",
        updated: false,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitPushWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ workspaceId: "9" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    // Empty `{}` lets the backend apply `{ remote: 'origin',
    // setUpstream: false, force: false }` from `gitPushBodySchema`.
    expect(sent).toEqual({});
  });

  it("invalidates the workspace query on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        branch: "main",
        remote: "origin",
        updated: true,
        reason: "ok",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPushWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ workspaceId: "7", body: {} });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });

  // Same rationale as the commit-failure test: a structured push failure
  // may still have changed upstream tracking state (or proven the
  // operator's mental model wrong about it), so the workspace query is
  // stale either way.
  it("invalidates the workspace query on a structured failure (ok:false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        branch: "main",
        remote: "origin",
        reason: "rejected_non_fast_forward",
        message: "non-fast-forward",
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPushWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ workspaceId: "7", body: {} });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(false);

    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });

  // Network-level failure path: when fetch itself rejects, the mutation
  // ends up in `isError` rather than `isSuccess`. `onSettled` still fires,
  // so the cache invalidation must still happen — anything else risks a
  // stale UI after a transient daemon hiccup.
  it("invalidates the workspace query even when the fetch itself rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPushWorkspace(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate({ workspaceId: "7", body: {} });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toEqual(expect.arrayContaining([["workspaces", "7"]]));
  });
});
