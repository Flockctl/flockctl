import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

import { ProjectsToolbar } from "@/pages/projects-components/ProjectsToolbar";

/**
 * Contract tests for the Cards/Table view toggle and `+ New project`
 * button portions of {@link ProjectsToolbar} (slice 23-02 T04).
 *
 * The view choice is a personal preference — it lives in
 * `localStorage['projects.view']`, NOT in the URL — so the
 * round-trip we care about is "click → localStorage updated → next
 * mount restores the choice". That's the negative test the task spec
 * pins:
 *
 *   view-toggle.test.tsx::reload preserves selected view via localStorage.
 */

// --- localStorage mock -------------------------------------------------------
let store: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    store = {};
  },
  key: () => null,
  length: 0,
};

function installStorage() {
  store = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
}

function renderWithRouter(ui: ReactNode) {
  return render(<MemoryRouter initialEntries={["/projects"]}>{ui}</MemoryRouter>);
}

describe("ProjectsToolbar — view toggle", () => {
  beforeEach(() => {
    installStorage();
  });

  it("renders Cards and Table options inside a radiogroup", () => {
    renderWithRouter(<ProjectsToolbar />);
    const group = screen.getByRole("radiogroup", { name: /projects view/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cards" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Table" })).toBeInTheDocument();
  });

  it("defaults to Cards when no localStorage value is present", () => {
    renderWithRouter(<ProjectsToolbar />);
    expect(
      screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Table" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("falls back to default when localStorage holds an invalid value", () => {
    // Corrupted storage shouldn't crash the page — we silently default.
    store["projects.view"] = "<script>alert(1)</script>";
    renderWithRouter(<ProjectsToolbar />);
    expect(
      screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("clicking Table updates aria state, fires onViewChange, and writes localStorage", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderWithRouter(<ProjectsToolbar onViewChange={onViewChange} />);

    await user.click(screen.getByRole("radio", { name: "Table" }));

    expect(
      screen.getByRole("radio", { name: "Table" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith("table");
    expect(store["projects.view"]).toBe("table");
  });

  it("clicking Cards from a Table baseline writes 'cards' through to localStorage", async () => {
    store["projects.view"] = "table";
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderWithRouter(<ProjectsToolbar onViewChange={onViewChange} />);
    expect(
      screen.getByRole("radio", { name: "Table" }).getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("radio", { name: "Cards" }));
    expect(
      screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(store["projects.view"]).toBe("cards");
    expect(onViewChange).toHaveBeenCalledWith("cards");
  });

  // Negative test (per task spec): reload preserves selected view via localStorage.
  it("reload preserves selected view via localStorage", async () => {
    const user = userEvent.setup();

    // First "session" — user picks Table.
    const first = renderWithRouter(<ProjectsToolbar />);
    await user.click(screen.getByRole("radio", { name: "Table" }));
    expect(store["projects.view"]).toBe("table");

    // Simulate a page reload by unmounting and remounting the toolbar.
    first.unmount();
    renderWithRouter(<ProjectsToolbar />);

    // Restored from localStorage on mount — Table is pressed without any
    // user interaction.
    expect(
      screen.getByRole("radio", { name: "Table" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Cards" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("ProjectsToolbar — + New project button", () => {
  beforeEach(() => {
    installStorage();
  });

  it("renders a primary New project button (Plus icon + label) via the unified Button component", () => {
    renderWithRouter(<ProjectsToolbar />);
    const btn = screen.getByRole("button", { name: /new project/i });
    expect(btn).toBeInTheDocument();
    // Unified label: lucide-react <Plus /> icon + "New project" text.
    // The literal "+ " prefix used by an earlier prototype has been
    // retired so every "New X" affordance reads identically.
    expect(btn.textContent).toContain("New project");
    expect(btn.querySelector("svg")).toBeTruthy();
    // Unified Button: default variant (primary indigo via CSS variable),
    // size="sm" for compact toolbar density. Assert on the canonical
    // data-attributes the Button component emits — these are the public
    // API consumers can rely on without coupling tests to utility-class
    // recipe changes.
    expect(btn.getAttribute("data-slot")).toBe("button");
    expect(btn.getAttribute("data-variant")).toBe("default");
    expect(btn.getAttribute("data-size")).toBe("sm");
  });

  it("forwards clicks to onNewProject", async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    renderWithRouter(<ProjectsToolbar onNewProject={onNewProject} />);
    await user.click(screen.getByRole("button", { name: /new project/i }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it("is safe to click without an onNewProject handler attached", async () => {
    const user = userEvent.setup();
    renderWithRouter(<ProjectsToolbar />);
    // Should not throw — handler is optional.
    await user.click(screen.getByRole("button", { name: /new project/i }));
  });
});
