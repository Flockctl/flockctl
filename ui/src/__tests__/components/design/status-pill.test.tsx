import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusPill } from "@/components/design/StatusPill";

describe("StatusPill", () => {
  it("renders children", () => {
    const { getByText } = render(<StatusPill tone="success">Done</StatusPill>);
    expect(getByText("Done")).toBeInTheDocument();
  });

  it.each([
    ["success", "bg-emerald-500/15", "text-emerald-600"],
    ["warning", "bg-amber-500/15", "text-amber-600"],
    ["danger", "bg-red-500/15", "text-red-600"],
    ["info", "bg-indigo-500/15", "text-indigo-600"],
    ["neutral", "bg-zinc-500/15", "text-zinc-600"],
  ] as const)(
    "applies tone=%s classes",
    (tone, bgClass, textClass) => {
      const { getByText } = render(
        <StatusPill tone={tone}>{tone}</StatusPill>,
      );
      const el = getByText(tone);
      expect(el.className).toContain(bgClass);
      expect(el.className).toContain(textClass);
      expect(el.dataset.tone).toBe(tone);
    },
  );

  it("defaults to md size (text-[11px])", () => {
    const { getByText } = render(<StatusPill tone="info">A</StatusPill>);
    const el = getByText("A");
    expect(el.className).toContain("text-[11px]");
    expect(el.className).not.toContain("text-[10px]");
    expect(el.dataset.size).toBe("md");
  });

  it("applies sm size (text-[10px])", () => {
    const { getByText } = render(
      <StatusPill tone="info" size="sm">
        B
      </StatusPill>,
    );
    const el = getByText("B");
    expect(el.className).toContain("text-[10px]");
    expect(el.className).not.toContain("text-[11px]");
    expect(el.dataset.size).toBe("sm");
  });

  it("applies wrapper utility classes", () => {
    const { getByText } = render(<StatusPill tone="neutral">x</StatusPill>);
    const el = getByText("x");
    for (const cls of [
      "rounded",
      "px-1.5",
      "py-0.5",
      "uppercase",
      "tracking-wider",
      "font-semibold",
    ]) {
      expect(el.className).toContain(cls);
    }
  });

  it("merges caller className without dropping defaults", () => {
    const { getByText } = render(
      <StatusPill tone="success" className="ml-2">
        merge
      </StatusPill>,
    );
    const el = getByText("merge");
    expect(el.className).toContain("ml-2");
    expect(el.className).toContain("rounded");
    expect(el.className).toContain("uppercase");
  });

  it("forwards extra HTML attributes (aria-label, title, role)", () => {
    const { getByLabelText } = render(
      <StatusPill tone="warning" aria-label="status" title="hint" role="status">
        W
      </StatusPill>,
    );
    const el = getByLabelText("status");
    expect(el.getAttribute("title")).toBe("hint");
    expect(el.getAttribute("role")).toBe("status");
  });
});
