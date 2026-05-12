import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SkillsSection } from "@/pages/settings-components/SkillsSection";

/**
 * Contract tests for the settings page Skills section.
 *
 * Pins down:
 *   - The three skill source rows render in order (System / User /
 *     Project) with the right canonical paths.
 *   - The layout uses a FlatCard panel and the spec's
 *     `grid grid-cols-[200px_1fr_auto]` form-row template.
 *   - Each row exposes an accessible `role="switch"` toggle wired to
 *     localStorage under `flockctl.skills.source.<id>`.
 *   - Defaults: every source is enabled when no preference is set;
 *     existing preferences hydrate on mount.
 */

const STORAGE_KEY_PREFIX = "flockctl.skills.source.";

// jsdom 29's `localStorage` is opt-in via Vitest CLI; the project doesn't
// pass `--localstorage-file=…`, so we install an in-memory shim per-test
// (mirrors the same workaround used in `settings-account.test.tsx`).
let storageBacking: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k: string, v: string) => {
    storageBacking[k] = v;
  },
  removeItem: (k: string) => {
    delete storageBacking[k];
  },
  clear: () => {
    storageBacking = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  storageBacking = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
});

describe("SkillsSection — form surface", () => {
  it("renders all three source rows in order", () => {
    render(<SkillsSection />);
    const labels = ["System", "User", "Project"];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // Order is pinned through the row testids — they must match the
    // System/User/Project order the slice spec dictates.
    const rows = screen.getAllByTestId(/^skills-source-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "skills-source-row-system",
      "skills-source-row-user",
      "skills-source-row-project",
    ]);
  });

  it("renders the canonical path for each source", () => {
    render(<SkillsSection />);
    expect(
      screen.getByTestId("skills-source-path-system"),
    ).toHaveTextContent("Bundled with Flockctl");
    expect(
      screen.getByTestId("skills-source-path-user"),
    ).toHaveTextContent("~/flockctl/skills");
    expect(
      screen.getByTestId("skills-source-path-project"),
    ).toHaveTextContent("<project>/.flockctl/skills");
  });

  it("wraps content in a FlatCard panel (rounded-xl border + bg-card)", () => {
    const { container } = render(<SkillsSection />);
    const cards = container.querySelectorAll("div.rounded-xl.border.bg-card");
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  it("each row uses the grid-cols-[200px_1fr_auto] template", () => {
    const { container } = render(<SkillsSection />);
    const rows = container.querySelectorAll(
      ".grid-cols-\\[200px_1fr_auto\\]",
    );
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.className).toContain("grid");
      expect(row.className).toContain("gap-4");
      expect(row.className).toContain("items-center");
    }
  });

  it("renders one role=switch toggle per row, aria-label set", () => {
    render(<SkillsSection />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(switches[0]).toHaveAttribute("aria-label", "Enable System skills");
    expect(switches[1]).toHaveAttribute("aria-label", "Enable User skills");
    expect(switches[2]).toHaveAttribute(
      "aria-label",
      "Enable Project skills",
    );
  });
});

describe("SkillsSection — toggle behaviour", () => {
  it("defaults every source to enabled when no preference exists", () => {
    render(<SkillsSection />);
    const switches = screen.getAllByRole("switch");
    for (const s of switches) {
      expect(s.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("hydrates persisted false preferences on mount", () => {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}user`, "false");
    render(<SkillsSection />);
    expect(
      screen
        .getByTestId("skills-source-toggle-user")
        .getAttribute("aria-checked"),
    ).toBe("false");
    // Untouched sources still default to true.
    expect(
      screen
        .getByTestId("skills-source-toggle-system")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("clicking a toggle flips aria-checked and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);

    const projectToggle = screen.getByTestId("skills-source-toggle-project");
    expect(projectToggle.getAttribute("aria-checked")).toBe("true");

    await user.click(projectToggle);
    expect(projectToggle.getAttribute("aria-checked")).toBe("false");
    expect(
      window.localStorage.getItem(`${STORAGE_KEY_PREFIX}project`),
    ).toBe("false");

    await user.click(projectToggle);
    expect(projectToggle.getAttribute("aria-checked")).toBe("true");
    expect(
      window.localStorage.getItem(`${STORAGE_KEY_PREFIX}project`),
    ).toBe("true");
  });

  it("toggles do not affect each other (System click leaves User/Project untouched)", async () => {
    const user = userEvent.setup();
    render(<SkillsSection />);

    await user.click(screen.getByTestId("skills-source-toggle-system"));
    expect(
      screen
        .getByTestId("skills-source-toggle-system")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("skills-source-toggle-user")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("skills-source-toggle-project")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
