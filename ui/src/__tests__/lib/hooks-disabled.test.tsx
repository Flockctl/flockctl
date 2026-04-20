import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useWorkspaceDisabledSkills,
  useToggleWorkspaceDisabledSkill,
  useProjectDisabledSkills,
  useToggleProjectDisabledSkill,
  useWorkspaceDisabledMcpServers,
  useToggleWorkspaceDisabledMcpServer,
  useProjectDisabledMcpServers,
  useToggleProjectDisabledMcpServer,
} from "@/lib/hooks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wrapper() {
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

describe("useWorkspaceDisabledSkills", () => {
  it("fetches and exposes disabled_skills as DisableEntry[]", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ disabledSkills: [{ name: "planning", level: "global" }] }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useWorkspaceDisabledSkills("7"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.disabled_skills).toEqual([
      { name: "planning", level: "global" },
    ]);
  });

  it("skips fetch when workspaceId is empty", () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    renderHook(() => useWorkspaceDisabledSkills(""), { wrapper: Wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useToggleWorkspaceDisabledSkill", () => {
  it("POSTs {name, level} when disable=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ disabledSkills: [{ name: "planning", level: "global" }] }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useToggleWorkspaceDisabledSkill("7"), { wrapper: Wrapper });
    result.current.mutate({ name: "planning", level: "global", disable: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/skills/workspaces/7/disabled");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "planning", level: "global" });
  });

  it("DELETEs with {name, level} body when disable=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ disabledSkills: [] }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useToggleWorkspaceDisabledSkill("7"), { wrapper: Wrapper });
    result.current.mutate({ name: "planning", level: "global", disable: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/skills/workspaces/7/disabled");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "planning", level: "global" });
  });

  it("invalidates the disabled-skills query on success", async () => {
    const fetchMock = vi.fn();
    // 1st fetch: initial GET
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ disabledSkills: [] }),
    );
    // 2nd fetch: mutation POST
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ disabledSkills: [{ name: "planning", level: "global" }] }),
    );
    // 3rd fetch: refetch after invalidation
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ disabledSkills: [{ name: "planning", level: "global" }] }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrapper();
    const { result: queryResult } = renderHook(
      () => useWorkspaceDisabledSkills("7"),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(queryResult.current.isSuccess).toBe(true));

    const { result: mutationResult } = renderHook(
      () => useToggleWorkspaceDisabledSkill("7"),
      { wrapper: Wrapper },
    );
    mutationResult.current.mutate({ name: "planning", level: "global", disable: true });
    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true));

    // At least 3 fetches: initial GET, mutation POST, refetched GET
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("useProjectDisabledSkills / toggle", () => {
  it("toggle POSTs to /skills/projects/:pid/disabled with body including level", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ disabledSkills: [{ name: "debug", level: "workspace" }] }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useToggleProjectDisabledSkill("42"), { wrapper: Wrapper });
    result.current.mutate({ name: "debug", level: "workspace", disable: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/skills/projects/42/disabled");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "debug", level: "workspace" });
  });

  it("query skipped when projectId empty", () => {
    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    renderHook(() => useProjectDisabledSkills(""), { wrapper: Wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useToggleWorkspaceDisabledMcpServer", () => {
  it("POSTs to /mcp/workspaces/:id/disabled-mcp (not /disabled) with {name, level}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ disabledMcpServers: [{ name: "github", level: "global" }] }),
    );
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useToggleWorkspaceDisabledMcpServer("7"), { wrapper: Wrapper });
    result.current.mutate({ name: "github", level: "global", disable: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/mcp/workspaces/7/disabled-mcp");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "github", level: "global" });
  });
});

describe("useToggleProjectDisabledMcpServer", () => {
  it("DELETEs /mcp/projects/:pid/disabled-mcp with body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ disabledMcpServers: [] }));
    (globalThis as any).fetch = fetchMock;
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useToggleProjectDisabledMcpServer("42"), { wrapper: Wrapper });
    result.current.mutate({ name: "srv", level: "workspace", disable: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/mcp/projects/42/disabled-mcp");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "srv", level: "workspace" });
  });
});

describe("useWorkspaceDisabledMcpServers / useProjectDisabledMcpServers", () => {
  it("fetches workspace disabled mcp list", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ disabledMcpServers: [{ name: "github", level: "global" }] }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useWorkspaceDisabledMcpServers("7"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.disabled_mcp_servers).toEqual([
      { name: "github", level: "global" },
    ]);
  });

  it("fetches project disabled mcp list", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue(
      jsonResponse({ disabledMcpServers: [{ name: "srv", level: "project" }] }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useProjectDisabledMcpServers("42"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.disabled_mcp_servers).toEqual([
      { name: "srv", level: "project" },
    ]);
  });
});
