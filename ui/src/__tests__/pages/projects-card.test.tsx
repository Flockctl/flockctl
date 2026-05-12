import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import { ProjectCard } from "@/pages/projects-components/ProjectCard";
import type { Project } from "@/lib/types";

/**
 * Unit tests for {@link ProjectCard} (slice 23-02 T01).
 *
 * The card is presentational, so the tests cover the prop contract
 * surface directly:
 *   - happy path: full card renders icon + name + path + workspace pill
 *     + description + git row + mission progress bar
 *   - click → navigate to /projects/:id (slug = id)
 *   - click → respect a custom onClick override
 *   - kebab opens a dropdown with rename/archive/delete and clicks
 *     don't bubble to the card-level navigation
 *   - edge cases: missing description / git / mission don't render
 *     orphan blocks; missing pinned does not render the star; long
 *     name + path get truncate-wrapped; mission percent clamps to
 *     [0, 100]; ahead/behind defaults to 0 when partially provided.
 */

function makeProject(
  overrides: Partial<Project> = {},
): Pick<Project, "id" | "name" | "path" | "repo_url" | "description"> {
  return {
    id: "p-flockctl",
    name: "Flockctl",
    path: "/Users/me/code/flockctl",
    repo_url: null,
    description: "Local-first control plane for AI coding agents.",
    ...overrides,
  };
}

function renderInRouter(ui: React.ReactNode, initialEntry = "/projects") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/projects" element={ui} />
        <Route
          path="/projects/:id"
          element={<LocationSpy />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname}</div>;
}

describe("ProjectCard / happy path", () => {
  it("renders the icon-tile, name, path, workspace pill, description, branch row and mission bar", () => {
    renderInRouter(
      <ProjectCard
        project={makeProject()}
        workspace={{ name: "work", accentClassName: "bg-indigo-500/15 text-indigo-600" }}
        pinned
        hasActiveTask
        git={{ branch: "main", changeCount: 0, ahead: 2, behind: 1 }}
        mission={{ percent: 42 }}
      />,
    );

    expect(screen.getByTestId("project-card-icon")).toBeTruthy();
    expect(screen.getByText("Flockctl")).toBeTruthy();
    expect(screen.getByTestId("project-card-pinned")).toBeTruthy();
    expect(screen.getByTestId("project-card-path").textContent).toBe(
      "/Users/me/code/flockctl",
    );
    expect(screen.getByTestId("project-card-live")).toBeTruthy();

    const pill = screen.getByTestId("project-card-workspace-pill");
    expect(pill.textContent).toBe("work");
    expect(pill.className).toContain("bg-indigo-500/15");
    expect(pill.className).toContain("text-indigo-600");

    expect(
      screen.getByTestId("project-card-description").textContent,
    ).toContain("Local-first");

    const git = screen.getByTestId("project-card-git");
    expect(within(git).getByText("main")).toBeTruthy();
    expect(screen.getByTestId("project-card-changes").textContent).toBe(
      "clean",
    );
    expect(screen.getByTestId("project-card-changes").className).toContain(
      "emerald",
    );
    expect(
      screen.getByTestId("project-card-ahead-behind").textContent,
    ).toBe("2↑1↓");

    expect(screen.getByTestId("project-card-mission-label").textContent).toBe(
      "Mission · 42%",
    );
    const fill = screen.getByTestId("project-card-mission-fill");
    expect((fill as HTMLElement).style.width).toBe("42%");
    const bar = screen.getByTestId("project-card-mission-bar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("role")).toBe("progressbar");
  });
});

describe("ProjectCard / navigation", () => {
  it("navigates to /projects/:id when the card is clicked", () => {
    renderInRouter(<ProjectCard project={makeProject({ id: "p-42" })} />);
    fireEvent.click(screen.getByTestId("project-card"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/projects/p-42",
    );
  });

  it("respects a custom onClick override (no router navigation)", () => {
    const onClick = vi.fn();
    renderInRouter(
      <ProjectCard project={makeProject({ id: "p-42" })} onClick={onClick} />,
    );
    fireEvent.click(screen.getByTestId("project-card"));
    expect(onClick).toHaveBeenCalledTimes(1);
    // Default route should still be /projects since the override didn't navigate.
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });
});

describe("ProjectCard / kebab menu", () => {
  it("does not render the kebab when no action callbacks are passed", () => {
    renderInRouter(<ProjectCard project={makeProject()} />);
    expect(screen.queryByTestId("project-card-kebab")).toBeNull();
  });

  it("renders the kebab and opens the dropdown without navigating away", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    renderInRouter(
      <ProjectCard
        project={makeProject({ id: "p-42" })}
        onRename={onRename}
        onArchive={onArchive}
        onDelete={onDelete}
      />,
    );

    const kebab = screen.getByTestId("project-card-kebab");
    await user.click(kebab);

    // Card-level navigation should NOT have fired.
    expect(screen.queryByTestId("navigated-to")).toBeNull();

    // Menu items render after the trigger opens.
    expect(await screen.findByText("Rename")).toBeTruthy();
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });
});

describe("ProjectCard / edge cases", () => {
  it("omits the description block when description is null", () => {
    renderInRouter(
      <ProjectCard project={makeProject({ description: null })} />,
    );
    expect(screen.queryByTestId("project-card-description")).toBeNull();
  });

  it("omits the git row when no git info is provided (non-tracked repo)", () => {
    renderInRouter(<ProjectCard project={makeProject()} />);
    expect(screen.queryByTestId("project-card-git")).toBeNull();
  });

  it("omits the mission progress bar when mission is undefined", () => {
    renderInRouter(<ProjectCard project={makeProject()} />);
    expect(screen.queryByTestId("project-card-mission-label")).toBeNull();
    expect(screen.queryByTestId("project-card-mission-bar")).toBeNull();
  });

  it("omits the workspace pill for standalone projects", () => {
    renderInRouter(<ProjectCard project={makeProject()} />);
    expect(screen.queryByTestId("project-card-workspace-pill")).toBeNull();
  });

  it("does not render the pinned star when pinned is false / undefined", () => {
    renderInRouter(<ProjectCard project={makeProject()} pinned={false} />);
    expect(screen.queryByTestId("project-card-pinned")).toBeNull();
  });

  it("does not render the live dot when hasActiveTask is false", () => {
    renderInRouter(<ProjectCard project={makeProject()} />);
    expect(screen.queryByTestId("project-card-live")).toBeNull();
  });

  it("falls back to repo_url when path is null", () => {
    renderInRouter(
      <ProjectCard
        project={makeProject({
          path: null,
          repo_url: "https://github.com/example/repo",
        })}
      />,
    );
    expect(screen.getByTestId("project-card-path").textContent).toBe(
      "https://github.com/example/repo",
    );
  });

  it("paints the change count amber when there are uncommitted changes", () => {
    renderInRouter(
      <ProjectCard
        project={makeProject()}
        git={{ branch: "feat/x", changeCount: 7 }}
      />,
    );
    const changes = screen.getByTestId("project-card-changes");
    expect(changes.textContent).toBe("7 changes");
    expect(changes.className).toContain("amber");
  });

  it("clamps mission percent above 100% and below 0%", () => {
    const { rerender } = renderInRouter(
      <ProjectCard project={makeProject()} mission={{ percent: 150 }} />,
    );
    expect(screen.getByTestId("project-card-mission-label").textContent).toBe(
      "Mission · 100%",
    );
    expect(
      (screen.getByTestId("project-card-mission-fill") as HTMLElement).style
        .width,
    ).toBe("100%");

    rerender(
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route
            path="/projects"
            element={
              <ProjectCard
                project={makeProject()}
                mission={{ percent: -25 }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("project-card-mission-label").textContent).toBe(
      "Mission · 0%",
    );
  });

  it("hides the ahead/behind indicator when neither value is provided", () => {
    renderInRouter(
      <ProjectCard
        project={makeProject()}
        git={{ branch: "main", changeCount: 0 }}
      />,
    );
    expect(screen.queryByTestId("project-card-ahead-behind")).toBeNull();
  });

  it("defaults a partially provided ahead/behind pair to 0", () => {
    renderInRouter(
      <ProjectCard
        project={makeProject()}
        git={{ branch: "main", changeCount: 0, ahead: 5 }}
      />,
    );
    expect(
      screen.getByTestId("project-card-ahead-behind").textContent,
    ).toBe("5↑0↓");
  });

  it("truncates very long names and paths via min-w-0 + truncate", () => {
    const longName = "x".repeat(80);
    const longPath = "/" + "very/long/path/segment".repeat(5);
    renderInRouter(
      <ProjectCard
        project={makeProject({ name: longName, path: longPath })}
      />,
    );
    const path = screen.getByTestId("project-card-path");
    expect(path.className).toContain("truncate");
    // The name span is truncated too.
    expect(screen.getByText(longName).className).toContain("truncate");
  });
});
