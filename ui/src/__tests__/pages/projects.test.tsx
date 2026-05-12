import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ProjectsPage from "@/pages/projects";

/**
 * Page-level assembly tests for `/projects` (slice 23-02 T07).
 *
 * Lower-level pieces (cards, table, chips, search debounce, group helper,
 * dialog) have their own dedicated test files. This spec verifies that
 * the page wires the existing primitives together correctly:
 *
 *   - Renders the page-size SectionHeader with the `N total · N in
 *     workspaces · N standalone` subtitle once data loads.
 *   - Renders the ProjectsToolbar in the header action slot (so the
 *     search input + Cards/Table toggle + + New project button are
 *     visible).
 *   - Renders the FilterChips below the header when projects exist.
 *   - Cards view: groups projects by workspace section + standalone
 *     section, drops empty groups.
 *   - Table view: switching the toggle renders the table primitive
 *     with the filtered rows.
 *   - Empty initial state: shows the EmptyState with a CTA when there
 *     are no projects at all.
 *   - Filtered empty state: shows a separate EmptyState when there are
 *     projects but none match the active filter.
 *   - URL filter (`?filter=<workspace-slug>`) narrows the rendered
 *     cards to the matching workspace.
 *
 * The page reads from React Query, so each test mounts its own client
 * with retries disabled. The fetch stub returns the seeded payloads.
 *
 * jsdom doesn't ship `ResizeObserver`; the new-project dialog sits
 * mounted in the page and pulls in Radix Dialog's layout effects, which
 * touch `ResizeObserver`. A no-op stub is enough — same shape as the
 * dialog's own test file.
 */

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

interface SeededProject {
  id: string;
  name: string;
  description: string | null;
  path: string | null;
  workspace_id: number | null;
  repo_url: string | null;
  provider_fallback_chain: string[] | null;
  allowed_key_ids: number[] | null;
  gitignore_flockctl: boolean;
  gitignore_todo: boolean;
  gitignore_agents_md: boolean;
  use_project_claude_skills: boolean;
  created_at: string;
  updated_at: string;
}

interface SeededWorkspace {
  id: string;
  name: string;
  description: string | null;
  path: string;
  allowed_key_ids: number[] | null;
  gitignore_flockctl: boolean;
  gitignore_todo: boolean;
  gitignore_agents_md: boolean;
  created_at: string;
  updated_at: string;
}

function makeProject(overrides: Partial<SeededProject> = {}): SeededProject {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: "p1",
    name: "Project One",
    description: null,
    path: "/tmp/p1",
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<SeededWorkspace> = {}): SeededWorkspace {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: "1",
    name: "work",
    description: null,
    path: "/tmp/ws-work",
    allowed_key_ids: null,
    gitignore_flockctl: true,
    gitignore_todo: true,
    gitignore_agents_md: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchSeed {
  projects?: SeededProject[];
  workspaces?: SeededWorkspace[];
  attention?: { items: Array<{ project_id: string | null }> };
}

function installFetchStub(seed: FetchSeed = {}) {
  const projects = seed.projects ?? [];
  const workspaces = seed.workspaces ?? [];
  const attention = seed.attention ?? { items: [] };

  (globalThis as any).fetch = vi.fn(async (rawUrl: string) => {
    const url = String(rawUrl);
    // The list hooks call `/projects` and `/workspaces` (no query string
    // in the standard fetch path). Match exact + query-bearing variants.
    if (url.endsWith("/projects") || url.includes("/projects?")) {
      return jsonResponse({ items: projects, total: projects.length });
    }
    if (url.endsWith("/workspaces") || url.includes("/workspaces?")) {
      return jsonResponse({ items: workspaces, total: workspaces.length });
    }
    if (url.endsWith("/attention") || url.includes("/attention?")) {
      return jsonResponse(attention);
    }
    if (url.endsWith("/keys") || url.includes("/keys?")) {
      return jsonResponse({ items: [], total: 0 });
    }
    // The dialog's scan endpoint isn't reached without a click — but
    // fall through with an empty response just in case so a future
    // imports-preview render doesn't blow up the page boot.
    if (url.includes("/projects/scan")) {
      return jsonResponse({});
    }
    return jsonResponse({});
  });
}

function renderPage(initialEntry = "/projects") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ProjectsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Reset localStorage so view-toggle / last-picked-path don't leak.
  globalThis.localStorage?.clear?.();
  installFetchStub();
});

describe("ProjectsPage / header + assembly", () => {
  it("renders the page SectionHeader with subtitle counts once data loads", async () => {
    installFetchStub({
      projects: [
        makeProject({ id: "p1", name: "A", workspace_id: 1 }),
        makeProject({ id: "p2", name: "B", workspace_id: 1 }),
        makeProject({ id: "p3", name: "C", workspace_id: null }),
      ],
      workspaces: [makeWorkspace({ id: "1", name: "work" })],
    });
    renderPage();

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Projects",
    });
    expect(heading).toBeInTheDocument();
    // Subtitle counts: 3 total · 2 in workspaces · 1 standalone.
    await screen.findByText(/3 total\s*·\s*2 in workspaces\s*·\s*1 standalone/);
  });

  it("renders the ProjectsToolbar in the header action slot", async () => {
    installFetchStub({
      projects: [makeProject({ id: "p1", workspace_id: null })],
      workspaces: [],
    });
    renderPage();

    expect(await screen.findByTestId("projects-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("projects-search-input")).toBeInTheDocument();
    expect(screen.getByTestId("projects-view-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("projects-new-project-button")).toBeInTheDocument();
  });

  it("renders the FilterChips below the header when projects exist", async () => {
    installFetchStub({
      projects: [makeProject({ id: "p1", workspace_id: null })],
      workspaces: [makeWorkspace({ id: "1", name: "work" })],
    });
    renderPage();

    expect(
      await screen.findByTestId("projects-filter-chips"),
    ).toBeInTheDocument();
    // All / per-workspace / Standalone chips.
    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("All 1");
    expect(screen.getByTestId("filter-chip-work")).toHaveTextContent("work 0");
    expect(
      screen.getByTestId("filter-chip-standalone"),
    ).toHaveTextContent("Standalone 1");
  });
});

describe("ProjectsPage / cards layout", () => {
  it("renders per-workspace sections + standalone group with their cards", async () => {
    installFetchStub({
      projects: [
        makeProject({ id: "p1", name: "Alpha", workspace_id: 1 }),
        makeProject({ id: "p2", name: "Beta", workspace_id: 2 }),
        makeProject({ id: "p3", name: "Gamma", workspace_id: null }),
      ],
      workspaces: [
        makeWorkspace({ id: "1", name: "work" }),
        makeWorkspace({ id: "2", name: "personal" }),
      ],
    });
    renderPage();

    expect(await screen.findByTestId("projects-cards-layout")).toBeInTheDocument();
    expect(screen.getByTestId("projects-section-ws-1")).toBeInTheDocument();
    expect(screen.getByTestId("projects-section-ws-2")).toBeInTheDocument();
    expect(screen.getByTestId("projects-section-standalone")).toBeInTheDocument();

    // Each section owns exactly one card.
    expect(
      within(screen.getByTestId("projects-section-ws-1")).getByText("Alpha"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("projects-section-ws-2")).getByText("Beta"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("projects-section-standalone")).getByText(
        "Gamma",
      ),
    ).toBeInTheDocument();
  });

  it("drops empty workspace sections (no header for a workspace with zero projects after filtering)", async () => {
    installFetchStub({
      projects: [makeProject({ id: "p1", name: "Alpha", workspace_id: 1 })],
      workspaces: [
        makeWorkspace({ id: "1", name: "work" }),
        makeWorkspace({ id: "2", name: "empty-ws" }),
      ],
    });
    renderPage();

    await screen.findByTestId("projects-section-ws-1");
    expect(screen.queryByTestId("projects-section-ws-2")).toBeNull();
  });
});

describe("ProjectsPage / view toggle", () => {
  it("switching to Table renders the projects-table primitive", async () => {
    const user = userEvent.setup();
    installFetchStub({
      projects: [makeProject({ id: "p1", name: "Alpha", workspace_id: 1 })],
      workspaces: [makeWorkspace({ id: "1", name: "work" })],
    });
    renderPage();

    // Cards on first paint (default view).
    await screen.findByTestId("projects-cards-layout");

    // Click Table.
    const toggle = screen.getByTestId("projects-view-toggle");
    const tableButton = within(toggle).getByRole("radio", { name: "Table" });
    await user.click(tableButton);

    // Cards layout gone; table visible.
    expect(screen.queryByTestId("projects-cards-layout")).toBeNull();
    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
  });
});

describe("ProjectsPage / empty states", () => {
  it("initial empty state surfaces an EmptyState with a CTA when no projects exist", async () => {
    installFetchStub({ projects: [], workspaces: [] });
    renderPage();

    const empty = await screen.findByTestId("projects-empty-state");
    expect(empty).toBeInTheDocument();
    expect(within(empty).getByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByTestId("projects-empty-cta")).toBeInTheDocument();
  });

  it("filtered empty state appears when projects exist but none match the active filter", async () => {
    installFetchStub({
      projects: [makeProject({ id: "p1", name: "Alpha", workspace_id: 1 })],
      workspaces: [makeWorkspace({ id: "1", name: "work" })],
    });
    // standalone filter when there are no standalone projects.
    renderPage("/projects?filter=standalone");

    const empty = await screen.findByTestId("projects-filtered-empty-state");
    expect(empty).toBeInTheDocument();
    expect(
      within(empty).getByText("No projects match your filters"),
    ).toBeInTheDocument();
    // Initial empty-state must NOT also be on screen — they're mutually
    // exclusive by contract.
    expect(screen.queryByTestId("projects-empty-state")).toBeNull();
  });
});

describe("ProjectsPage / URL filter", () => {
  it("?filter=<workspace-slug> narrows the cards layout to that workspace", async () => {
    installFetchStub({
      projects: [
        makeProject({ id: "p1", name: "InWork", workspace_id: 1 }),
        makeProject({ id: "p2", name: "InPersonal", workspace_id: 2 }),
        makeProject({ id: "p3", name: "Standalone", workspace_id: null }),
      ],
      workspaces: [
        makeWorkspace({ id: "1", name: "work" }),
        makeWorkspace({ id: "2", name: "personal" }),
      ],
    });
    renderPage("/projects?filter=work");

    await screen.findByTestId("projects-section-ws-1");
    // Other sections drop out under the filter.
    expect(screen.queryByTestId("projects-section-ws-2")).toBeNull();
    expect(screen.queryByTestId("projects-section-standalone")).toBeNull();
    // The matching project is the only card.
    expect(screen.getByText("InWork")).toBeInTheDocument();
    expect(screen.queryByText("InPersonal")).toBeNull();
    expect(screen.queryByText("Standalone")).toBeNull();
  });
});
