import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { SectionHeader } from "@/components/design/SectionHeader";

/**
 * Unit tests for {@link SectionHeader}.
 *
 * Boundaries we exercise — happy path + a handful of variant + negative
 * combinations, per the design-primitives slice DoD (slice 22-02 T04):
 *
 *   - Default size renders an `<h1>` (page title block).
 *   - Subtitle is wired through at both sizes.
 *   - Right-aligned `action` slot renders nodes verbatim.
 *   - Section size renders an `<h2>`, a leading swatch (when given),
 *     and the horizontal hairline that fills the remaining row.
 *   - Negative: omitting `subtitle`/`action` does NOT render their
 *     containers (no orphan empty `<p>` / `<div>`s).
 */

describe("SectionHeader (size=page, default)", () => {
  it("renders an h1 with the title and the page-size class", () => {
    render(<SectionHeader title="Projects" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Projects");
    expect(h1.className).toContain("text-[15px]");
    expect(h1.className).toContain("font-semibold");
  });

  it("marks the wrapper with data-size='page' so callers can assert", () => {
    render(<SectionHeader title="Projects" />);
    const wrapper = screen.getByTestId("section-header");
    expect(wrapper.getAttribute("data-size")).toBe("page");
  });

  it("renders the subtitle as a muted <p>", () => {
    render(<SectionHeader title="Projects" subtitle="All your repos" />);
    const subtitle = screen.getByText("All your repos");
    expect(subtitle.tagName).toBe("P");
    expect(subtitle.className).toContain("text-zinc-500");
  });

  it("renders the action slot to the right of the title", () => {
    render(
      <SectionHeader
        title="Projects"
        action={<button data-testid="primary-cta">New project</button>}
      />,
    );
    expect(screen.getByTestId("primary-cta")).toBeTruthy();
  });

  it("does not emit an empty action container when no action is given", () => {
    render(<SectionHeader title="Projects" />);
    // The wrapper has exactly one child (the title block) — no orphan
    // right-aligned `<div class="flex items-center gap-2">`.
    const wrapper = screen.getByTestId("section-header");
    expect(wrapper.children.length).toBe(1);
  });

  it("does not emit an empty <p> when no subtitle is given", () => {
    render(<SectionHeader title="Projects" />);
    expect(screen.queryByText("", { selector: "p" })).toBeNull();
  });
});

describe("SectionHeader (size=section)", () => {
  it("renders an h2 (NOT an h1) with the title", () => {
    render(<SectionHeader size="section" title="Recent activity" />);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe("Recent activity");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("marks the wrapper with data-size='section'", () => {
    render(<SectionHeader size="section" title="Recent activity" />);
    expect(screen.getByTestId("section-header").getAttribute("data-size")).toBe(
      "section",
    );
  });

  it("renders a small zinc-500 subtitle (count slot)", () => {
    render(
      <SectionHeader size="section" title="Tasks" subtitle="12 items" />,
    );
    const subtitle = screen.getByText("12 items");
    expect(subtitle.tagName).toBe("SPAN");
    expect(subtitle.className).toContain("text-[11px]");
    expect(subtitle.className).toContain("text-zinc-500");
  });

  it("renders the leading colour swatch when leadingSwatch is given", () => {
    render(
      <SectionHeader
        size="section"
        title="Slices"
        leadingSwatch="bg-emerald-500"
      />,
    );
    const swatch = screen.getByTestId("section-header-swatch");
    expect(swatch.className).toContain("bg-emerald-500");
    expect(swatch.className).toContain("rounded-sm");
  });

  it("does NOT render a swatch when leadingSwatch is omitted", () => {
    render(<SectionHeader size="section" title="Slices" />);
    expect(screen.queryByTestId("section-header-swatch")).toBeNull();
  });

  it("renders a horizontal hairline that fills the remaining row", () => {
    const { container } = render(
      <SectionHeader size="section" title="Slices" />,
    );
    const hairline = container.querySelector("div.flex-1.h-px");
    expect(hairline).not.toBeNull();
    expect(hairline!.className).toContain("bg-zinc-200");
    expect(hairline!.className).toContain("dark:bg-zinc-800");
  });

  it("renders the action slot when given", () => {
    render(
      <SectionHeader
        size="section"
        title="Slices"
        action={<button data-testid="add-slice">Add</button>}
      />,
    );
    expect(screen.getByTestId("add-slice")).toBeTruthy();
  });
});
