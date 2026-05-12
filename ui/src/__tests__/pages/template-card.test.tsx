import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  TemplateCard,
  pickTileTone,
  pickTagTone,
  type TemplateCardData,
} from "@/pages/templates-components/TemplateCard";

/**
 * Unit tests for {@link TemplateCard} (slice
 * `25-ui-redesign-library-surfaces/00-templates` T00).
 *
 * The card is presentational, so the tests cover the prop-contract
 * surface directly:
 *   - happy path: icon-tile (tone-tinted bg + text) + name + tags
 *     (StatusPills) + description + footer with "Open in chat" button
 *     + relative-time stamp;
 *   - "Open in chat" fires the parent's instantiate callback exactly
 *     once, and does NOT also trigger the card-body click handler;
 *   - card-body click fires `onClick` when provided; without `onClick`
 *     the card is non-interactive (no `role=button`);
 *   - edge cases: long name truncates, 10 tags wrap onto multiple rows
 *     (none are dropped), no description / no tags / no last-used time
 *     all degrade gracefully, custom icon overrides the default.
 */

function makeTemplate(
  overrides: Partial<TemplateCardData> = {},
): TemplateCardData {
  return {
    key: "global::::refactor-snippet",
    name: "refactor-snippet",
    description: "Refactor a single function while preserving public API.",
    tags: ["claude", "sonnet"],
    lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    ...overrides,
  };
}

describe("pickTileTone", () => {
  it("is deterministic — same input → same output", () => {
    expect(pickTileTone("refactor-snippet")).toBe(
      pickTileTone("refactor-snippet"),
    );
    expect(pickTileTone("ship-it")).toBe(pickTileTone("ship-it"));
  });

  it("returns one of the five canonical tile tones", () => {
    const tones = new Set<string>();
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      tones.add(pickTileTone(name));
    }
    // All values must be members of the canonical set.
    for (const t of tones) {
      expect(["indigo", "emerald", "amber", "rose", "blue"]).toContain(t);
    }
  });

  it("matches the manual hash spec (sum charCodeAt mod 5)", () => {
    // "abc" → 97 + 98 + 99 = 294, 294 % 5 = 4 → blue.
    expect(pickTileTone("abc")).toBe("blue");
    // "" → 0 → indigo.
    expect(pickTileTone("")).toBe("indigo");
  });
});

describe("pickTagTone", () => {
  it("never returns the danger tone (tags must not look like errors)", () => {
    for (const tag of ["bug", "fail", "error", "danger", "red"]) {
      expect(pickTagTone(tag)).not.toBe("danger");
    }
  });

  it("is deterministic per tag string", () => {
    expect(pickTagTone("claude")).toBe(pickTagTone("claude"));
    expect(pickTagTone("openai")).toBe(pickTagTone("openai"));
  });
});

describe("TemplateCard / happy path", () => {
  it("renders icon-tile (tone-tinted), name, tags, description and footer with Open-in-chat + last-used time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    try {
      const onOpenInChat = vi.fn();
      render(
        <TemplateCard
          template={makeTemplate()}
          onOpenInChat={onOpenInChat}
        />,
      );

      // Card root carries the deterministic tone and the stable key.
      const root = screen.getByTestId("template-card");
      expect(root.getAttribute("data-template-key")).toBe(
        "global::::refactor-snippet",
      );
      const expectedTone = pickTileTone("refactor-snippet");
      expect(root.getAttribute("data-tone")).toBe(expectedTone);

      // Icon-tile: tinted background + text colour for the chosen tone.
      const icon = screen.getByTestId("template-card-icon");
      expect(icon.className).toContain(`bg-${expectedTone}-500/15`);
      expect(icon.className).toContain(`text-${expectedTone}-600`);

      // Name + truncate.
      const name = screen.getByTestId("template-card-name");
      expect(name.textContent).toBe("refactor-snippet");
      expect(name.className).toContain("truncate");

      // Tags: one StatusPill per tag.
      const tags = screen.getAllByTestId("template-card-tag");
      expect(tags).toHaveLength(2);
      expect(tags.map((t) => t.textContent)).toEqual(["claude", "sonnet"]);

      // Description.
      expect(
        screen.getByTestId("template-card-description").textContent,
      ).toContain("Refactor");

      // Footer: button + last-used.
      expect(
        screen.getByTestId("template-card-open-in-chat").textContent,
      ).toContain("Open in chat");
      // 2h ago → "2h ago" per timeAgo.
      expect(
        screen.getByTestId("template-card-last-used").textContent,
      ).toMatch(/h ago$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TemplateCard / Open in chat", () => {
  it("fires onOpenInChat exactly once when the footer button is clicked", () => {
    const onOpenInChat = vi.fn();
    render(
      <TemplateCard
        template={makeTemplate()}
        onOpenInChat={onOpenInChat}
      />,
    );
    fireEvent.click(screen.getByTestId("template-card-open-in-chat"));
    expect(onOpenInChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT also trigger the card-body onClick (stopPropagation)", () => {
    const onOpenInChat = vi.fn();
    const onClick = vi.fn();
    render(
      <TemplateCard
        template={makeTemplate()}
        onOpenInChat={onOpenInChat}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByTestId("template-card-open-in-chat"));
    expect(onOpenInChat).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("TemplateCard / card-body click", () => {
  it("fires onClick when clicking the card body and onClick is provided", () => {
    const onOpenInChat = vi.fn();
    const onClick = vi.fn();
    render(
      <TemplateCard
        template={makeTemplate()}
        onOpenInChat={onOpenInChat}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByTestId("template-card-name"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is non-interactive when onClick is omitted (no role=button on the FlatCard)", () => {
    const onOpenInChat = vi.fn();
    render(
      <TemplateCard
        template={makeTemplate()}
        onOpenInChat={onOpenInChat}
      />,
    );
    // The outer FlatCard is the role=button element — when interactive
    // is false, no element should carry that role inside the card.
    expect(screen.queryByRole("button", { name: /refactor-snippet/i })).toBeNull();
  });
});

describe("TemplateCard / edge cases", () => {
  it("truncates a long name (truncate class on the name span)", () => {
    const longName = "a".repeat(120);
    render(
      <TemplateCard
        template={makeTemplate({ name: longName, key: `global::::${longName}` })}
        onOpenInChat={vi.fn()}
      />,
    );
    const name = screen.getByTestId("template-card-name");
    expect(name.textContent).toBe(longName);
    expect(name.className).toContain("truncate");
    // The title attribute carries the full string for hover-reveal.
    expect(name.getAttribute("title")).toBe(longName);
  });

  it("renders all 10 tags on a flex-wrap row (none are dropped)", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    render(
      <TemplateCard
        template={makeTemplate({ tags })}
        onOpenInChat={vi.fn()}
      />,
    );
    const row = screen.getByTestId("template-card-tags");
    // The row container uses flex-wrap so tags spill to multiple rows.
    expect(row.className).toContain("flex-wrap");
    // Every tag is rendered — no truncation, no overflow hidden.
    const pills = screen.getAllByTestId("template-card-tag");
    expect(pills).toHaveLength(10);
    expect(pills.map((p) => p.textContent)).toEqual(tags);
  });

  it("hides the tags row when tags is empty or undefined", () => {
    render(
      <TemplateCard
        template={makeTemplate({ tags: [] })}
        onOpenInChat={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("template-card-tags")).toBeNull();

    const t = makeTemplate();
    delete (t as Partial<TemplateCardData>).tags;
    const { unmount } = render(
      <TemplateCard template={t} onOpenInChat={vi.fn()} />,
    );
    expect(screen.queryByTestId("template-card-tags")).toBeNull();
    unmount();
  });

  it("hides the description block when description is null/undefined/empty", () => {
    render(
      <TemplateCard
        template={makeTemplate({ description: null })}
        onOpenInChat={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("template-card-description")).toBeNull();
  });

  it("renders an em-dash when lastUsedAt is null (timeAgo fallback)", () => {
    render(
      <TemplateCard
        template={makeTemplate({ lastUsedAt: null })}
        onOpenInChat={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("template-card-last-used").textContent,
    ).toBe("—");
  });

  it("respects a custom icon override", () => {
    const CustomIcon = ({ className }: { className?: string }) => (
      <svg data-testid="custom-icon" className={className} />
    );
    render(
      <TemplateCard
        template={makeTemplate({ icon: CustomIcon })}
        onOpenInChat={vi.fn()}
      />,
    );
    expect(screen.getByTestId("custom-icon")).toBeTruthy();
  });

  it("paints the same tone class on every render for a given name (deterministic)", () => {
    const { rerender, getByTestId } = render(
      <TemplateCard
        template={makeTemplate({ name: "anthropic" })}
        onOpenInChat={vi.fn()}
      />,
    );
    const firstTone = getByTestId("template-card").getAttribute("data-tone");
    expect(firstTone).toBeTruthy();

    rerender(
      <TemplateCard
        template={makeTemplate({ name: "anthropic" })}
        onOpenInChat={vi.fn()}
      />,
    );
    expect(getByTestId("template-card").getAttribute("data-tone")).toBe(
      firstTone,
    );
  });
});
