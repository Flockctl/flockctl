import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  WorkspaceCard,
  type WorkspaceCardData,
} from "@/pages/workspaces-components/WorkspaceCard";
import {
  workspaceTone,
  WORKSPACE_TONE_GRADIENT,
  WORKSPACE_TONES,
} from "@/lib/workspace-tone";

/**
 * Unit tests for {@link WorkspaceCard} (slice 23-03 T01).
 *
 * The card is presentational, so the tests cover the prop-contract
 * surface directly:
 *   - happy path: avatar tile (gradient + initial) + name + active pill
 *     + mono path + kebab + description + project count + active-tasks
 *     indicator + relative time;
 *   - click → navigate to /workspaces/:id (or fire onClick override);
 *   - kebab opens a dropdown with rename/archive/delete and clicks do
 *     NOT bubble to the card-level navigation;
 *   - edge cases: missing description falls back to first three project
 *     names; zero projects + no description → no description block;
 *     active=false hides ACTIVE pill; activeTaskCount=0 → idle indicator;
 *     long name + path get truncate-wrapped; tone is deterministic and
 *     stays stable across re-renders.
 */

function makeWorkspace(
  overrides: Partial<WorkspaceCardData> = {},
): WorkspaceCardData {
  return {
    id: "ws-flockctl",
    name: "flockctl",
    path: "/Users/me/code/flockctl",
    description: "Local-first control plane for AI coding agents.",
    active: true,
    projectCount: 4,
    projectNames: ["flockctl", "ui", "docs", "infra"],
    activeTaskCount: 3,
    lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    ...overrides,
  };
}

function renderInRouter(ui: React.ReactNode, initialEntry = "/workspaces") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/workspaces" element={ui} />
        <Route path="/workspaces/:id" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname}</div>;
}

describe("workspaceTone", () => {
  it("returns one of the five canonical tones", () => {
    for (const name of [
      "flockctl",
      "personal",
      "open-source",
      "experiments",
      "x",
      "",
    ]) {
      expect(WORKSPACE_TONES).toContain(workspaceTone(name));
    }
  });

  it("is deterministic — same input → same output", () => {
    expect(workspaceTone("flockctl")).toBe(workspaceTone("flockctl"));
    expect(workspaceTone("personal")).toBe(workspaceTone("personal"));
    // And distinct names usually map to distinct tones (anti-collision
    // is best-effort, but these specific names happen to spread):
    const tones = new Set(
      ["work", "play", "ed", "anthropic", "qa"].map(workspaceTone),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("matches the manual hash spec (sum of charCodeAt mod 5)", () => {
    // Manual reference for "abc" — 97 + 98 + 99 = 294, 294 % 5 = 4 → blue.
    expect(workspaceTone("abc")).toBe("blue");
    // Empty string → 0 → indigo.
    expect(workspaceTone("")).toBe("indigo");
  });

  it("exposes a literal Tailwind gradient string for every tone", () => {
    for (const tone of WORKSPACE_TONES) {
      const cls = WORKSPACE_TONE_GRADIENT[tone];
      // Each entry must contain a literal `from-` and `to-` so the
      // Tailwind JIT scanner picks them up at build time.
      expect(cls).toMatch(/from-\w+-\d+/);
      expect(cls).toMatch(/to-\w+-\d+/);
    }
  });
});

describe("WorkspaceCard / happy path", () => {
  it("renders avatar (initial + gradient), name, ACTIVE pill, path, description, project count, tasks-running indicator and relative time", () => {
    // Freeze time locally so the "2h ago" assertion is stable on slow CI.
    // Scoped to this test (not a beforeEach) because Radix's
    // dropdown-trigger animations interact poorly with global fake
    // timers in the kebab tests below.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    try {
      renderInRouter(<WorkspaceCard workspace={makeWorkspace()} />);

    // Avatar: shows the uppercase initial of the name and the
    // deterministic gradient class for "flockctl".
    const avatar = screen.getByTestId("workspace-card-avatar");
    expect(avatar.textContent).toBe("F");
    const expectedTone = workspaceTone("flockctl");
    expect(avatar.className).toContain(
      WORKSPACE_TONE_GRADIENT[expectedTone].split(" ")[0],
    );

    // Name + active pill.
    expect(screen.getByText("flockctl")).toBeTruthy();
    expect(screen.getByTestId("workspace-card-active-pill").textContent).toBe(
      "active",
    );

    // Mono path.
    const path = screen.getByTestId("workspace-card-path");
    expect(path.textContent).toBe("/Users/me/code/flockctl");
    expect(path.className).toContain("font-mono");
    expect(path.className).toContain("truncate");

    // Description.
    expect(
      screen.getByTestId("workspace-card-description").textContent,
    ).toContain("Local-first");

    // Bottom row: projects + tasks running + relative time.
    expect(
      screen.getByTestId("workspace-card-project-count").textContent,
    ).toContain("4 projects");
    const tasks = screen.getByTestId("workspace-card-tasks-running");
    expect(tasks.textContent).toContain("3 tasks running");
    expect(tasks.className).toContain("emerald");

      const lastActivity = screen.getByTestId(
        "workspace-card-last-activity",
      );
      // 2h ago → "2h ago" per timeAgo.
      expect(lastActivity.textContent).toMatch(/h ago$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("singularises 'project' / 'task' when the count is exactly 1", () => {
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({ projectCount: 1, activeTaskCount: 1 })}
      />,
    );
    expect(
      screen.getByTestId("workspace-card-project-count").textContent,
    ).toContain("1 project");
    expect(
      screen.getByTestId("workspace-card-tasks-running").textContent,
    ).toContain("1 task running");
  });
});

describe("WorkspaceCard / navigation", () => {
  it("navigates to /workspaces/:id when the card body is clicked", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ id: "ws-42" })} />,
    );
    fireEvent.click(screen.getByTestId("workspace-card"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/workspaces/ws-42",
    );
  });

  it("respects a custom onClick override (no router navigation)", () => {
    const onClick = vi.fn();
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({ id: "ws-42" })}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByTestId("workspace-card"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });
});

describe("WorkspaceCard / kebab menu", () => {
  it("does not render the kebab when no action callbacks are passed", () => {
    renderInRouter(<WorkspaceCard workspace={makeWorkspace()} />);
    expect(screen.queryByTestId("workspace-card-kebab")).toBeNull();
  });

  it("renders the kebab and opens the dropdown without navigating away", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({ id: "ws-42" })}
        onRename={onRename}
        onArchive={onArchive}
        onDelete={onDelete}
      />,
    );

    const kebab = screen.getByTestId("workspace-card-kebab");
    await user.click(kebab);

    // Card-level navigation should NOT have fired.
    expect(screen.queryByTestId("navigated-to")).toBeNull();

    expect(await screen.findByText("Rename")).toBeTruthy();
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });
});

describe("WorkspaceCard / edge cases", () => {
  it("hides the ACTIVE pill when active=false", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ active: false })} />,
    );
    expect(screen.queryByTestId("workspace-card-active-pill")).toBeNull();
  });

  it("hides the ACTIVE pill when active is undefined", () => {
    const ws = makeWorkspace();
    delete (ws as Partial<WorkspaceCardData>).active;
    renderInRouter(<WorkspaceCard workspace={ws} />);
    expect(screen.queryByTestId("workspace-card-active-pill")).toBeNull();
  });

  it("renders an idle indicator when activeTaskCount = 0", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ activeTaskCount: 0 })} />,
    );
    expect(screen.queryByTestId("workspace-card-tasks-running")).toBeNull();
    expect(screen.getByTestId("workspace-card-idle").textContent).toContain(
      "idle",
    );
  });

  it("falls back to first three project names when description is null", () => {
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({
          description: null,
          projectNames: ["alpha", "beta", "gamma", "delta", "epsilon"],
        })}
      />,
    );
    const desc = screen.getByTestId("workspace-card-description");
    expect(desc.textContent).toBe("alpha, beta, gamma");
    expect(desc.textContent).not.toContain("delta");
  });

  it("omits the description block entirely when description is null and there are no project names", () => {
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({
          description: null,
          projectNames: [],
        })}
      />,
    );
    expect(screen.queryByTestId("workspace-card-description")).toBeNull();
  });

  it("omits the description block when description is null and projectNames is undefined", () => {
    const ws = makeWorkspace({ description: null });
    delete (ws as Partial<WorkspaceCardData>).projectNames;
    renderInRouter(<WorkspaceCard workspace={ws} />);
    expect(screen.queryByTestId("workspace-card-description")).toBeNull();
  });

  it("renders an em-dash when lastActivityAt is null/undefined (timeAgo fallback)", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ lastActivityAt: null })} />,
    );
    expect(
      screen.getByTestId("workspace-card-last-activity").textContent,
    ).toBe("—");
  });

  it("uppercases the avatar initial regardless of name casing", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ name: "personal" })} />,
    );
    expect(screen.getByTestId("workspace-card-avatar").textContent).toBe("P");
  });

  it("renders a placeholder initial when name is empty", () => {
    renderInRouter(<WorkspaceCard workspace={makeWorkspace({ name: "" })} />);
    expect(screen.getByTestId("workspace-card-avatar").textContent).toBe("?");
  });

  it("truncates long names and paths via min-w-0 + truncate", () => {
    const longName = "x".repeat(80);
    const longPath = "/" + "very/long/path/segment".repeat(5);
    renderInRouter(
      <WorkspaceCard
        workspace={makeWorkspace({ name: longName, path: longPath })}
      />,
    );
    const path = screen.getByTestId("workspace-card-path");
    expect(path.className).toContain("truncate");
    expect(screen.getByText(longName).className).toContain("truncate");
  });
});

describe("WorkspaceCard / deterministic tone", () => {
  it("paints the same gradient class on every render for a given name", () => {
    const { rerender, getByTestId } = renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ name: "anthropic" })} />,
    );
    const firstTone = getByTestId("workspace-card").getAttribute("data-tone");
    expect(firstTone).toBeTruthy();

    rerender(
      <MemoryRouter initialEntries={["/workspaces"]}>
        <Routes>
          <Route
            path="/workspaces"
            element={
              <WorkspaceCard workspace={makeWorkspace({ name: "anthropic" })} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    const secondTone = getByTestId("workspace-card").getAttribute("data-tone");
    expect(secondTone).toBe(firstTone);
  });

  it("paints the tone returned by workspaceTone(name)", () => {
    renderInRouter(
      <WorkspaceCard workspace={makeWorkspace({ name: "abc" })} />,
    );
    // "abc" → 294 % 5 = 4 → blue per workspace-tone unit test.
    expect(
      screen.getByTestId("workspace-card").getAttribute("data-tone"),
    ).toBe("blue");
    expect(
      screen.getByTestId("workspace-card-avatar").className,
    ).toContain("from-blue-400");
  });
});

