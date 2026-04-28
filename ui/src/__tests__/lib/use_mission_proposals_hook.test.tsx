import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import {
  useMissionProposals,
  type MissionProposalsResponse,
} from "@/lib/hooks/missions";

/**
 * Slice 11/06 — `useMissionProposals` cache + filter contract.
 *
 * Pins:
 *   1. Default filter is `pending` (no explicit `status` arg).
 *   2. URL is `/missions/:id/proposals?status=…`.
 *   3. Switching the filter creates a new cache entry — does NOT collapse
 *      `pending` and `dismissed` into one row.
 *   4. `enabled: !!missionId` guard suppresses the request when id is "".
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

const PROPOSALS_WIRE = {
  items: [
    {
      id: "evt-1",
      missionId: "mission-abc",
      kind: "remediation_proposed",
      payload: { rationale: "x", proposal: { target_type: "slice" } },
      costTokens: 100,
      costUsdCents: 5,
      depth: 0,
      createdAt: 1_700_000_000,
    },
  ],
  total: 1,
  status: "pending" as const,
};

const PROPOSALS_DECODED: MissionProposalsResponse = {
  items: [
    {
      id: "evt-1",
      mission_id: "mission-abc",
      kind: "remediation_proposed",
      payload: { rationale: "x", proposal: { target_type: "slice" } },
      cost_tokens: 100,
      cost_usd_cents: 5,
      depth: 0,
      created_at: 1_700_000_000,
    },
  ],
  total: 1,
  status: "pending",
};

beforeEach(() => {
  // setup.ts installs a fresh fetch mock per test
});

describe("use_mission_proposals_hook — useMissionProposals(id)", () => {
  it("calls GET /missions/:id/proposals?status=pending by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PROPOSALS_WIRE));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMissionProposals("mission-abc"), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(PROPOSALS_DECODED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/missions/mission-abc/proposals");
    expect(String(url)).toContain("status=pending");
  });

  it("respects an explicit status filter (dismissed)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...PROPOSALS_WIRE, status: "dismissed" }));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useMissionProposals("mission-abc", { status: "dismissed" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("status=dismissed");
  });

  it("status=all hits the all-proposals view", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...PROPOSALS_WIRE, status: "all" }));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useMissionProposals("mission-abc", { status: "all" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("status=all");
  });

  it("two consumers of the same (id, status) share the cache (one fetch)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PROPOSALS_WIRE));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result: a } = renderHook(
      () => useMissionProposals("mission-abc"),
      { wrapper: Wrapper },
    );
    const { result: b } = renderHook(
      () => useMissionProposals("mission-abc"),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(a.current.isSuccess).toBe(true);
      expect(b.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("different statuses on the same mission are independent cache entries (two fetches)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PROPOSALS_WIRE))
      .mockResolvedValueOnce(jsonResponse({ ...PROPOSALS_WIRE, status: "dismissed" }));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    const { result: pending } = renderHook(
      () => useMissionProposals("mission-abc", { status: "pending" }),
      { wrapper: Wrapper },
    );
    const { result: dismissed } = renderHook(
      () => useMissionProposals("mission-abc", { status: "dismissed" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(pending.current.isSuccess).toBe(true);
      expect(dismissed.current.isSuccess).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("status=pending"))).toBe(true);
    expect(urls.some((u) => u.includes("status=dismissed"))).toBe(true);
  });

  it("is disabled for an empty missionId (no fetch fires)", async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const { Wrapper } = makeWrapper();
    renderHook(() => useMissionProposals(""), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
