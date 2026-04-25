import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useEffect, type ReactNode } from "react";
import { ViewModeToggle } from "@/pages/project-detail-components/ViewModeToggle";

// --- localStorage mock --------------------------------------------------------
// The hook persists the last choice to localStorage. Other test files in this
// suite clobber `globalThis.localStorage` without restoring, so install our
// own deterministic mock per test regardless of file order.
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

// --- Router probe -------------------------------------------------------------
// Mounted alongside the component so the test can read the live pathname +
// search string after each click without pulling in `renderHook`.
type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

function renderWithRouter(initial: string, ui: ReactNode) {
  const probe: { current: Probe } = {
    current: { pathname: "", search: "" },
  };
  render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <LocationProbe onLocation={(p) => (probe.current = p)} />
    </MemoryRouter>,
  );
  return probe;
}

describe("ViewModeToggle", () => {
  beforeEach(() => {
    installStorage();
  });

  it("renders three buttons: Board, Tree, Swimlane", () => {
    renderWithRouter("/projects/p1", <ViewModeToggle projectId="p1" />);
    expect(screen.getByRole("button", { name: /board/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tree/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /swimlane/i })).toBeInTheDocument();
  });

  it("shows a 'Coming soon' badge on the Swimlane option", () => {
    renderWithRouter("/projects/p1", <ViewModeToggle projectId="p1" />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it("marks the mode resolved from the URL as pressed", () => {
    renderWithRouter(
      "/projects/p1?view=board",
      <ViewModeToggle projectId="p1" />,
    );
    const board = screen.getByRole("button", { name: /board/i });
    const tree = screen.getByRole("button", { name: /tree/i });
    expect(board).toHaveAttribute("aria-pressed", "true");
    expect(tree).toHaveAttribute("aria-pressed", "false");
  });

  it("defaults to 'tree' pressed when no URL param and no stored value", () => {
    renderWithRouter("/projects/p1", <ViewModeToggle projectId="p1" />);
    expect(
      screen.getByRole("button", { name: /tree/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("view_mode_toggle_updates_url_without_reload", async () => {
    // Baseline contract for the whole slice: clicking a segment must update
    // the `?view=` query param IN PLACE. No pathname change, no full reload,
    // no router replacement of the entry. React Router's `setSearchParams`
    // (inside useViewMode) guarantees this — we assert it end-to-end through
    // the rendered component so a future refactor can't regress it silently.
    const user = userEvent.setup();
    const probe = renderWithRouter(
      "/projects/p1?milestone=42",
      <ViewModeToggle projectId="p1" />,
    );
    const pathnameBefore = probe.current.pathname;
    expect(pathnameBefore).toBe("/projects/p1");

    // Click Swimlane — the "coming soon" corner case. URL must flip to
    // ?view=swimlane while keeping the unrelated `milestone=42` param.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /swimlane/i }));
    });

    expect(probe.current.pathname).toBe(pathnameBefore);
    expect(probe.current.search).toContain("view=swimlane");
    expect(probe.current.search).toContain("milestone=42");

    // Pressed state moved to the new option; Tree no longer pressed.
    expect(
      screen.getByRole("button", { name: /swimlane/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /tree/i }),
    ).toHaveAttribute("aria-pressed", "false");

    // Per-project storage key got written, so the next visit rehydrates.
    expect(store["flockctl.viewMode.p1"]).toBe("swimlane");

    // Switching again stays in-place.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /board/i }));
    });
    expect(probe.current.pathname).toBe(pathnameBefore);
    expect(probe.current.search).toContain("view=board");
    expect(probe.current.search).toContain("milestone=42");
  });
});
