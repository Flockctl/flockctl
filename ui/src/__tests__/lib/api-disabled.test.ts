import { describe, it, expect, vi } from "vitest";
import {
  fetchWorkspaceDisabledSkills,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  fetchProjectDisabledSkills,
  disableProjectSkill,
  enableProjectSkill,
  fetchWorkspaceDisabledMcpServers,
  disableWorkspaceMcpServer,
  enableWorkspaceMcpServer,
  fetchProjectDisabledMcpServers,
  disableProjectMcpServer,
  enableProjectMcpServer,
} from "@/lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

describe("api — workspace skill disables", () => {
  it("GET /skills/workspaces/:id/disabled parses {name, level} entries", async () => {
    const fetchMock = mockFetch({
      disabledSkills: [
        { name: "planning", level: "global" },
        { name: "debug", level: "workspace" },
      ],
    });
    const result = await fetchWorkspaceDisabledSkills("7");
    expect(fetchMock).toHaveBeenCalledWith(
      "/skills/workspaces/7/disabled",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(result.disabled_skills).toEqual([
      { name: "planning", level: "global" },
      { name: "debug", level: "workspace" },
    ]);
  });

  it("POST /skills/workspaces/:id/disabled sends {name, level} body", async () => {
    const fetchMock = mockFetch({ disabledSkills: [{ name: "planning", level: "global" }] });
    await disableWorkspaceSkill("7", { name: "planning", level: "global" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/skills/workspaces/7/disabled");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "planning", level: "global" });
  });

  it("DELETE /skills/workspaces/:id/disabled uses body — not path param", async () => {
    const fetchMock = mockFetch({ disabledSkills: [] });
    await enableWorkspaceSkill("7", { name: "planning", level: "global" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/skills/workspaces/7/disabled");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "planning", level: "global" });
  });
});

describe("api — project skill disables", () => {
  it("GET /skills/projects/:pid/disabled parses {name, level} entries", async () => {
    const fetchMock = mockFetch({
      disabledSkills: [{ name: "planning", level: "project" }],
    });
    const result = await fetchProjectDisabledSkills("42");
    expect(fetchMock).toHaveBeenCalledWith(
      "/skills/projects/42/disabled",
      expect.any(Object),
    );
    expect(result.disabled_skills).toEqual([{ name: "planning", level: "project" }]);
  });

  it("POST sends {name, level} body and handles workspace-level disable from project scope", async () => {
    const fetchMock = mockFetch({ disabledSkills: [{ name: "debug", level: "workspace" }] });
    await disableProjectSkill("42", { name: "debug", level: "workspace" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/skills/projects/42/disabled");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "debug", level: "workspace" });
  });

  it("DELETE uses body with both name and level so unique (name, level) pair is removed", async () => {
    const fetchMock = mockFetch({ disabledSkills: [] });
    await enableProjectSkill("42", { name: "debug", level: "project" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/skills/projects/42/disabled");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "debug", level: "project" });
  });
});

describe("api — MCP disables use /disabled-mcp path", () => {
  it("GET /mcp/workspaces/:id/disabled-mcp (not /disabled)", async () => {
    const fetchMock = mockFetch({
      disabledMcpServers: [{ name: "github", level: "global" }],
    });
    const result = await fetchWorkspaceDisabledMcpServers("7");
    expect(fetchMock).toHaveBeenCalledWith(
      "/mcp/workspaces/7/disabled-mcp",
      expect.any(Object),
    );
    expect(result.disabled_mcp_servers).toEqual([{ name: "github", level: "global" }]);
  });

  it("POST /mcp/workspaces/:id/disabled-mcp sends {name, level}", async () => {
    const fetchMock = mockFetch({ disabledMcpServers: [{ name: "github", level: "global" }] });
    await disableWorkspaceMcpServer("7", { name: "github", level: "global" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/mcp/workspaces/7/disabled-mcp");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "github", level: "global" });
  });

  it("DELETE /mcp/workspaces/:id/disabled-mcp uses body", async () => {
    const fetchMock = mockFetch({ disabledMcpServers: [] });
    await enableWorkspaceMcpServer("7", { name: "github", level: "global" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/mcp/workspaces/7/disabled-mcp");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "github", level: "global" });
  });

  it("GET /mcp/projects/:pid/disabled-mcp", async () => {
    const fetchMock = mockFetch({
      disabledMcpServers: [{ name: "srv", level: "workspace" }],
    });
    const result = await fetchProjectDisabledMcpServers("42");
    expect(fetchMock).toHaveBeenCalledWith("/mcp/projects/42/disabled-mcp", expect.any(Object));
    expect(result.disabled_mcp_servers).toEqual([{ name: "srv", level: "workspace" }]);
  });

  it("POST /mcp/projects/:pid/disabled-mcp with body", async () => {
    const fetchMock = mockFetch({ disabledMcpServers: [{ name: "srv", level: "project" }] });
    await disableProjectMcpServer("42", { name: "srv", level: "project" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/mcp/projects/42/disabled-mcp");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "srv", level: "project" });
  });

  it("DELETE /mcp/projects/:pid/disabled-mcp with body", async () => {
    const fetchMock = mockFetch({ disabledMcpServers: [] });
    await enableProjectMcpServer("42", { name: "srv", level: "project" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/mcp/projects/42/disabled-mcp");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ name: "srv", level: "project" });
  });
});

describe("api — error handling", () => {
  it("throws with server error message on 4xx", async () => {
    mockFetch({ error: "name is required" }, 422);
    await expect(
      disableWorkspaceSkill("7", { name: "", level: "global" } as any),
    ).rejects.toThrow("name is required");
  });

  it("throws generic API error when body has no detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );
    (globalThis as any).fetch = fetchMock;
    await expect(
      fetchWorkspaceDisabledSkills("7"),
    ).rejects.toThrow(/Internal Server Error|API error 500/);
  });
});
