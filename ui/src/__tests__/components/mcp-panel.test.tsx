import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { McpPanel } from "@/components/mcp-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(props: {
  level: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <McpPanel {...props} />
    </QueryClientProvider>,
  );
}

function makeRouter(routes: Record<string, any>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ method, url, body });
    if (key in routes) return jsonResponse(routes[key]);
    if (url in routes) return jsonResponse(routes[url]);
    throw new Error(`unmocked fetch: ${key}`);
  });
  return { mock, calls };
}

beforeEach(() => {
  (globalThis as any).fetch = vi.fn();
});

describe("McpPanel — workspace scope", () => {
  it("renders global servers as inherited and marks disabled ones", async () => {
    const { mock } = makeRouter({
      "/mcp/global": [{ name: "github", level: "global", config: { command: "npx" } }],
      "/mcp/workspaces/7/servers": [],
      "/mcp/workspaces/7/disabled-mcp": {
        disabledMcpServers: [{ name: "github", level: "global" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });

    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("click Eye uses /disabled-mcp path (not /disabled) and body {name, level}", async () => {
    const { mock, calls } = makeRouter({
      "/mcp/global": [{ name: "github", level: "global", config: { command: "npx" } }],
      "/mcp/workspaces/7/servers": [],
      "/mcp/workspaces/7/disabled-mcp": {
        disabledMcpServers: [{ name: "github", level: "global" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());

    const btn = await screen.findByTitle("Enable at workspace");
    await userEvent.click(btn);

    await waitFor(() => {
      const deleteCall = calls.find((c) => c.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.url).toBe("/mcp/workspaces/7/disabled-mcp");
      expect(deleteCall!.body).toEqual({ name: "github", level: "global" });
    });
  });

  it("enable → disable cycle POSTs to /disabled-mcp with {name, level}", async () => {
    const { mock, calls } = makeRouter({
      "/mcp/global": [{ name: "github", level: "global", config: { command: "npx" } }],
      "/mcp/workspaces/7/servers": [],
      "/mcp/workspaces/7/disabled-mcp": { disabledMcpServers: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable at workspace");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/mcp/workspaces/7/disabled-mcp");
      expect(postCall!.body).toEqual({ name: "github", level: "global" });
    });
  });
});

describe("McpPanel — project scope", () => {
  it("click Disable on workspace-level server sends POST /mcp/projects/:pid/disabled-mcp level=workspace", async () => {
    const { mock, calls } = makeRouter({
      "/mcp/global": [],
      "/mcp/workspaces/7/servers": [{ name: "ws-srv", level: "workspace", config: { command: "node" } }],
      "/mcp/workspaces/7/projects/42/servers": [],
      "/mcp/projects/42/disabled-mcp": { disabledMcpServers: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "project", workspaceId: "7", projectId: "42" });
    await waitFor(() => expect(screen.getByText("ws-srv")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable at project");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/mcp/projects/42/disabled-mcp");
      expect(postCall!.body).toEqual({ name: "ws-srv", level: "workspace" });
    });
  });
});
