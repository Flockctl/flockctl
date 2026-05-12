import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import { ProjectsTable } from "@/pages/projects-components/ProjectsTable";
import type { Project } from "@/lib/types";
import type { ProjectsTableRow } from "@/pages/projects-components/ProjectsTable";

/**
 * Unit tests for {@link ProjectsTable} (slice 23-02 T0X — table view
 * restyle under M22 tokens).
 *
 * The table is presentational: callers hand in the pre-sorted /
 * pre-filtered / pre-paged rows + optional kebab callbacks. These tests
 * cover:
 *   - happy-path render of header (uppercase tracking-wider zinc-500
 *     font-semibold) + body rows (divide-y, hover bg-zinc-50 / dark:bg-zinc-800/40)
 *   - column contract: Name (icon-tile + name) / Workspace (StatusPill) /
 *     Branch (mono) / Last activity / Actions (kebab)
 *   - row click → /projects/:id navigation, custom onRowClick override
 *   - kebab opens dropdown without bubbling row navigation; rename /
 *     archive / delete callbacks fire with project id
 *   - edge cases: empty rows array, missing workspace/git, fallback to
 *     repo_url for path, fallback to project.updated_at for activity,
 *     no kebab when no callbacks provided.
 */

function makeProject(
  overrides: Partial<Project> = {},
): Pick<Project, "id" | "name" | "path" | "repo_url" | "updated_at"> {
  return {
    id: "p-flockctl",
    name: "Flockctl",
    path: "/Users/me/code/flockctl",
    repo_url: null,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function makeRow(overrides: Partial<ProjectsTableRow> = {}): ProjectsTableRow {
  return {
    project: makeProject(),
    workspace: { name: "work" },
    git: { branch: "main" },
    lastActivity: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function renderInRouter(ui: React.ReactNode, initialEntry = "/projects") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/projects" element={ui} />
        <Route path="/projects/:id" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname}</div>;
}

describe("ProjectsTable / header", () => {
  it("renders an uppercase tracking-wider zinc-500 font-semibold header row", () => {
    renderInRouter(<ProjectsTable rows={[makeRow()]} />);
    const head = screen.getByTestId("projects-table-head");
    const ths = within(head).getAllByRole("columnheader");
    // Name + Workspace + Branch + Last activity + (unlabelled actions column)
    expect(ths.length).toBe(5);
    // Header style tokens land on every cell.
    for (const th of ths) {
      expect(th.className).toContain("uppercase");
      expect(th.className).toContain("tracking-wider");
      expect(th.className).toContain("text-zinc-500");
      expect(th.className).toContain("font-semibold");
    }
    // Column labels in order.
    expect(within(head).getByText("Name")).toBeTruthy();
    expect(within(head).getByText("Workspace")).toBeTruthy();
    expect(within(head).getByText("Branch")).toBeTruthy();
    expect(within(head).getByText("Last activity")).toBeTruthy();
  });
});

describe("ProjectsTable / body row tokens", () => {
  it("separates body rows with divide-y and applies the M22 hover surface", () => {
    renderInRouter(
      <ProjectsTable
        rows={[makeRow(), makeRow({ project: makeProject({ id: "p-2", name: "cms" }) })]}
      />,
    );
    const body = screen.getByTestId("projects-table-body");
    expect(body.className).toContain("divide-y");
    expect(body.className).toMatch(/divide-zinc-(100|200)/);

    const rows = screen.getAllByTestId("projects-table-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.className).toContain("cursor-pointer");
      expect(row.className).toContain("hover:bg-zinc-50");
      expect(row.className).toContain("dark:hover:bg-zinc-800/40");
    }
  });
});

describe("ProjectsTable / column contract", () => {
  it("renders Name as icon-tile + name", () => {
    renderInRouter(<ProjectsTable rows={[makeRow()]} />);
    expect(screen.getByTestId("projects-table-icon")).toBeTruthy();
    expect(screen.getByTestId("projects-table-name").textContent).toBe(
      "Flockctl",
    );
  });

  it("renders Workspace as a StatusPill with the caller's accent override", () => {
    renderInRouter(
      <ProjectsTable
        rows={[
          makeRow({
            workspace: {
              name: "work",
              accentClassName: "bg-indigo-500/15 text-indigo-600",
            },
          }),
        ]}
      />,
    );
    const pill = screen.getByTestId("projects-table-workspace-pill");
    expect(pill.textContent).toBe("work");
    expect(pill.className).toContain("bg-indigo-500/15");
    expect(pill.className).toContain("text-indigo-600");
    // StatusPill base classes — uppercase tracking-wider rounded.
    expect(pill.className).toContain("uppercase");
    expect(pill.className).toContain("tracking-wider");
  });

  it("falls back to a `—` placeholder for the workspace column when standalone", () => {
    renderInRouter(
      <ProjectsTable rows={[makeRow({ workspace: undefined })]} />,
    );
    expect(screen.queryByTestId("projects-table-workspace-pill")).toBeNull();
    expect(screen.getByTestId("projects-table-workspace-empty").textContent).toBe(
      "—",
    );
  });

  it("renders Branch in a monospace cell", () => {
    renderInRouter(<ProjectsTable rows={[makeRow({ git: { branch: "feat/x" } })]} />);
    const branch = screen.getByTestId("projects-table-branch");
    expect(branch.textContent).toContain("feat/x");
    // The mono token lives on the surrounding <td>; walk up.
    const cell = branch.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("falls back to a `—` placeholder for the branch column when no git info", () => {
    renderInRouter(<ProjectsTable rows={[makeRow({ git: undefined })]} />);
    expect(screen.queryByTestId("projects-table-branch")).toBeNull();
    expect(screen.getByTestId("projects-table-branch-empty").textContent).toBe(
      "—",
    );
  });

  it("renders Last activity from the explicit `lastActivity` field when provided", () => {
    renderInRouter(
      <ProjectsTable
        rows={[
          makeRow({
            lastActivity: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("projects-table-last-activity").textContent,
    ).toBe("3h ago");
  });

  it("falls back to project.updated_at when lastActivity is omitted", () => {
    renderInRouter(
      <ProjectsTable
        rows={[
          makeRow({
            lastActivity: undefined,
            project: makeProject({
              updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            }),
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("projects-table-last-activity").textContent,
    ).toBe("2d ago");
  });
});

describe("ProjectsTable / navigation", () => {
  it("navigates to /projects/:id when a row is clicked", () => {
    renderInRouter(
      <ProjectsTable
        rows={[makeRow({ project: makeProject({ id: "p-42" }) })]}
      />,
    );
    fireEvent.click(screen.getByTestId("projects-table-row"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/projects/p-42",
    );
  });

  it("invokes onRowClick override instead of router navigation", () => {
    const onRowClick = vi.fn();
    renderInRouter(
      <ProjectsTable
        rows={[makeRow({ project: makeProject({ id: "p-42" }) })]}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(screen.getByTestId("projects-table-row"));
    expect(onRowClick).toHaveBeenCalledWith("p-42");
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });
});

describe("ProjectsTable / kebab menu", () => {
  it("does not render the kebab when no action callbacks are passed", () => {
    renderInRouter(<ProjectsTable rows={[makeRow()]} />);
    expect(screen.queryByTestId("projects-table-kebab")).toBeNull();
  });

  it("renders the kebab and routes rename/archive/delete by project id", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    renderInRouter(
      <ProjectsTable
        rows={[makeRow({ project: makeProject({ id: "p-42" }) })]}
        onRename={onRename}
        onArchive={onArchive}
        onDelete={onDelete}
      />,
    );

    const kebab = screen.getByTestId("projects-table-kebab");
    await user.click(kebab);

    // Card-level navigation should NOT have fired.
    expect(screen.queryByTestId("navigated-to")).toBeNull();

    // Menu items render after the trigger opens.
    const renameItem = await screen.findByText("Rename");
    await user.click(renameItem);
    expect(onRename).toHaveBeenCalledWith("p-42");
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("ProjectsTable / edge cases", () => {
  it("renders an empty body when given no rows", () => {
    renderInRouter(<ProjectsTable rows={[]} />);
    const body = screen.getByTestId("projects-table-body");
    expect(within(body).queryAllByTestId("projects-table-row").length).toBe(0);
  });

  it("falls back to repo_url for the mobile path subline when path is null", () => {
    renderInRouter(
      <ProjectsTable
        rows={[
          makeRow({
            project: makeProject({
              path: null,
              repo_url: "https://github.com/example/repo",
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("projects-table-path").textContent).toBe(
      "https://github.com/example/repo",
    );
  });
});
