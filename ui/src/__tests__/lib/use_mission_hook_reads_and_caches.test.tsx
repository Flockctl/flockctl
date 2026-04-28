import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { useMission, useMissions, type Mission } from "@/lib/hooks";

/**
 * Slice 11/04 — `useMission` / `useMissions` cache contract.
 *
 * These tests pin the two invariants the parent slice relies on:
 *
 *   1. `useMission(id)` and `useMissions(projectId)` actually call the
 *      backend (`/missions/:id` and `/projects/:id/missions`) and return
 *      the parsed body to the consumer.
 *   2. Two simultaneous consumers of the SAME id (or projectId) share the
 *      same react-query cache entry — only ONE network request fires.
 *
 * The second invariant is the one the tree-panel + future mission-detail
 * rail rely on: mounting both surfaces side-by-side must not double the
 * request count.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 5 * 60_000 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

/**
 * The wire response (what fetch resolves) is camelCase — that's what the
 * router emits. `apiFetch` rewrites keys to snake_case + coerces `*_id`
 * numbers to strings before handing the data to the hook, so the consumer
 * sees the SNAKE_CASE_DECODED shape below. Both fixtures live here so the
 * test asserts the round-trip and not just one side.
 */
const MISSION_WIRE = {
  id: "mission-abc",
  projectId: 42,
  objective: "Make the dashboard fast",
  status: "active",
  autonomy: "suggest",
  budgetTokens: 1_000_000,
  budgetUsdCents: 5_000,
  spentTokens: 12_345,
  spentUsdCents: 67,
  supervisorPromptVersion: "v1",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
};

const MISSION_FIXTURE: Mission = {
  id: "mission-abc",
  project_id: "42",
  objective: "Make the dashboard fast",
  status: "active",
  autonomy: "suggest",
  budget_tokens: 1_000_000,
  budget_usd_cents: 5_000,
  spent_tokens: 12_345,
  spent_usd_cents: 67,
  supervisor_prompt_version: "v1",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_500,
};

beforeEach(() => {
  // setup.ts installs a fresh fetch mock per test
});

describe("use_mission_hook_reads_and_caches — useMission(id)", () => {
  it("calls GET /missions/:id and returns the parsed body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(MISSION_WIRE));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMission("mission-abc"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MISSION_FIXTURE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/missions/mission-abc");
  });

  it("two concurrent consumers of the same id share the cache (one request)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(MISSION_WIRE));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();

    // Two hooks, same id, same provider — only one network call should fly.
    const { result: a } = renderHook(() => useMission("mission-abc"), {
      wrapper: Wrapper,
    });
    const { result: b } = renderHook(() => useMission("mission-abc"), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(a.current.isSuccess).toBe(true);
      expect(b.current.isSuccess).toBe(true);
    });

    expect(a.current.data).toEqual(MISSION_FIXTURE);
    expect(b.current.data).toEqual(MISSION_FIXTURE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is disabled when id is empty (no fetch fires)", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    renderHook(() => useMission(""), { wrapper: Wrapper });

    // Give react-query a microtask to settle. With enabled:false, no fetch
    // should ever fire — so a tiny wait is safe (and intentional).
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a second consumer mounted AFTER the first resolves uses the cache (still one fetch)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(MISSION_WIRE));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result: a } = renderHook(() => useMission("mission-abc"), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(a.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second consumer of the SAME id — should hydrate from the cache without
    // a second network round-trip. (staleTime=5m above keeps it fresh.)
    const { result: b } = renderHook(() => useMission("mission-abc"), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(b.current.isSuccess).toBe(true));
    expect(b.current.data).toEqual(MISSION_FIXTURE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("use_mission_hook_reads_and_caches — useMissions(projectId)", () => {
  it("calls GET /projects/:projectId/missions and returns the items list", async () => {
    const wire = { items: [MISSION_WIRE] };
    const decoded = { items: [MISSION_FIXTURE] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(wire));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMissions("42"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(decoded);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/projects/42/missions");
  });

  it("shares the cache across two consumers of the same projectId", async () => {
    const wire = { items: [MISSION_WIRE] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(wire));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result: a } = renderHook(() => useMissions("42"), {
      wrapper: Wrapper,
    });
    const { result: b } = renderHook(() => useMissions("42"), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(a.current.isSuccess).toBe(true);
      expect(b.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is disabled for an empty projectId", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    renderHook(() => useMissions(""), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
