import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import {
  WorkspacesGrid,
  type WorkspacesGridProps,
} from "@/pages/workspaces-components/WorkspacesGrid";
import type { WorkspaceCardData } from "@/pages/workspaces-components/WorkspaceCard";

/**
 * Layout / wiring contract tests for {@link WorkspacesGrid} (slice 23-03 T03).
 *
 * The grid is the assembly point for the `/workspaces` index page:
 * `<SectionHeader>` + search input + `+ New workspace` button + a
 * `grid-cols-3 gap-3` of `<WorkspaceCard>` tiles + the trailing
 * `<AddWorkspaceCard>`.
 *
 * Search behaviour (debounce, URL, name/path predicate, empty-state
 * CTA) is exercised by `workspaces-search.test.tsx`. This file focuses
 * on the static layout contract:
 *   - the prototype `grid grid-cols-3 gap-3` classes are present;
 *   - one card renders per workspace;
 *   - the dashed `AddWorkspaceCard` is the trailing tile;
 *   - the new-workspace button + the dashed card both fire
 *     `onNewWorkspace`;
 *   - the SectionHeader receives the title + subtitle.
 */

function makeWorkspace(
  overrides: Partial<WorkspaceCardData> = {},
): WorkspaceCardData {
  return {
    id: "ws-flockctl",
    name: "flockctl",
    path: "/Users/me/code/flockctl",
    description: null,
    active: true,
    projectCount: 4,
    projectNames: ["flockctl", "ui", "docs"],
    activeTaskCount: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

const SAMPLE_WORKSPACES: WorkspaceCardData[] = [
  makeWorkspace({
    id: "ws-1",
    name: "flockctl",
    path: "/Users/me/code/flockctl",
  }),
  makeWorkspace({
    id: "ws-2",
    name: "personal",
    path: "/Users/me/personal",
  }),
  makeWorkspace({
    id: "ws-3",
    name: "experiments",
    path: "/Users/me/experiments",
  }),
];

function renderGrid(
  props: Partial<WorkspacesGridProps> = {},
  initialEntries: string[] = ["/workspaces"],
) {
  const onNewWorkspace = props.onNewWorkspace ?? vi.fn();
  const finalProps: WorkspacesGridProps = {
    workspaces: SAMPLE_WORKSPACES,
    // Pin debounce to 0 so URL commits land synchronously when tests
    // happen to type into the search input. The static layout tests
    // below don't need it, but the harness shares this default with
    // search.test.tsx for parity.
    searchDebounceMs: 0,
    ...props,
    onNewWorkspace,
  };
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <WorkspacesGrid {...finalProps} />
    </MemoryRouter>,
  );
  return { onNewWorkspace };
}

describe("WorkspacesGrid — header & toolbar", () => {
  it("renders a SectionHeader with the title and subtitle", () => {
    renderGrid({
      title: "Workspaces",
      subtitle: "Three workspaces · 12 projects total",
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Workspaces",
    );
    expect(
      screen.getByText("Three workspaces · 12 projects total"),
    ).toBeTruthy();
  });

  it("renders a searchbox + primary New workspace button (Plus icon + label) in the action slot", () => {
    renderGrid();
    const input = screen.getByRole("searchbox", { name: /search workspaces/i });
    expect(input).toBeTruthy();
    expect(input).toHaveAttribute("placeholder", "Search workspaces…");

    const button = screen.getByTestId("workspaces-new-workspace-button");
    // Unified label: lucide-react <Plus /> icon + "New workspace" text.
    // The literal "+ " prefix used by an earlier prototype has been
    // retired so every "New X" affordance reads identically.
    expect(button.textContent).toBe("New workspace");
    expect(button.querySelector("svg")).toBeTruthy();
    // Unified Button component: default variant maps to bg-primary
    // (CSS-variable-driven indigo), size="sm" for compact toolbar
    // density. Assert on the canonical data-attributes the Button
    // component emits — this stays stable when the underlying utility
    // class recipe is tuned.
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("default");
    expect(button.getAttribute("data-size")).toBe("sm");
  });

  it("falls back to the default title when none is provided", () => {
    renderGrid({ title: undefined });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Workspaces",
    );
  });
});

describe("WorkspacesGrid — grid layout", () => {
  it("renders a grid-cols-3 gap-3 container", () => {
    renderGrid();
    const list = screen.getByTestId("workspaces-grid-list");
    expect(list.className).toContain("grid");
    expect(list.className).toContain("grid-cols-3");
    expect(list.className).toContain("gap-3");
  });

  it("renders one WorkspaceCard per workspace, in input order", () => {
    renderGrid();
    const cards = screen.getAllByTestId("workspace-card");
    expect(cards).toHaveLength(SAMPLE_WORKSPACES.length);
    expect(
      cards.map((c) => c.getAttribute("data-workspace-id")),
    ).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("renders the dashed-border AddWorkspaceCard as the trailing tile", () => {
    renderGrid();
    const list = screen.getByTestId("workspaces-grid-list");
    const add = screen.getByTestId("add-workspace-card");
    expect(add).toBeTruthy();
    // Must be the last child of the grid container so the placeholder
    // sits at the end of the visible row, matching the prototype.
    expect(list.lastElementChild).toBe(add);
  });

  it("still renders the AddWorkspaceCard even when workspaces is empty", () => {
    renderGrid({ workspaces: [] });
    expect(screen.queryAllByTestId("workspace-card")).toHaveLength(0);
    expect(screen.getByTestId("add-workspace-card")).toBeTruthy();
  });
});

describe("WorkspacesGrid — onNewWorkspace wiring", () => {
  it("fires onNewWorkspace when the header button is clicked", () => {
    const onNewWorkspace = vi.fn();
    renderGrid({ onNewWorkspace });
    fireEvent.click(screen.getByTestId("workspaces-new-workspace-button"));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("fires onNewWorkspace when the dashed-border AddWorkspaceCard is clicked", () => {
    const onNewWorkspace = vi.fn();
    renderGrid({ onNewWorkspace });
    fireEvent.click(screen.getByTestId("add-workspace-card"));
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("forwards the AddWorkspaceCard click via the keyboard too (Enter on focused button)", async () => {
    const user = userEvent.setup();
    const onNewWorkspace = vi.fn();
    renderGrid({ onNewWorkspace });
    const add = screen.getByTestId("add-workspace-card");
    add.focus();
    await user.keyboard("{Enter}");
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspacesGrid — onWorkspaceClick override", () => {
  it("invokes onWorkspaceClick(id) when a card is clicked instead of navigating", () => {
    const onWorkspaceClick = vi.fn();
    renderGrid({ onWorkspaceClick });
    const cards = screen.getAllByTestId("workspace-card");
    fireEvent.click(cards[1]!);
    expect(onWorkspaceClick).toHaveBeenCalledTimes(1);
    expect(onWorkspaceClick).toHaveBeenCalledWith("ws-2");
  });
});
