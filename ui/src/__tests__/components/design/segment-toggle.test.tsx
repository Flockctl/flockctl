import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

import { SegmentToggle } from "@/components/design/SegmentToggle";

/**
 * Unit tests for {@link SegmentToggle} (slice 22-02 T03).
 *
 * The keyboard contract is the most subtle piece, so we exercise it
 * comprehensively: ArrowLeft/Right cycle (with wrap), Home/End jump,
 * Enter and Space activate. We also pin the wrapper / active /
 * inactive class triples from the slice so a future refactor can't
 * silently re-skin the primitive.
 */

const OPTIONS = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
  { value: "graph", label: "Graph" },
] as const satisfies ReadonlyArray<{ value: string; label: string }>;

type View = (typeof OPTIONS)[number]["value"];

describe("SegmentToggle — render contract", () => {
  it("renders one button per option with the labels verbatim", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} />);
    expect(screen.getByRole("radio", { name: "Cards" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Table" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Graph" })).toBeTruthy();
  });

  it("wraps the buttons in a role=radiogroup with the prototype classes", () => {
    render(
      <SegmentToggle<View> options={[...OPTIONS]} aria-label="View mode" />,
    );
    const group = screen.getByRole("radiogroup", { name: "View mode" });
    for (const cls of [
      "inline-flex",
      "bg-zinc-100",
      "dark:bg-zinc-800",
      "rounded",
      "p-0.5",
      "text-[12px]",
    ]) {
      expect(group.className).toContain(cls);
    }
    expect(group.getAttribute("data-size")).toBe("md");
  });

  it("applies sm size (text-[11px]) when requested", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} size="sm" />);
    const group = screen.getByTestId("segment-toggle");
    expect(group.className).toContain("text-[11px]");
    expect(group.className).not.toContain("text-[12px]");
    expect(group.getAttribute("data-size")).toBe("sm");
  });

  it("active option gets bg-white shadow-sm font-medium; inactive gets text-zinc-500 + hover", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="table" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    const table = screen.getByRole("radio", { name: "Table" });

    for (const cls of [
      "bg-white",
      "dark:bg-zinc-900",
      "shadow-sm",
      "font-medium",
    ]) {
      expect(table.className).toContain(cls);
    }
    for (const cls of [
      "text-zinc-500",
      "hover:text-zinc-900",
      "dark:hover:text-zinc-100",
    ]) {
      expect(cards.className).toContain(cls);
    }
  });

  it("aria-checked reflects selected state", () => {
    // `aria-pressed` was removed in T10's bug-bash pass — axe flags
    // `aria-pressed` as invalid on `role="radio"` (`aria-allowed-attr`,
    // critical). Radios advertise selection through `aria-checked`
    // exclusively; toggle-button semantics belong in a separate primitive.
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="graph" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    const graph = screen.getByRole("radio", { name: "Graph" });
    expect(graph.getAttribute("aria-checked")).toBe("true");
    expect(graph.getAttribute("aria-pressed")).toBeNull();
    expect(cards.getAttribute("aria-checked")).toBe("false");
    expect(cards.getAttribute("aria-pressed")).toBeNull();
  });

  it("only the active button is in the tab order (roving tabindex)", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="table" />);
    expect(
      screen.getByRole("radio", { name: "Cards" }).tabIndex,
    ).toBe(-1);
    expect(
      screen.getByRole("radio", { name: "Table" }).tabIndex,
    ).toBe(0);
    expect(
      screen.getByRole("radio", { name: "Graph" }).tabIndex,
    ).toBe(-1);
  });

  it("renders nothing when options is empty", () => {
    const { container } = render(<SegmentToggle options={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SegmentToggle — uncontrolled mode", () => {
  it("falls back to first option when no defaultValue is given", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} />);
    expect(
      screen
        .getByRole("radio", { name: "Cards" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("respects defaultValue", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="graph" />);
    expect(
      screen
        .getByRole("radio", { name: "Graph" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("clicking a different option updates internal state and fires onChange", () => {
    const onChange = vi.fn();
    render(
      <SegmentToggle<View>
        options={[...OPTIONS]}
        defaultValue="cards"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("table");
    expect(
      screen
        .getByRole("radio", { name: "Table" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("does not fire onChange when re-clicking the already-active option", () => {
    const onChange = vi.fn();
    render(
      <SegmentToggle<View>
        options={[...OPTIONS]}
        defaultValue="cards"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SegmentToggle — controlled mode", () => {
  function ControlledHarness({ onChange }: { onChange?: (v: View) => void }) {
    const [v, setV] = useState<View>("cards");
    return (
      <SegmentToggle<View>
        options={[...OPTIONS]}
        value={v}
        onChange={(next) => {
          setV(next);
          onChange?.(next);
        }}
      />
    );
  }

  it("reflects parent-driven value", () => {
    const { rerender } = render(
      <SegmentToggle<View> options={[...OPTIONS]} value="cards" />,
    );
    expect(
      screen
        .getByRole("radio", { name: "Cards" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    rerender(<SegmentToggle<View> options={[...OPTIONS]} value="graph" />);
    expect(
      screen
        .getByRole("radio", { name: "Graph" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("does not self-mutate when value is provided and no onChange is wired", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} value="cards" />);
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    // Value didn't change because the parent didn't update it.
    expect(
      screen
        .getByRole("radio", { name: "Cards" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("forwards clicks via onChange and updates after parent commits", () => {
    const spy = vi.fn();
    render(<ControlledHarness onChange={spy} />);
    fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
    expect(spy).toHaveBeenCalledWith("graph");
    expect(
      screen
        .getByRole("radio", { name: "Graph" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("SegmentToggle — keyboard contract", () => {
  it("ArrowRight cycles focus to the next option, wrapping at the end", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="cards" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Table" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Graph" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    // Wrap.
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Cards" }),
    );
  });

  it("ArrowLeft cycles focus to the previous option, wrapping at the start", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="cards" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowLeft" });
    // Wrap to last.
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Graph" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Table" }),
    );
  });

  it("ArrowUp/ArrowDown also move focus (vertical-toggle ergonomics)", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="cards" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Table" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Cards" }),
    );
  });

  it("Home jumps to the first option and End jumps to the last", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="table" />);
    const table = screen.getByRole("radio", { name: "Table" });
    table.focus();
    fireEvent.keyDown(table, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Graph" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Cards" }),
    );
  });

  it("arrow keys MOVE FOCUS without committing selection (uncontrolled)", () => {
    const onChange = vi.fn();
    render(
      <SegmentToggle<View>
        options={[...OPTIONS]}
        defaultValue="cards"
        onChange={onChange}
      />,
    );
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    // Selection still cards.
    expect(
      screen
        .getByRole("radio", { name: "Cards" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("Enter activates the focused option", () => {
    const onChange = vi.fn();
    render(
      <SegmentToggle<View>
        options={[...OPTIONS]}
        defaultValue="cards"
        onChange={onChange}
      />,
    );
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("table");
    expect(
      screen
        .getByRole("radio", { name: "Table" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("Space activates the focused option", () => {
    const onChange = vi.fn();
    render(
      <SegmentToggle<View>
        options={[...OPTIONS]}
        defaultValue="cards"
        onChange={onChange}
      />,
    );
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(onChange).toHaveBeenCalledWith("graph");
  });

  it("ignores unrelated keys (does not preventDefault, does not move focus)", () => {
    render(<SegmentToggle<View> options={[...OPTIONS]} defaultValue="cards" />);
    const cards = screen.getByRole("radio", { name: "Cards" });
    cards.focus();
    fireEvent.keyDown(cards, { key: "a" });
    expect(document.activeElement).toBe(cards);
  });
});
