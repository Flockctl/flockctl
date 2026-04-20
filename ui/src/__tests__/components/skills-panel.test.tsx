import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SkillsPanel } from "@/components/skills-panel";

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
      <SkillsPanel {...props} />
    </QueryClientProvider>,
  );
}

/**
 * Build a route-aware fetch mock.
 *
 * Matches on (method, path) — returns JSON response. Unmatched calls throw so
 * tests fail loudly if the UI hits an unexpected endpoint.
 */
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

describe("SkillsPanel — workspace scope", () => {
  it("renders global skills as inherited and marks disabled ones", async () => {
    const { mock } = makeRouter({
      "/skills/global": [
        { name: "planning", level: "global", content: "# plan" },
      ],
      "/skills/workspaces/7/skills": [],
      "/skills/workspaces/7/disabled": {
        disabledSkills: [{ name: "planning", level: "global" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });

    await waitFor(() => {
      expect(screen.getByText("planning")).toBeInTheDocument();
    });
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("click Eye button on disabled skill sends DELETE /disabled with {name, level}", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [{ name: "planning", level: "global", content: "x" }],
      "/skills/workspaces/7/skills": [],
      "/skills/workspaces/7/disabled": {
        disabledSkills: [{ name: "planning", level: "global" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("planning")).toBeInTheDocument());

    // Currently disabled → button title is "Enable at workspace"
    const btn = await screen.findByTitle("Enable at workspace");
    await userEvent.click(btn);

    await waitFor(() => {
      const deleteCall = calls.find((c) => c.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.url).toBe("/skills/workspaces/7/disabled");
      expect(deleteCall!.body).toEqual({ name: "planning", level: "global" });
    });
  });

  it("click EyeOff on enabled skill sends POST /disabled with {name, level}", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [{ name: "planning", level: "global", content: "x" }],
      "/skills/workspaces/7/skills": [],
      "/skills/workspaces/7/disabled": { disabledSkills: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("planning")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable at workspace");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/skills/workspaces/7/disabled");
      expect(postCall!.body).toEqual({ name: "planning", level: "global" });
    });
  });

  it("disable key uses level:name pair — global and workspace with same name don't collide", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [{ name: "shared", level: "global", content: "g" }],
      "/skills/workspaces/7/skills": [{ name: "shared", level: "workspace", content: "w" }],
      "/skills/workspaces/7/disabled": {
        disabledSkills: [{ name: "shared", level: "global" }],
      },
    });
    (globalThis as any).fetch = mock;

    // Project-level panel shows both global and workspace as "inherited".
    // workspaceId is required; projectId needed for project scope but we're testing workspace scope here.
    renderPanel({ level: "workspace", workspaceId: "7" });

    await waitFor(() => expect(screen.getAllByText("shared").length).toBeGreaterThan(0));

    // Only the global entry appears in the inherited set (workspace-scope panel
    // doesn't show workspace-level as inherited). Click its eye to enable.
    const btn = await screen.findByTitle("Enable at workspace");
    await userEvent.click(btn);

    await waitFor(() => {
      const deleteCall = calls.find((c) => c.method === "DELETE");
      expect(deleteCall!.body).toEqual({ name: "shared", level: "global" });
    });
  });
});

describe("SkillsPanel — project scope", () => {
  it("click Eye on workspace-level skill sends POST /skills/projects/:pid/disabled with level=workspace", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [],
      "/skills/workspaces/7/skills": [{ name: "review", level: "workspace", content: "r" }],
      "/skills/workspaces/7/projects/42/skills": [],
      "/skills/projects/42/disabled": { disabledSkills: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "project", workspaceId: "7", projectId: "42" });
    await waitFor(() => expect(screen.getByText("review")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable at project");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/skills/projects/42/disabled");
      expect(postCall!.body).toEqual({ name: "review", level: "workspace" });
    });
  });
});

describe("SkillsPanel — own skill toggle (project scope)", () => {
  it("click EyeOff on own project skill sends POST /skills/projects/:pid/disabled with level=project", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [],
      "/skills/workspaces/7/skills": [],
      "/skills/workspaces/7/projects/42/skills": [
        { name: "api-design", level: "project", content: "# api" },
      ],
      "/skills/projects/42/disabled": { disabledSkills: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "project", workspaceId: "7", projectId: "42" });
    await waitFor(() => expect(screen.getByText("api-design")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable skill");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/skills/projects/42/disabled");
      expect(postCall!.body).toEqual({ name: "api-design", level: "project" });
    });
  });

  it("already-disabled own project skill shows 'disabled' badge and Enable button", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [],
      "/skills/workspaces/7/skills": [],
      "/skills/workspaces/7/projects/42/skills": [
        { name: "api-design", level: "project", content: "# api" },
      ],
      "/skills/projects/42/disabled": {
        disabledSkills: [{ name: "api-design", level: "project" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "project", workspaceId: "7", projectId: "42" });
    await waitFor(() => expect(screen.getByText("api-design")).toBeInTheDocument());

    expect(screen.getByText("disabled")).toBeInTheDocument();

    const btn = await screen.findByTitle("Enable skill");
    await userEvent.click(btn);

    await waitFor(() => {
      const deleteCall = calls.find((c) => c.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.url).toBe("/skills/projects/42/disabled");
      expect(deleteCall!.body).toEqual({ name: "api-design", level: "project" });
    });
  });
});

describe("SkillsPanel — own skill toggle (workspace scope)", () => {
  it("click EyeOff on own workspace skill sends POST /skills/workspaces/:id/disabled with level=workspace", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [],
      "/skills/workspaces/7/skills": [{ name: "testing", level: "workspace", content: "# t" }],
      "/skills/workspaces/7/disabled": { disabledSkills: [] },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("testing")).toBeInTheDocument());

    const btn = await screen.findByTitle("Disable skill");
    await userEvent.click(btn);

    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall!.url).toBe("/skills/workspaces/7/disabled");
      expect(postCall!.body).toEqual({ name: "testing", level: "workspace" });
    });
  });

  it("already-disabled own workspace skill enables via DELETE", async () => {
    const { mock, calls } = makeRouter({
      "/skills/global": [],
      "/skills/workspaces/7/skills": [{ name: "testing", level: "workspace", content: "# t" }],
      "/skills/workspaces/7/disabled": {
        disabledSkills: [{ name: "testing", level: "workspace" }],
      },
    });
    (globalThis as any).fetch = mock;

    renderPanel({ level: "workspace", workspaceId: "7" });
    await waitFor(() => expect(screen.getByText("testing")).toBeInTheDocument());

    expect(screen.getByText("disabled")).toBeInTheDocument();

    const btn = await screen.findByTitle("Enable skill");
    await userEvent.click(btn);

    await waitFor(() => {
      const deleteCall = calls.find((c) => c.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.url).toBe("/skills/workspaces/7/disabled");
      expect(deleteCall!.body).toEqual({ name: "testing", level: "workspace" });
    });
  });
});
