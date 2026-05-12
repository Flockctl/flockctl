import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

import {
  SkillsPane,
  filterSkillsByScope,
  SCOPE_ALL,
} from "@/pages/skills-mcp-components/SkillsPane";
import type {
  SkillRowData,
  SkillScope,
} from "@/pages/skills-mcp-components/SkillRow";

/**
 * Contract tests for the scope chip row of {@link SkillsPane} (slice
 * 25-01 T01).
 *
 *   - row layout: `All`, then one chip per scope (System / Project / User);
 *   - default-selected chip is `All` (uncontrolled mode);
 *   - active chip carries `bg-zinc-200 dark:bg-zinc-800 font-medium`;
 *   - clicking a chip narrows the visible list to that scope only;
 *   - clicking the same chip twice keeps it selected (no deselect);
 *   - clicking `All` after a scope selection restores the full list;
 *   - controlled mode round-trips through `scope` + `onScopeChange`;
 *   - `filterSkillsByScope` honours `SCOPE_ALL` (passthrough) and each
 *     scope value individually.
 */

const SAMPLE_SKILLS: SkillRowData[] = [
  {
    key: "system:planning",
    name: "planning",
    description: "Decompose features into milestone → slice → task plans.",
    scope: "system",
    tags: ["plan"],
  },
  {
    key: "system:bundled-debug",
    name: "debugging",
    description: "Bundled debugger skill.",
    scope: "system",
    tags: ["debug"],
  },
  {
    key: "project:testing",
    name: "testing",
    description: "Vitest backend + Playwright UI.",
    scope: "project",
    tags: ["test"],
  },
  {
    key: "user:debug-like-expert",
    name: "debug-like-expert",
    description: "Methodical investigation protocol.",
    scope: "user",
    tags: ["debug"],
  },
];

describe("SkillsPane — scope chip row layout", () => {
  it("renders All, System, Project, User — in that order", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);

    const all = screen.getByTestId("skills-scope-chip-all");
    const system = screen.getByTestId("skills-scope-chip-system");
    const project = screen.getByTestId("skills-scope-chip-project");
    const user = screen.getByTestId("skills-scope-chip-user");

    expect(all.textContent).toBe("All");
    expect(system.textContent).toBe("System");
    expect(project.textContent).toBe("Project");
    expect(user.textContent).toBe("User");

    // Document order matches the slice spec ordering.
    expect(
      all.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      system.compareDocumentPosition(project) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      project.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("defaults to All in uncontrolled mode", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    expect(
      screen.getByTestId("skills-scope-chip-all").getAttribute("aria-pressed"),
    ).toBe("true");
    for (const v of ["system", "project", "user"]) {
      expect(
        screen
          .getByTestId(`skills-scope-chip-${v}`)
          .getAttribute("aria-pressed"),
      ).toBe("false");
    }
  });

  it("active chip carries bg-zinc-200 dark:bg-zinc-800 font-medium", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    fireEvent.click(screen.getByTestId("skills-scope-chip-system"));
    const system = screen.getByTestId("skills-scope-chip-system");
    expect(system.getAttribute("aria-pressed")).toBe("true");
    for (const cls of ["bg-zinc-200", "dark:bg-zinc-800", "font-medium"]) {
      expect(system.className).toContain(cls);
    }
    const all = screen.getByTestId("skills-scope-chip-all");
    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(all.className).not.toContain("bg-zinc-200");
  });
});

describe("SkillsPane — scope chip filtering", () => {
  it("clicking System narrows the list to system-scoped skills only", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    fireEvent.click(screen.getByTestId("skills-scope-chip-system"));

    const visible = screen.getAllByTestId("skill-row");
    expect(visible).toHaveLength(2);
    expect(
      visible.map((row) => row.getAttribute("data-skill-key")),
    ).toEqual(["system:planning", "system:bundled-debug"]);
  });

  it("clicking Project narrows the list to project-scoped only", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    fireEvent.click(screen.getByTestId("skills-scope-chip-project"));
    const visible = screen.getAllByTestId("skill-row");
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute("data-skill-key")).toBe("project:testing");
  });

  it("clicking User narrows the list to user-scoped only", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    fireEvent.click(screen.getByTestId("skills-scope-chip-user"));
    const visible = screen.getAllByTestId("skill-row");
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute("data-skill-key")).toBe(
      "user:debug-like-expert",
    );
  });

  it("clicking All from a scope filter restores the full list", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    fireEvent.click(screen.getByTestId("skills-scope-chip-system"));
    expect(screen.getAllByTestId("skill-row")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("skills-scope-chip-all"));
    expect(screen.getAllByTestId("skill-row")).toHaveLength(4);
  });

  it("clicking the same chip twice keeps it selected (no deselect)", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    const system = screen.getByTestId("skills-scope-chip-system");
    fireEvent.click(system);
    expect(system.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(system);
    expect(system.getAttribute("aria-pressed")).toBe("true");
    // The list stays narrowed; no flip back to "all".
    expect(screen.getAllByTestId("skill-row")).toHaveLength(2);
  });
});

describe("SkillsPane — controlled scope mode", () => {
  it("forwards chip clicks to onScopeChange and uses the parent's value", () => {
    const onScopeChange = vi.fn();
    function Harness() {
      const [scope, setScope] = useState<SkillScope | typeof SCOPE_ALL>(
        "system",
      );
      return (
        <SkillsPane
          skills={SAMPLE_SKILLS}
          scope={scope}
          onScopeChange={(next) => {
            onScopeChange(next);
            setScope(next);
          }}
        />
      );
    }
    render(<Harness />);

    // Parent value is "system" on mount → only system-scoped rows visible.
    expect(
      screen.getByTestId("skills-scope-chip-system").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getAllByTestId("skill-row")).toHaveLength(2);

    // Click "Project" — callback fires with the new value, parent updates.
    fireEvent.click(screen.getByTestId("skills-scope-chip-project"));
    expect(onScopeChange).toHaveBeenLastCalledWith("project");
    expect(screen.getAllByTestId("skill-row")).toHaveLength(1);
  });
});

describe("filterSkillsByScope", () => {
  it("returns every row when scope === SCOPE_ALL", () => {
    expect(
      filterSkillsByScope(SAMPLE_SKILLS, SCOPE_ALL).map((s) => s.key),
    ).toEqual([
      "system:planning",
      "system:bundled-debug",
      "project:testing",
      "user:debug-like-expert",
    ]);
  });

  it.each([
    ["system", ["system:planning", "system:bundled-debug"]],
    ["project", ["project:testing"]],
    ["user", ["user:debug-like-expert"]],
  ] as const)("%s → only the matching rows", (scope, expected) => {
    expect(filterSkillsByScope(SAMPLE_SKILLS, scope).map((s) => s.key)).toEqual(
      expected,
    );
  });

  it("preserves source order within a scope", () => {
    expect(
      filterSkillsByScope(SAMPLE_SKILLS, "system").map((s) => s.name),
    ).toEqual(["planning", "debugging"]);
  });
});
