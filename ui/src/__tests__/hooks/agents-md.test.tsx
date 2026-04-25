import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useProjectAgentsMd,
  usePutProjectAgentsMd,
  useWorkspaceAgentsMd,
  usePutWorkspaceAgentsMd,
} from "@/lib/hooks/agents-md";

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

describe("agents-md hooks — single public layer per scope", () => {
  it("useProjectAgentsMd fetches the project layer and preserves hyphenated keys", async () => {
    // Server returns the single-layer payload. Hyphenated keys must pass
    // through untouched because the API client uses `rawKeys: true`.
    const payload = {
      layers: {
        "project-public": { present: true, bytes: 7, content: "public!" },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useProjectAgentsMd("42"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // URL is correct.
    expect(fetchMock.mock.calls[0]![0]).toContain("/projects/42/agents-md");
    // Layer map comes back verbatim — hyphenated keys preserved,
    // `present`/`bytes`/`content` fields all intact.
    expect(result.current.data).toEqual(payload);
    expect(result.current.data?.layers["project-public"].content).toBe("public!");
  });

  it("useWorkspaceAgentsMd fetches the workspace layer and preserves hyphenated keys", async () => {
    const payload = {
      layers: {
        "workspace-public": { present: true, bytes: 3, content: "pub" },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => useWorkspaceAgentsMd("9"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toContain("/workspaces/9/agents-md");
    expect(result.current.data?.layers["workspace-public"].content).toBe("pub");
  });

  it("usePutProjectAgentsMd PUTs the single content body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ layer: "project-public", present: true, bytes: 5 }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePutProjectAgentsMd(), { wrapper: Wrapper });
    result.current.mutate({ projectId: "42", content: "hello" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Method + URL.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/projects/42/agents-md");
    expect(init.method).toBe("PUT");

    // Body contains exactly { content } — no `layer` field; the server
    // derives the layer from the scope of the route. `rawKeys: true` means
    // keys are NOT camelCase-converted.
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ content: "hello" });
  });

  it("usePutWorkspaceAgentsMd PUTs the single content body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ layer: "workspace-public", present: true, bytes: 2 }),
    );
    (globalThis as any).fetch = fetchMock;

    const { Wrapper } = wrap();
    const { result } = renderHook(() => usePutWorkspaceAgentsMd(), { wrapper: Wrapper });
    result.current.mutate({ workspaceId: "9", content: "hi" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/workspaces/9/agents-md");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ content: "hi" });
  });
});
