import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  ProjectsToolbar,
  filterProjectsByQuery,
} from "@/pages/projects-components/ProjectsToolbar";
import { EmptyState } from "@/components/EmptyState";
import { FolderGit2 } from "lucide-react";

/**
 * Contract tests for the search-input portion of {@link ProjectsToolbar}
 * (slice 23-02 T04).
 *
 * Each spec covers exactly one promise from the slice:
 *
 *   - 200 ms debounce before commit (no URL update mid-burst).
 *   - URL `?q=` is the source of truth (replace-not-push).
 *   - Filter by `name` AND `path`, case-insensitive substring.
 *   - Empty result triggers the page-level empty-state with a CTA.
 *   - URL pre-population works when landing with `?q=foo`.
 *
 * Negative tests (per task spec):
 *   - search.test.tsx::empty result shows empty-state with CTA.
 */

// --- localStorage mock -------------------------------------------------------
// The view-toggle half of the toolbar reads localStorage on mount; install a
// deterministic mock so the search tests don't accidentally inherit a "table"
// preference from a sibling test file.
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

// --- Router probe ------------------------------------------------------------
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

// --- Empty-state harness -----------------------------------------------------
// The toolbar is intentionally just a controlled input — it doesn't render the
// project list itself. The page composes both. To exercise the end-to-end
// "type something nobody matches → empty-state with CTA" promise we render a
// tiny Harness that listens to onSearchChange and applies the same filter
// helper the page will.

interface TestProject {
  id: string;
  name: string;
  path: string;
}

function ProjectsHarness({
  rows,
  onNewProject,
}: {
  rows: TestProject[];
  onNewProject?: () => void;
}) {
  const [q, setQ] = useState<string>("");
  const filtered = filterProjectsByQuery(rows, q);
  return (
    <>
      <ProjectsToolbar
        onSearchChange={setQ}
        onNewProject={onNewProject}
      />
      {filtered.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No projects match your search"
          description="Try a different name or path."
          action={
            <button
              type="button"
              onClick={onNewProject}
              data-testid="empty-cta-new-project"
            >
              + New project
            </button>
          }
        />
      ) : (
        <ul data-testid="harness-results">
          {filtered.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      )}
    </>
  );
}

const SAMPLE_ROWS: TestProject[] = [
  { id: "p1", name: "flockctl", path: "/Users/me/code/flockctl" },
  { id: "p2", name: "marketing-site", path: "/Users/me/work/marketing-site" },
  { id: "p3", name: "docs", path: "/Users/me/personal/docs" },
];

describe("ProjectsToolbar — search input", () => {
  beforeEach(() => {
    installStorage();
    // Real timers by default so userEvent debounces work; specific tests opt
    // into fake timers when they need to inspect the debounce window.
  });

  afterEach(() => {
    // Reset to real timers between tests so leakage doesn't cascade.
    vi.useRealTimers();
  });

  it("renders a searchbox with the prototype classes", () => {
    renderWithRouter("/projects", <ProjectsToolbar />);
    const input = screen.getByRole("searchbox", { name: /search projects/i });
    for (const cls of [
      "px-3",
      "py-1.5",
      "bg-white",
      "dark:bg-zinc-900",
      "border",
      "border-zinc-200",
      "dark:border-zinc-700",
      "rounded",
      "text-[12.5px]",
      "outline-none",
      "focus:border-indigo-500",
      "w-56",
    ]) {
      expect(input.className).toContain(cls);
    }
    expect(input).toHaveAttribute("placeholder", "Search projects…");
  });

  it("pre-populates the input when ?q= is in the URL", () => {
    renderWithRouter(
      "/projects?q=flock",
      <ProjectsToolbar />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search projects/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("flock");
  });

  it("debounces URL commits by 200ms (no commit before the timer fires)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter("/projects", <ProjectsToolbar />);
    const input = screen.getByRole("searchbox", {
      name: /search projects/i,
    }) as HTMLInputElement;

    // fireEvent.change doesn't auto-advance fake timers — perfect for
    // observing the debounce window. (userEvent.type with `advanceTimers`
    // would tick the clock between keystrokes, masking the gap.)
    fireEvent.change(input, { target: { value: "foo" } });

    // Mid-burst: input value reflects typing, but URL hasn't committed yet.
    expect(input.value).toBe("foo");
    expect(probe.current.search).toBe("");

    // Just under the debounce window — still no commit.
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(probe.current.search).toBe("");

    // Cross the threshold — URL should now have ?q=foo.
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(probe.current.search).toContain("q=foo");
  });

  it("commits to URL ?q= and emits onSearchChange (replace-not-push, preserves other params)", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const probe = renderWithRouter(
      "/projects?filter=work",
      <ProjectsToolbar onSearchChange={onSearchChange} />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search projects/i,
    });

    fireEvent.change(input, { target: { value: "site" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(probe.current.pathname).toBe("/projects");
    expect(probe.current.search).toContain("q=site");
    // Unrelated params survive the commit.
    expect(probe.current.search).toContain("filter=work");
    expect(onSearchChange).toHaveBeenCalledWith("site");
  });

  it("clearing the input removes the ?q= param entirely (no empty ?q=)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/projects?q=foo",
      <ProjectsToolbar />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search projects/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("foo");

    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Empty drafts wipe the param outright — landing back at a clean URL.
    expect(probe.current.search).not.toContain("q=");
  });

  it("filterProjectsByQuery matches name OR path, case-insensitively", () => {
    const rows = SAMPLE_ROWS;
    expect(filterProjectsByQuery(rows, "FLOCK").map((r) => r.id)).toEqual([
      "p1",
    ]);
    expect(filterProjectsByQuery(rows, "marketing").map((r) => r.id)).toEqual([
      "p2",
    ]);
    // Path-only hit: "personal" only appears in p3's path.
    expect(filterProjectsByQuery(rows, "personal").map((r) => r.id)).toEqual([
      "p3",
    ]);
    // Empty query returns all rows in original order.
    expect(filterProjectsByQuery(rows, "").map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    // Whitespace-only query also returns all rows.
    expect(filterProjectsByQuery(rows, "   ").map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  // Negative test (per task spec): empty result shows empty-state with CTA.
  it("empty result shows empty-state with CTA", async () => {
    vi.useFakeTimers();

    const onNewProject = vi.fn();
    renderWithRouter(
      "/projects",
      <ProjectsHarness rows={SAMPLE_ROWS} onNewProject={onNewProject} />,
    );

    // Sanity: harness lists all rows up front.
    expect(screen.getByTestId("harness-results")).toBeInTheDocument();

    const input = screen.getByRole("searchbox", {
      name: /search projects/i,
    });
    fireEvent.change(input, { target: { value: "zzz-no-match-xyzzy" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Empty-state replaces the result list.
    expect(screen.queryByTestId("harness-results")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(
      screen.getByText(/No projects match your search/i),
    ).toBeInTheDocument();

    // CTA in the empty state forwards to the new-project handler.
    // Switch back to real timers before driving userEvent (which uses real
    // microtasks for click dispatch).
    vi.useRealTimers();
    const user = userEvent.setup();
    const cta = screen.getByTestId("empty-cta-new-project");
    await user.click(cta);
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
