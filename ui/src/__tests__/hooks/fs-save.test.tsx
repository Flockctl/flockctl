import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useSaveProjectFile,
  projectFileQueryKey,
} from "@/lib/hooks/fs";
import type { FsReadResponse, FsWriteResponse } from "@/lib/api/fs";

// fs-save.test — unit-test the save mutation in isolation. We mock the
// global `fetch` (the same pattern setup.ts installs in beforeEach) so the
// tests assert request-shape and cache-side-effects without touching a real
// daemon. The two cache-related invariants this suite pins down:
//
//   1. On a clean save, the read-cache for `['project-file', projectId, path]`
//      is patched in place with the new content + sha. No invalidation
//      round-trip is required for the editor to see "the saved version".
//
//   2. On `fs_sha_conflict`, the read-cache is left untouched. Touching it
//      would silently advance the editor's baseline `expectedSha` and turn
//      the next save into a fresh write rather than a conflict resolution
//      — defeating the whole point of optimistic concurrency control.
//
// HTTP-200-with-`ok:false` is the conflict transport: the mutation does NOT
// throw on a conflict (so `mutation.isError === false`), it just resolves
// with the discriminated failure envelope. Callers branch on `result.ok`.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrap() {
  // `gcTime: Infinity` because tests seed the cache via `setQueryData` for
  // keys that have no React Query observers — the default `gcTime: 0` would
  // sweep those entries out before the assertion ran. The other defaults
  // mirror the rest of the hook test suite.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

beforeEach(() => {
  // setup.ts already installs a fresh `fetch` mock; we just override
  // per-test so `mockResolvedValueOnce` chains are predictable.
});

describe("useSaveProjectFile — request shape", () => {
  it("PUTs to /projects/:id/fs/file?path=… with { content, expectedSha, allowCreate } in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: "f".repeat(64),
        mtime: 1_700_000_000_000,
        size: 5,
      } satisfies FsWriteResponse),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSaveProjectFile("42"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "src/foo.ts",
      content: "hello",
      expectedSha: "a".repeat(64),
      allowCreate: false,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    // URL: project id baked into the path; `path=…` lives in the query
    // string so the body can stay focused on payload fields. URL-encoded
    // because `URLSearchParams` does that for us.
    expect(url).toContain("/projects/42/fs/file?path=src%2Ffoo.ts");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");

    // Body uses camelCase keys (`expectedSha`, `allowCreate`) — `rawKeys: true`
    // on the apiFetch call disables the snake-case round-trip so the server
    // sees what we sent.
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      content: "hello",
      expectedSha: "a".repeat(64),
      allowCreate: false,
    });
  });

  it("defaults allowCreate to false when the caller omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: "0".repeat(64),
        mtime: 1,
        size: 0,
      } satisfies FsWriteResponse),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSaveProjectFile("7"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "x.txt",
      content: "",
      expectedSha: "",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.allowCreate).toBe(false);
  });
});

describe("useSaveProjectFile — success patches the read cache", () => {
  it("on ok:true, sets ['project-file', projectId, path] to the saved content + new sha", async () => {
    const newSha = "b".repeat(64);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: newSha,
        mtime: 1_700_000_000_500,
        size: 11,
      } satisfies FsWriteResponse),
    );
    (globalThis as any).fetch = fetchMock;

    const { qc, Wrapper } = wrap();

    // Seed the cache with the editor's current view — this is what the read
    // hook would have populated on the initial GET.
    const initial: FsReadResponse = {
      ok: true,
      content: "old text",
      sha: "a".repeat(64),
      mtime: 1_700_000_000_000,
      size: 8,
      encoding: "utf-8",
    };
    qc.setQueryData(projectFileQueryKey("42", "AGENTS.md"), initial);

    const { result } = renderHook(() => useSaveProjectFile("42"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "AGENTS.md",
      content: "hello world",
      expectedSha: "a".repeat(64),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Cache reflects the just-saved state — same key, full FsReadSuccess
    // envelope with the new sha / mtime / size.
    const cached = qc.getQueryData<FsReadResponse>(
      projectFileQueryKey("42", "AGENTS.md"),
    );
    expect(cached).toEqual({
      ok: true,
      content: "hello world",
      sha: newSha,
      mtime: 1_700_000_000_500,
      size: 11,
      encoding: "utf-8",
    });
  });

  it("populates the cache from scratch even if the read-query never ran", async () => {
    // Save-as-create path: the editor opened a fresh file and saves before
    // any read would have populated the cache. The mutation must still leave
    // a coherent FsReadSuccess in place so a later useProjectFile mount
    // renders synchronously without an extra round-trip.
    const newSha = "c".repeat(64);
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        sha: newSha,
        mtime: 42,
        size: 3,
      } satisfies FsWriteResponse),
    );

    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => useSaveProjectFile("9"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "new.md",
      content: "abc",
      expectedSha: "",
      allowCreate: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      qc.getQueryData<FsReadResponse>(projectFileQueryKey("9", "new.md")),
    ).toEqual({
      ok: true,
      content: "abc",
      sha: newSha,
      mtime: 42,
      size: 3,
      encoding: "utf-8",
    });
  });
});

describe("useSaveProjectFile — fs_sha_conflict leaves the cache alone", () => {
  it("returns the conflict envelope to the caller without touching the cache", async () => {
    const currentSha = "d".repeat(64);
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        error_code: "fs_sha_conflict",
        currentSha,
        message: "expected sha did not match on-disk sha",
      } satisfies FsWriteResponse),
    );

    const { qc, Wrapper } = wrap();

    // The cache is the editor's source of truth for the baseline sha. A
    // conflict must NOT advance it — that would pretend the next save is a
    // fresh write rather than a still-pending merge.
    const baseline: FsReadResponse = {
      ok: true,
      content: "the content the editor opened with",
      sha: "a".repeat(64),
      mtime: 1,
      size: 33,
      encoding: "utf-8",
    };
    qc.setQueryData(projectFileQueryKey("42", "AGENTS.md"), baseline);

    const { result } = renderHook(() => useSaveProjectFile("42"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "AGENTS.md",
      content: "user typed something the server rejected",
      expectedSha: "a".repeat(64),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // HTTP 200 with ok:false — the mutation resolves successfully (not an
    // error from React Query's perspective) and the structured envelope
    // is what the UI's conflict-resolution flow needs.
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toMatchObject({
      ok: false,
      error_code: "fs_sha_conflict",
      currentSha,
    });

    // Cache is exactly what it was before the mutation ran — the baseline
    // sha, content, and metadata all survived the failed save.
    expect(
      qc.getQueryData<FsReadResponse>(projectFileQueryKey("42", "AGENTS.md")),
    ).toEqual(baseline);
  });

  it("on a non-conflict failure (fs_path_outside_project), still leaves the cache alone and surfaces the envelope", async () => {
    // Negative path coverage: the conflict branch is the high-stakes one,
    // but the same "do not invalidate on !ok" rule has to hold for every
    // ok:false envelope, otherwise a path-traversal probe could be used to
    // poison the read-cache for the targeted file.
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        error_code: "fs_path_outside_project",
        message: "path escapes the entity root",
      } satisfies FsWriteResponse),
    );

    const { qc, Wrapper } = wrap();

    const baseline: FsReadResponse = {
      ok: true,
      content: "untouched",
      sha: "e".repeat(64),
      mtime: 7,
      size: 9,
      encoding: "utf-8",
    };
    qc.setQueryData(projectFileQueryKey("42", "../../etc/passwd"), baseline);

    const { result } = renderHook(() => useSaveProjectFile("42"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "../../etc/passwd",
      content: "haha",
      expectedSha: "e".repeat(64),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isError).toBe(false);
    expect(result.current.data).toMatchObject({
      ok: false,
      error_code: "fs_path_outside_project",
    });
    expect(
      qc.getQueryData<FsReadResponse>(
        projectFileQueryKey("42", "../../etc/passwd"),
      ),
    ).toEqual(baseline);
  });
});

describe("useSaveProjectFile — network failure is a real mutation error", () => {
  it("a thrown fetch (HTTP 500 / dropped connection) surfaces as mutation.isError", async () => {
    // A 5xx flips the apiFetch into its `throw` branch; the mutation should
    // expose that as `isError === true` so the editor can keep the dirty
    // buffer and show a "retry" affordance — the failure-mode the slice
    // calls out (`dep_fails: Network error mid-save`).
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { qc, Wrapper } = wrap();

    const baseline: FsReadResponse = {
      ok: true,
      content: "still the original",
      sha: "a".repeat(64),
      mtime: 1,
      size: 18,
      encoding: "utf-8",
    };
    qc.setQueryData(projectFileQueryKey("42", "x.md"), baseline);

    const { result } = renderHook(() => useSaveProjectFile("42"), {
      wrapper: Wrapper,
    });

    result.current.mutate({
      path: "x.md",
      content: "edits",
      expectedSha: "a".repeat(64),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Cache is preserved across a thrown fetch — `onSuccess` never runs, so
    // there is nothing to write into the read-cache.
    expect(
      qc.getQueryData<FsReadResponse>(projectFileQueryKey("42", "x.md")),
    ).toEqual(baseline);
  });
});
