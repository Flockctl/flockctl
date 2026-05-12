import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

import {
  SkillsPane,
  filterSkillsByQuery,
  SCOPE_ALL,
} from "@/pages/skills-mcp-components/SkillsPane";
import type { SkillRowData } from "@/pages/skills-mcp-components/SkillRow";

/**
 * Contract tests for the search-input portion of {@link SkillsPane}
 * (slice 25-01 T01).
 *
 *   - search box renders with the prototype's pill styling;
 *   - typing immediately filters the visible list (uncontrolled mode
 *     keeps internal state — no debounce in this surface, the list is
 *     small);
 *   - `filterSkillsByQuery` matches `name`, `description`, AND `tags[]`
 *     case-insensitively;
 *   - controlled mode round-trips: parent owns the value, pane forwards
 *     edits to `onQueryChange`;
 *   - empty result → empty-state title visible.
 */

const SAMPLE_SKILLS: SkillRowData[] = [
  {
    key: "system:planning",
    name: "planning",
    description: "Decompose features into milestone → slice → task plans.",
    scope: "system",
    tags: ["plan", "decompose", "milestone"],
  },
  {
    key: "project:testing",
    name: "testing",
    description: "Vitest backend + Playwright UI MANDATORY after feature.",
    scope: "project",
    tags: ["test", "vitest", "playwright"],
  },
  {
    key: "user:debug-like-expert",
    name: "debug-like-expert",
    description: "Methodical investigation protocol with hypothesis testing.",
    scope: "user",
    tags: ["debug", "investigation"],
  },
];

describe("SkillsPane — search input rendering", () => {
  it("renders a searchbox with the prototype classes and placeholder", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    const input = screen.getByRole("searchbox", { name: /search skills/i });
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
    ]) {
      expect(input.className).toContain(cls);
    }
    expect(input).toHaveAttribute("placeholder", "Search skills…");
  });
});

describe("SkillsPane — uncontrolled search filtering", () => {
  it("typing narrows the visible skill list", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);

    // All three rows up front.
    expect(screen.getAllByTestId("skill-row")).toHaveLength(3);

    const input = screen.getByRole("searchbox", { name: /search skills/i });
    fireEvent.change(input, { target: { value: "vitest" } });

    // Only the testing row matches: "vitest" is in its tags + description.
    const visible = screen.getAllByTestId("skill-row");
    expect(visible).toHaveLength(1);
    expect(
      visible[0]!.querySelector('[data-testid="skill-row-name"]')?.textContent,
    ).toBe("testing");
  });

  it("clearing the input restores the full list", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    const input = screen.getByRole("searchbox", { name: /search skills/i });

    fireEvent.change(input, { target: { value: "vitest" } });
    expect(screen.getAllByTestId("skill-row")).toHaveLength(1);

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getAllByTestId("skill-row")).toHaveLength(3);
  });

  it("empty result triggers the empty-state panel", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    const input = screen.getByRole("searchbox", { name: /search skills/i });

    fireEvent.change(input, { target: { value: "zzz-no-match-xyzzy" } });

    expect(screen.queryAllByTestId("skill-row")).toHaveLength(0);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(
      screen.getByText(/no skills match your filters/i),
    ).toBeInTheDocument();
  });
});

describe("SkillsPane — controlled search mode", () => {
  it("forwards edits to onQueryChange and uses the parent's value", () => {
    function Harness() {
      const [q, setQ] = useState("plan");
      return (
        <SkillsPane skills={SAMPLE_SKILLS} query={q} onQueryChange={setQ} />
      );
    }
    render(<Harness />);

    // Initial parent value is "plan" → only the planning row matches.
    const input = screen.getByRole("searchbox", {
      name: /search skills/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("plan");
    expect(screen.getAllByTestId("skill-row")).toHaveLength(1);

    // Type to widen the filter.
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(screen.getAllByTestId("skill-row")).toHaveLength(3);
  });
});

describe("filterSkillsByQuery", () => {
  it("matches name, description, AND tags — case-insensitively", () => {
    // name-only hit: "PLANNING".
    expect(
      filterSkillsByQuery(SAMPLE_SKILLS, "PLANNING").map((s) => s.key),
    ).toEqual(["system:planning"]);
    // description-only hit: "MANDATORY" only appears in the testing description.
    expect(
      filterSkillsByQuery(SAMPLE_SKILLS, "mandatory").map((s) => s.key),
    ).toEqual(["project:testing"]);
    // tag-only hit: "investigation" appears as a debug-like-expert tag.
    expect(
      filterSkillsByQuery(SAMPLE_SKILLS, "investigation").map((s) => s.key),
    ).toEqual(["user:debug-like-expert"]);
  });

  it("empty / whitespace query returns the full list in original order", () => {
    expect(filterSkillsByQuery(SAMPLE_SKILLS, "").map((s) => s.key)).toEqual([
      "system:planning",
      "project:testing",
      "user:debug-like-expert",
    ]);
    expect(
      filterSkillsByQuery(SAMPLE_SKILLS, "   ").map((s) => s.key),
    ).toEqual([
      "system:planning",
      "project:testing",
      "user:debug-like-expert",
    ]);
  });

  it("tolerates rows with missing description / tags", () => {
    const rows: SkillRowData[] = [
      { key: "k1", name: "alpha", scope: "system" },
      { key: "k2", name: "bravo", scope: "user", description: null },
      {
        key: "k3",
        name: "charlie",
        scope: "project",
        description: "alpha description",
      },
    ];
    expect(filterSkillsByQuery(rows, "alpha").map((s) => s.key)).toEqual([
      "k1",
      "k3",
    ]);
  });
});

describe("SkillsPane — header subtitle reflects filtered count", () => {
  it("subtitle updates as the user filters", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    const header = screen.getByTestId("skills-pane-header");
    expect(header.textContent).toContain("3");

    const input = screen.getByRole("searchbox", { name: /search skills/i });
    fireEvent.change(input, { target: { value: "vitest" } });
    expect(screen.getByTestId("skills-pane-header").textContent).toContain("1");
  });

  it("scope=all is the default uncontrolled value (no narrowing on mount)", () => {
    render(<SkillsPane skills={SAMPLE_SKILLS} />);
    expect(
      screen.getByTestId("skills-scope-chip-all").getAttribute("aria-pressed"),
    ).toBe("true");
    // sanity: SCOPE_ALL constant is exported and stable.
    expect(SCOPE_ALL).toBe("all");
  });
});
