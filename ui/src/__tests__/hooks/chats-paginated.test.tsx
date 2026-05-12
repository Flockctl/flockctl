import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { useChatsPaginated } from "@/lib/hooks/chats";

/**
 * Contract tests for {@link useChatsPaginated}.
 *
 * The hook is the engine behind the `/chats` page's load-more behaviour
 * — without it, anyone with more than 20 chats silently lost the tail
 * of their list because the server's default page size capped at 20.
 *
 * The cases below pin the load-more state machine end-to-end:
 *   - first page populates `items` + `total` + `hasMore`
 *   - load-more APPENDS without reseeding (so a Load-more click after
 *     scrolling 100 chats doesn't snap back to the first 50)
 *   - changing the filter resets the accumulator (otherwise stale
 *     project-A chats would linger after switching to project-B)
 *   - de-dup on overlapping pages (a chat created mid-pagination would
 *     otherwise appear twice — once in page 1 because it's at the top,
 *     once in page 2 if pagination boundary shifted)
 *   - server-trusted `total` (the snapshot may move if another tab
 *     created or deleted chats)
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
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

// Build a chat row matching the fields the hook touches. Keep it terse
// — the hook only reads `id` for de-dup and forwards the rest to the
// caller, so we don't need to fabricate the full ChatResponse shape.
function makeChat(id: number) {
  return {
    id: String(id),
    title: `chat-${id}`,
    project_id: null,
    project_name: null,
    workspace_id: null,
    workspace_name: null,
    entity_type: null,
    entity_id: null,
    pinned: false,
    is_streaming: false,
    permission_mode: null,
    ai_provider_key_id: null,
    model: null,
    requires_approval: false,
    approval_status: null,
    thinking_enabled: false,
    effort: null,
    last_message_at: null,
    updated_at: new Date(2024, 0, 1, 0, 0, id).toISOString(),
    created_at: new Date(2024, 0, 1, 0, 0, id).toISOString(),
    metrics: null,
  };
}

beforeEach(() => {
  // setup.ts ships a fresh fetch mock per test; we install our own
  // implementation below.
});

describe("useChatsPaginated", () => {
  it("seeds items + total + hasMore from the first server page", async () => {
    const items = [makeChat(1), makeChat(2)];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ items, total: 5, page: 1, perPage: 50 }),
      );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(50), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.items.map((c) => c.id)).toEqual(["1", "2"]);
    expect(result.current.total).toBe(5);
    // Server claims 5 total, we have 2 — load-more affordance must show.
    expect(result.current.hasMore).toBe(true);

    // First request must carry the offset/limit query params — the
    // entire premise of this hook is that the server actually receives
    // a paginated request, not the legacy un-paginated default.
    const firstUrl = fetchMock.mock.calls[0]![0] as string;
    expect(firstUrl).toContain("offset=0");
    expect(firstUrl).toContain("limit=50");
  });

  it("hasMore is false when the first page already covers the total", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [makeChat(1), makeChat(2)],
        total: 2,
        page: 1,
        perPage: 50,
      }),
    );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(50), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore appends the next page without resetting the accumulator", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          items: [makeChat(1), makeChat(2)],
          total: 4,
          page: 1,
          perPage: 2,
        });
      }
      return jsonResponse({
        items: [makeChat(3), makeChat(4)],
        total: 4,
        page: 2,
        perPage: 2,
      });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(2), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((c) => c.id)).toEqual(["1", "2"]);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((c) => c.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(result.current.hasMore).toBe(false);

    // The follow-up request must advance the offset, not refetch page 1.
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toContain("offset=2");
    expect(secondUrl).toContain("limit=2");
  });

  it("loadMore is a no-op when already at the end (hasMore=false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [makeChat(1)],
        total: 1,
        page: 1,
        perPage: 50,
      }),
    );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(50), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });

    // Only the first page request should have happened — loadMore was
    // a no-op, not a duplicate fetch that'd waste a round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);
  });

  it("de-dupes overlapping ids when a chat appears in two adjacent pages", async () => {
    // Mid-pagination scenario: the user loads page 1 (chats 1, 2), then
    // a fresh chat (id 99) gets created and slotted at the top by the
    // server's `(pinned DESC, last_message_at DESC)` order. When the
    // user clicks Load-more, the server's offset=2 page now starts
    // with what used to be chat 2 — so chat 2 would appear in BOTH
    // pages without de-duplication.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          items: [makeChat(1), makeChat(2)],
          total: 4,
          page: 1,
          perPage: 2,
        });
      }
      // Page 2 deliberately re-includes chat 2 to simulate the shifted
      // boundary. Without de-dup the merged list would have ['1','2','2','3'].
      return jsonResponse({
        items: [makeChat(2), makeChat(3)],
        total: 4,
        page: 2,
        perPage: 2,
      });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(2), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("trusts the server's latest `total` after each loadMore", async () => {
    // Another tab created a chat between page 1 and page 2 — the
    // server's total bumps from 4 to 5. The hook must surface the
    // newer count (so `hasMore` stays accurate), not the stale page-1
    // snapshot.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return jsonResponse({
        items: [makeChat(call * 10), makeChat(call * 10 + 1)],
        total: call === 1 ? 4 : 5,
        page: call,
        perPage: 2,
      });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(2), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.total).toBe(4);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.total).toBe(5);
    // 4 loaded, 5 total — affordance still showing.
    expect(result.current.hasMore).toBe(true);
  });

  it("resets the accumulator when the filter changes", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("project_id=1")) {
        return jsonResponse({
          items: [makeChat(1), makeChat(2)],
          total: 2,
          page: 1,
          perPage: 50,
        });
      }
      return jsonResponse({
        items: [makeChat(99)],
        total: 1,
        page: 1,
        perPage: 50,
      });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useChatsPaginated(50, { projectId }),
      {
        wrapper: Wrapper,
        initialProps: { projectId: "1" },
      },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((c) => c.id)).toEqual(["1", "2"]);

    // Switch project. The accumulator must reset to the new server
    // snapshot — otherwise project-1 chats would still be pinned at the
    // top of the project-2 list.
    rerender({ projectId: "2" });
    await waitFor(() =>
      expect(result.current.items.map((c) => c.id)).toEqual(["99"]),
    );
  });

  it("surfaces loadMoreError when the server rejects the next page", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          items: [makeChat(1)],
          total: 5,
          page: 1,
          perPage: 1,
        });
      }
      return jsonResponse({ error: "boom" }, 500);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useChatsPaginated(1), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.loadMoreError).not.toBeNull();
    expect(result.current.loadMoreError?.message).toMatch(/boom/i);
    // Items must NOT have been corrupted by the failed append.
    expect(result.current.items.map((c) => c.id)).toEqual(["1"]);
    // The error doesn't flip `hasMore` off — the user can retry.
    expect(result.current.hasMore).toBe(true);
  });
});
