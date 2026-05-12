import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  SkillRow,
  type SkillRowData,
  type SkillScope,
} from "@/pages/skills-mcp-components/SkillRow";

/**
 * Unit tests for {@link SkillRow} (slice
 * `25-ui-redesign-library-surfaces/01-skills-mcp` T01).
 *
 * The row is presentational, so the tests cover the prop-contract
 * surface directly:
 *
 *   - happy path: name (mono) + description + scope StatusPill +
 *     tag row;
 *   - card-body click fires `onClick` exactly once when provided;
 *     without `onClick` the card is non-interactive (no `role=button`);
 *   - scope tones map: system → neutral (zinc), user → info (indigo),
 *     project → success (emerald). Negative test
 *     `skill-row.test.tsx::scope tones distinct: zinc/indigo/emerald.`
 *     pins this contract.
 *   - clicking a row fires the parent's onClick (the parent wires it
 *     into the existing skill-detail route — negative test
 *     `skill-row.test.tsx::clicking opens skill detail (existing route).`);
 *   - edge cases: long name truncates (title attr carries full text),
 *     10 tags wrap to multiple rows (none dropped), empty tags / empty
 *     description degrade gracefully.
 */

function makeSkill(overrides: Partial<SkillRowData> = {}): SkillRowData {
  return {
    key: "system:planning",
    name: "planning",
    description:
      "Decompose features into milestone → slice → task plans on disk.",
    scope: "system",
    tags: ["plan", "decompose", "milestone", "slice"],
    ...overrides,
  };
}

describe("SkillRow / happy path", () => {
  it("renders name (mono), description, scope StatusPill and tag row", () => {
    render(<SkillRow skill={makeSkill()} />);

    const root = screen.getByTestId("skill-row");
    expect(root.getAttribute("data-skill-key")).toBe("system:planning");
    expect(root.getAttribute("data-scope")).toBe("system");

    const name = screen.getByTestId("skill-row-name");
    expect(name.textContent).toBe("planning");
    expect(name.className).toContain("mono");
    expect(name.className).toContain("truncate");

    const desc = screen.getByTestId("skill-row-description");
    expect(desc.textContent).toContain("Decompose features");

    const scope = screen.getByTestId("skill-row-scope");
    expect(scope.textContent?.toLowerCase()).toBe("system");

    const tags = screen.getAllByTestId("skill-row-tag");
    expect(tags.map((t) => t.textContent)).toEqual([
      "plan",
      "decompose",
      "milestone",
      "slice",
    ]);
  });
});

describe("SkillRow / scope tones", () => {
  // Negative test (per task spec): tones distinct: zinc / indigo / emerald.
  it("scope tones distinct: zinc/indigo/emerald", () => {
    // Render one of each scope and harvest the StatusPill's data-tone +
    // colour-class signature. Each scope must paint a distinct tone.
    const cases: Array<{
      scope: SkillScope;
      tone: string;
      colourClass: string;
    }> = [
      { scope: "system", tone: "neutral", colourClass: "zinc" },
      { scope: "user", tone: "info", colourClass: "indigo" },
      { scope: "project", tone: "success", colourClass: "emerald" },
    ];

    const seen = new Set<string>();
    for (const c of cases) {
      const { unmount } = render(
        <SkillRow
          skill={makeSkill({
            key: `${c.scope}:k`,
            scope: c.scope,
            name: `n-${c.scope}`,
          })}
        />,
      );
      const pill = screen.getByTestId("skill-row-scope");
      // data-tone proves the StatusPill received the expected semantic tone.
      expect(pill.getAttribute("data-tone")).toBe(c.tone);
      // The colour class is materialised on the pill so the Tailwind JIT
      // scanner picks it up — also our visible signal of distinctness.
      expect(pill.className).toContain(c.colourClass);
      seen.add(c.colourClass);
      unmount();
    }
    // All three palette classes (zinc/indigo/emerald) appeared exactly once.
    expect(seen.size).toBe(3);
    expect(seen.has("zinc")).toBe(true);
    expect(seen.has("indigo")).toBe(true);
    expect(seen.has("emerald")).toBe(true);
  });
});

describe("SkillRow / click behaviour", () => {
  // Negative test (per task spec): clicking opens skill detail (existing route).
  // The parent owns the route / dialog; the row's contract is "onClick fires".
  it("clicking opens skill detail (existing route)", () => {
    const onClick = vi.fn();
    render(<SkillRow skill={makeSkill()} onClick={onClick} />);
    fireEvent.click(screen.getByTestId("skill-row-name"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is non-interactive when onClick is omitted (no role=button)", () => {
    render(<SkillRow skill={makeSkill()} />);
    expect(
      screen.queryByRole("button", { name: /planning/i }),
    ).toBeNull();
  });

  it("activates on Enter / Space when interactive", () => {
    const onClick = vi.fn();
    render(<SkillRow skill={makeSkill()} onClick={onClick} />);
    const card = screen.getByRole("button");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("SkillRow / edge cases", () => {
  it("truncates a long name; title attribute carries the full string", () => {
    const longName = "a".repeat(120);
    render(
      <SkillRow
        skill={makeSkill({ name: longName, key: `system:${longName}` })}
      />,
    );
    const name = screen.getByTestId("skill-row-name");
    expect(name.textContent).toBe(longName);
    expect(name.className).toContain("truncate");
    expect(name.getAttribute("title")).toBe(longName);
  });

  it("renders all 10 tags on a flex-wrap row (none dropped)", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    render(<SkillRow skill={makeSkill({ tags })} />);
    const row = screen.getByTestId("skill-row-tags");
    expect(row.className).toContain("flex-wrap");
    const pills = screen.getAllByTestId("skill-row-tag");
    expect(pills).toHaveLength(10);
    expect(pills.map((p) => p.textContent)).toEqual(tags);
  });

  it("hides the tags row when tags is empty or undefined", () => {
    render(<SkillRow skill={makeSkill({ tags: [] })} />);
    expect(screen.queryByTestId("skill-row-tags")).toBeNull();

    const skill = makeSkill();
    delete (skill as Partial<SkillRowData>).tags;
    const { unmount } = render(<SkillRow skill={skill} />);
    expect(screen.queryByTestId("skill-row-tags")).toBeNull();
    unmount();
  });

  it("hides the description when null / undefined / empty", () => {
    render(<SkillRow skill={makeSkill({ description: null })} />);
    expect(screen.queryByTestId("skill-row-description")).toBeNull();

    const skill = makeSkill();
    delete (skill as Partial<SkillRowData>).description;
    const { unmount } = render(<SkillRow skill={skill} />);
    expect(screen.queryByTestId("skill-row-description")).toBeNull();
    unmount();
  });
});
