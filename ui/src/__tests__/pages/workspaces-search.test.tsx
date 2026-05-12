import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  WorkspacesGrid,
  filterWorkspacesByQuery,
} from "@/pages/workspaces-components/WorkspacesGrid";
import type { WorkspaceCardData } from "@/pages/workspaces-components/WorkspaceCard";

/**
 * Search-input contract tests for {@link WorkspacesGrid} (slice 23-03 T03).
 *
 * Each spec covers exactly one promise from the slice:
 *   - 200 ms debounce before commit (no URL update mid-burst).
 *   - URL `?q=` is the source of truth (replace-not-push, preserves
 *     other params).
 *   - Filter by `name` AND `path`, case-insensitive substring.
 *   - URL pre-population works when landing with `?q=foo`.
 *   - Empty result triggers the page-level empty-state with a CTA wired
 *     to `onNewWorkspace`.
 *   - Clearing the input wipes `?q=` outright.
 */

// --- Router probe -----------------------------------------------------------
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

// --- Sample data ------------------------------------------------------------
function ws(overrides: Partial<WorkspaceCardData>): WorkspaceCardData {
  return {
    id: overrides.id ?? "ws-x",
    name: overrides.name ?? "x",
    path: overrides.path ?? "/tmp/x",
    description: null,
    active: false,
    projectCount: 0,
    projectNames: [],
    activeTaskCount: 0,
    lastActivityAt: null,
    ...overrides,
  };
}

const SAMPLE_WORKSPACES: WorkspaceCardData[] = [
  ws({ id: "w1", name: "flockctl", path: "/Users/me/code/flockctl" }),
  ws({ id: "w2", name: "marketing-site", path: "/Users/me/work/marketing-site" }),
  ws({ id: "w3", name: "docs", path: "/Users/me/personal/docs" }),
];

describe("WorkspacesGrid — search input", () => {
  afterEach(() => {
    // Reset to real timers between tests so leakage doesn't cascade.
    vi.useRealTimers();
  });

  it("renders a searchbox with the prototype classes", () => {
    renderWithRouter(
      "/workspaces",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", { name: /search workspaces/i });
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
    expect(input).toHaveAttribute("placeholder", "Search workspaces…");
  });

  it("pre-populates the input when ?q= is in the URL", () => {
    renderWithRouter(
      "/workspaces?q=flock",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search workspaces/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("flock");
  });

  it("debounces URL commits by 200ms (no commit before the timer fires)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/workspaces",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search workspaces/i,
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

  it("commits to URL ?q= (replace-not-push, preserves other params)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/workspaces?filter=work",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search workspaces/i,
    });

    fireEvent.change(input, { target: { value: "site" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(probe.current.pathname).toBe("/workspaces");
    expect(probe.current.search).toContain("q=site");
    // Unrelated params survive the commit.
    expect(probe.current.search).toContain("filter=work");
  });

  it("clearing the input removes the ?q= param entirely (no empty ?q=)", async () => {
    vi.useFakeTimers();

    const probe = renderWithRouter(
      "/workspaces?q=foo",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: /search workspaces/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("foo");

    fireEvent.change(input, { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Empty drafts wipe the param outright — landing back at a clean URL.
    expect(probe.current.search).not.toContain("q=");
  });

  it("filterWorkspacesByQuery matches name OR path, case-insensitively", () => {
    const rows = SAMPLE_WORKSPACES;
    expect(filterWorkspacesByQuery(rows, "FLOCK").map((r) => r.id)).toEqual([
      "w1",
    ]);
    expect(filterWorkspacesByQuery(rows, "marketing").map((r) => r.id)).toEqual(
      ["w2"],
    );
    // Path-only hit: "personal" only appears in w3's path.
    expect(filterWorkspacesByQuery(rows, "personal").map((r) => r.id)).toEqual([
      "w3",
    ]);
    // Empty query returns all rows in original order.
    expect(filterWorkspacesByQuery(rows, "").map((r) => r.id)).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
    // Whitespace-only query also returns all rows.
    expect(filterWorkspacesByQuery(rows, "   ").map((r) => r.id)).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
  });

  it("filters the rendered grid against the URL query (name OR path, case-insensitive)", () => {
    renderWithRouter(
      "/workspaces?q=PERSONAL",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={() => {}}
      />,
    );
    const cards = screen.getAllByTestId("workspace-card");
    // Only `docs` (path /Users/me/personal/docs) matches.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-workspace-id")).toBe("w3");
  });

  // Negative test (per task spec): empty result shows empty-state with CTA.
  it("empty result shows full-width empty-state with a + New workspace CTA", async () => {
    vi.useFakeTimers();

    const onNewWorkspace = vi.fn();
    renderWithRouter(
      "/workspaces",
      <WorkspacesGrid
        workspaces={SAMPLE_WORKSPACES}
        onNewWorkspace={onNewWorkspace}
      />,
    );

    // Sanity: the grid lists all rows up front.
    expect(screen.getByTestId("workspaces-grid-list")).toBeTruthy();
    expect(screen.getAllByTestId("workspace-card")).toHaveLength(3);

    const input = screen.getByRole("searchbox", {
      name: /search workspaces/i,
    });
    fireEvent.change(input, { target: { value: "zzz-no-match-xyzzy" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // The grid container is gone; the empty-state has replaced it.
    expect(screen.queryByTestId("workspaces-grid-list")).toBeNull();
    expect(screen.queryAllByTestId("workspace-card")).toHaveLength(0);
    expect(screen.queryByTestId("add-workspace-card")).toBeNull();

    const empty = screen.getByTestId("workspaces-grid-empty-state");
    expect(empty.textContent).toContain("zzz-no-match-xyzzy");

    // CTA in the empty state forwards to the new-workspace handler.
    // Switch back to real timers before driving userEvent.
    vi.useRealTimers();
    const user = userEvent.setup();
    const cta = screen.getByTestId("workspaces-empty-cta");
    await user.click(cta);
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does NOT show the empty-state when workspaces is empty but no query is active", () => {
    // When there's no query, the empty-state belongs to the parent page
    // (matching `workspaces.tsx`'s "no workspaces yet" panel). The grid
    // itself just renders the trailing dashed AddWorkspaceCard.
    renderWithRouter(
      "/workspaces",
      <WorkspacesGrid workspaces={[]} onNewWorkspace={() => {}} />,
    );
    expect(screen.queryByTestId("workspaces-grid-empty-state")).toBeNull();
    expect(screen.getByTestId("workspaces-grid-list")).toBeTruthy();
    expect(screen.getByTestId("add-workspace-card")).toBeTruthy();
  });
});
