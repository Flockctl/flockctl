/**
 * Tests for WorkspaceRunsTab — the workspace-detail "Runs" tab body.
 *
 * The tab is a structural empty state: runs live on projects, so the
 * tab's job is to route users into per-project Runs tabs rather than
 * show workspace-wide analytics. The tests here pin down:
 *
 *   1. the empty-state copy is rendered verbatim,
 *   2. one outline Button per workspace project is rendered, each
 *      linking to `/projects/:id?tab=runs`,
 *   3. when `projects` is empty, the button row is replaced with a
 *      call-to-action linking back to this workspace's Plan tab
 *      (which hosts AddProjectDialog).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { WorkspaceRunsTab } from "../WorkspaceRunsTab";
import type { Project } from "@/lib/types";

function makeProject(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  const base: Project = {
    id: overrides.id,
    name: overrides.name,
    description: null,
    path: null,
    workspace_id: null,
    repo_url: null,
    provider_fallback_chain: null,
    allowed_key_ids: null,
    gitignore_flockctl: false,
    gitignore_todo: false,
    gitignore_agents_md: false,
    use_project_claude_skills: false,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

describe("WorkspaceRunsTab", () => {
  it("renders the empty-state copy and one outline button per project", () => {
    const projects = [
      makeProject({ id: "p-1", name: "Alpha" }),
      makeProject({ id: "p-2", name: "Beta" }),
    ];

    render(
      <MemoryRouter>
        <WorkspaceRunsTab workspaceId="ws-1" projects={projects} />
      </MemoryRouter>,
    );

    // Copy is rendered verbatim.
    expect(
      screen.getByText(
        /Runs are scoped per project\. Open a project's Runs tab to see its execution history\./,
      ),
    ).toBeInTheDocument();

    // One button per project, each linking to /projects/:id?tab=runs.
    const container = screen.getByTestId("workspace-runs-project-links");
    const alpha = within(container).getByRole("link", { name: /Alpha/ });
    const beta = within(container).getByRole("link", { name: /Beta/ });
    expect(alpha).toHaveAttribute("href", "/projects/p-1?tab=runs");
    expect(beta).toHaveAttribute("href", "/projects/p-2?tab=runs");

    // The CTA fallback must NOT be rendered when there are projects.
    expect(
      screen.queryByTestId("workspace-runs-empty-cta"),
    ).not.toBeInTheDocument();
  });

  it("renders a create-project call-to-action when the workspace has no projects", () => {
    render(
      <MemoryRouter>
        <WorkspaceRunsTab workspaceId="ws-42" projects={[]} />
      </MemoryRouter>,
    );

    // Empty-state copy still present.
    expect(
      screen.getByText(
        /Runs are scoped per project\. Open a project's Runs tab to see its execution history\./,
      ),
    ).toBeInTheDocument();

    // No per-project link row.
    expect(
      screen.queryByTestId("workspace-runs-project-links"),
    ).not.toBeInTheDocument();

    // CTA instead, linking back to this workspace's Plan tab where
    // AddProjectDialog lives.
    const cta = screen.getByTestId("workspace-runs-empty-cta");
    const link = within(cta).getByRole("link", { name: /Add a project/i });
    expect(link).toHaveAttribute("href", "/workspaces/ws-42?tab=plan");
  });

  it("renders inside a Card shell so the body sits at the Projects-UI vertical position", () => {
    render(
      <MemoryRouter>
        <WorkspaceRunsTab
          workspaceId="ws-1"
          projects={[makeProject({ id: "p-1", name: "Alpha" })]}
        />
      </MemoryRouter>,
    );

    const tab = screen.getByTestId("workspace-runs-tab");
    // The Card shell adds a [data-slot="card"] element from the shadcn Card
    // primitive (see components/ui/card.tsx). Asserting its presence keeps
    // the vertical rhythm aligned with `project-detail-components/RunsTab.tsx`.
    expect(tab.querySelector('[data-slot="card"]')).not.toBeNull();
  });
});
