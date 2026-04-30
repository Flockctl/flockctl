import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useTasks,
  useTask,
  useCreateTask,
  useCancelTask,
  useApproveTask,
  useRejectTask,
  useWorkspaces,
  useProjects,
  useProject,
  useCreateProject,
  useDeleteProject,
  useGitPullProject,
  useUpdateProject,
  useCreateWorkspace,
  useDeleteWorkspace,
  useTemplates,
  useCreateTemplate,
  useSchedules,
  useCreateSchedule,
  useChatStream,
} from "@/lib/hooks";

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
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

beforeEach(() => {
  // setup.ts installs a fresh fetch mock per test
});

describe("task hooks", () => {
  it("useTasks calls /tasks with query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [], total: 0, limit: 20, offset: 5 }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useTasks(5, 20, { status: "running" }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/tasks?");
    expect(url).toContain("offset=5");
    expect(url).toContain("limit=20");
    expect(url).toContain("status=running");
  });

  it("useTasks omits empty filter values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(
      () => useTasks(0, 50, { status: undefined as any, project_id: "" as any }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).not.toContain("status=");
    expect(url).not.toContain("projectId=");
  });

  it("useTask does not fire when taskId is empty", () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    renderHook(() => useTask(""), { wrapper: Wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("useCreateTask POSTs to /tasks and invalidates list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateTask(), { wrapper: Wrapper });
    result.current.mutate({ projectId: "1", prompt: "hi" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toBe("/tasks");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("useCancelTask POSTs to /tasks/:id/cancel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCancelTask(), { wrapper: Wrapper });
    result.current.mutate("42");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/tasks/42/cancel");
    expect(init.method).toBe("POST");
  });

  it("useApproveTask sends note in body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useApproveTask(), { wrapper: Wrapper });
    result.current.mutate({ taskId: "7", note: "LGTM" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/tasks/7/approve");
    expect(JSON.parse(init.body).note).toBe("LGTM");
  });

  it("useRejectTask POSTs to reject endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useRejectTask(), { wrapper: Wrapper });
    result.current.mutate({ taskId: "7", note: "no" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/tasks/7/reject");
  });
});

describe("workspace hooks", () => {
  it("useWorkspaces GETs /workspaces", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useWorkspaces(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces");
  });

  it("useCreateWorkspace POSTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateWorkspace(), { wrapper: Wrapper });
    result.current.mutate({ name: "ws" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("useDeleteWorkspace DELETEs by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useDeleteWorkspace(), { wrapper: Wrapper });
    result.current.mutate("9");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces/9");
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
  });
});

describe("project hooks", () => {
  it("useProjects GETs /projects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useProjects(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/projects");
  });

  it("useProject does not fire for empty id", () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    renderHook(() => useProject(""), { wrapper: Wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("useCreateProject POSTs /projects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateProject(), { wrapper: Wrapper });
    result.current.mutate({ name: "p" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toBe("/projects");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("useUpdateProject PATCHes /projects/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useUpdateProject(), { wrapper: Wrapper });
    result.current.mutate({ id: "1", data: { name: "renamed" } as any });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/projects/1");
    expect(fetchMock.mock.calls[0]![1].method).toBe("PATCH");
  });

  it("useDeleteProject DELETEs /projects/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useDeleteProject(), { wrapper: Wrapper });
    result.current.mutate("1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/projects/1");
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
  });

  // ─── useGitPullProject ──────────────────────────────────────────────────
  // The mutation always resolves with HTTP 200 — outcome is encoded in the
  // body's discriminated `ok` flag — so these tests pin the cache-
  // invalidation contract per outcome shape, not just the wire call.
  // Pulling new commits MUST invalidate `project()` and `projectTree()`
  // (because anything reading from disk is now stale), but already-up-
  // to-date and structured failures MUST NOT (a refetch on no-op or on
  // an error would just thrash the UI right when the user wants the
  // result modal to render cleanly).

  it("useGitPullProject POSTs /projects/:id/git-pull", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        alreadyUpToDate: true,
        beforeSha: "abc",
        afterSha: "abc",
        branch: "main",
        commitsPulled: 0,
        filesChanged: 0,
        summary: "Already up to date.",
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useGitPullProject(), { wrapper: Wrapper });
    result.current.mutate("42");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/projects/42/git-pull");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("useGitPullProject invalidates project + projectTree when commits were pulled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        alreadyUpToDate: false,
        beforeSha: "a".repeat(40),
        afterSha: "b".repeat(40),
        branch: "main",
        commitsPulled: 1,
        filesChanged: 2,
        summary: "Pulled 1 commit, 2 files changed.",
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPullProject(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("7");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Two invalidations: project(7) and projectTree(7). We assert the
    // count plus the queryKey shape for each, so a future renaming of
    // either key is caught by the test.
    expect(spy).toHaveBeenCalledTimes(2);
    const calls = spy.mock.calls.map((c) => c[0]?.queryKey);
    // Shapes from `queryKeys.project(id)` and `queryKeys.projectTree(id)` —
    // both start with `["projects", "7", ...]`. We pin both the project
    // detail key (length 2) and the tree key (length 3 with "tree" tail)
    // so a future split of the namespace is caught.
    expect(calls).toEqual(
      expect.arrayContaining([
        ["projects", "7"],
        ["projects", "7", "tree"],
      ]),
    );
  });

  it("useGitPullProject does NOT invalidate when already up to date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        alreadyUpToDate: true,
        beforeSha: "a",
        afterSha: "a",
        branch: "main",
        commitsPulled: 0,
        filesChanged: 0,
        summary: "Already up to date.",
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPullProject(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("7");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalled();
  });

  it("useGitPullProject does NOT invalidate on a structured failure (ok:false)", async () => {
    // Server returned 200 with `{ ok: false }` — caller's mutation reports
    // success (the HTTP request worked), but nothing changed on disk so
    // there is nothing to refetch.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        reason: "dirty_working_tree",
        message: "Working tree has uncommitted changes (3 files).",
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useGitPullProject(), { wrapper: Wrapper });
    act(() => {
      result.current.mutate("7");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The mutation itself succeeded (HTTP 200) — the data field carries
    // the structured failure. No invalidation should have fired.
    expect(result.current.data?.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("template + schedule hooks", () => {
  it("useTemplates GETs /templates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useTemplates(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/templates");
  });

  it("useCreateTemplate POSTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateTemplate(), { wrapper: Wrapper });
    result.current.mutate({ name: "t" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });

  it("useSchedules GETs /schedules", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSchedules(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![0]).toContain("/schedules");
  });

  it("useCreateSchedule POSTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateSchedule(), { wrapper: Wrapper });
    result.current.mutate({
      template_scope: "global",
      template_name: "x",
      schedule_type: "cron",
    } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });
});

describe("useChatStream", () => {
  it("cancelStream POSTs /chats/:id/cancel so the backend session is aborted", async () => {
    // Hang the SSE body forever — we want the stream to be "live" when we
    // trigger cancelStream so the chatId ref is populated.
    const controllerRef: { c: ReadableStreamDefaultController<Uint8Array> | null } = { c: null };
    const body = new ReadableStream<Uint8Array>({
      start(c) { controllerRef.c = c; },
    });
    const streamResponse = new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith("/cancel")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(streamResponse);
    });
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });

    act(() => {
      void result.current.startStream("42", { content: "hi" } as any);
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    act(() => { result.current.cancelStream(); });

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([u]) =>
        typeof u === "string" && u.endsWith("/chats/42/cancel"),
      );
      expect(cancelCall).toBeTruthy();
      expect(cancelCall![1].method).toBe("POST");
    });

    // Drain the still-open stream so the hook's reader loop can finish
    // cleanly after the abort, avoiding a hanging unresolved promise.
    try { controllerRef.c?.close(); } catch { /* already aborted */ }
  });

  it("cancelStream is a no-op when no stream is active", () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });
    act(() => { result.current.cancelStream(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancelStream(chatId) still POSTs /cancel after a page reload (no local stream)", async () => {
    // Simulates the post-reload case: this hook instance never opened the
    // stream, so its internal ref is null. The caller (chat-conversation)
    // passes the chatId explicitly so the backend session can still be
    // aborted from the fresh tab.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatStream(), { wrapper: Wrapper });
    expect(result.current.isStreaming).toBe(false);
    act(() => { result.current.cancelStream("77"); });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) =>
        typeof u === "string" && u.endsWith("/chats/77/cancel"),
      );
      expect(call).toBeTruthy();
      expect(call![1].method).toBe("POST");
    });
  });
});
