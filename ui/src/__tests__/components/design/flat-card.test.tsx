import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FlatCard } from "@/components/design/FlatCard";

describe("FlatCard", () => {
  it("renders children inside a flat surface wrapper", () => {
    const { container } = render(
      <FlatCard>
        <div>hello</div>
      </FlatCard>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
    const root = container.firstElementChild as HTMLElement;
    const cls = root.className;
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("border");
    expect(cls).toContain("divider-y");
    expect(cls).toContain("bg-card");
  });

  it("is non-interactive by default (no role, no tabindex, no hover class)", () => {
    const { container } = render(
      <FlatCard>
        <span>content</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("role")).toBeNull();
    expect(root.getAttribute("tabindex")).toBeNull();
    expect(root.className).not.toContain("card-hover");
    expect(root.className).not.toContain("cursor-pointer");
  });

  it("interactive=true adds role=button, tabindex=0, card-hover, cursor-pointer", () => {
    const { container } = render(
      <FlatCard interactive onClick={() => {}}>
        <span>x</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("role")).toBe("button");
    expect(root.getAttribute("tabindex")).toBe("0");
    expect(root.className).toContain("card-hover");
    expect(root.className).toContain("cursor-pointer");
  });

  it("calls onClick when an interactive card is clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <FlatCard interactive onClick={onClick}>
        <span>click me</span>
      </FlatCard>,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does NOT wire onClick when interactive=false", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <FlatCard onClick={onClick}>
        <span>passive</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    await user.click(root);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("activates onClick on Enter and Space when interactive", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <FlatCard interactive onClick={onClick}>
        <span>kb</span>
      </FlatCard>,
    );
    const root = screen.getByRole("button");
    root.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not activate on Enter/Space when not interactive", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <FlatCard onClick={onClick}>
        <span>passive</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    // Non-interactive cards don't get tabindex; force-focus so we can
    // dispatch a keyboard event from the element itself.
    root.tabIndex = -1;
    root.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders an optional footer separated by a top divider", () => {
    const { container } = render(
      <FlatCard footer={<span>footer-text</span>}>
        <span>body-text</span>
      </FlatCard>,
    );
    expect(screen.getByText("body-text")).toBeTruthy();
    const footer = screen.getByText("footer-text").parentElement as HTMLElement;
    expect(footer.className).toContain("border-t");
    expect(footer.className).toContain("divider-y");
    // Footer is a sibling rendered AFTER children inside the wrapper.
    const root = container.firstElementChild as HTMLElement;
    expect(root.lastElementChild).toBe(footer);
  });

  it("omits the footer wrapper entirely when no footer prop is given", () => {
    const { container } = render(
      <FlatCard>
        <span>only body</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    // Only the body child renders — no footer container is added.
    expect(root.childElementCount).toBe(1);
    // Confirm there's no border-t divider hanging around.
    expect(root.querySelector(".border-t.divider-y")).toBeNull();
  });

  it("merges a custom className onto the wrapper", () => {
    const { container } = render(
      <FlatCard className="custom-x">
        <span>c</span>
      </FlatCard>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("custom-x");
    // Base classes still present.
    expect(root.className).toContain("rounded-xl");
  });

  describe("dev-warning when interactive without onClick", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("warns when interactive=true and onClick is missing", () => {
      render(
        <FlatCard interactive>
          <span>x</span>
        </FlatCard>,
      );
      expect(warn).toHaveBeenCalled();
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("FlatCard");
    });

    it("does not warn when interactive=true and onClick is provided", () => {
      render(
        <FlatCard interactive onClick={() => {}}>
          <span>x</span>
        </FlatCard>,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when interactive is omitted", () => {
      render(
        <FlatCard>
          <span>x</span>
        </FlatCard>,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
