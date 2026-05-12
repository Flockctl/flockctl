import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentChip } from "@/components/AttachmentChip";

/**
 * Slice 03 (24-ui-redesign-working-surfaces / 03-chat-conversation /
 * 03-attachment-and-question) shape contract for the chip:
 *
 *   - rounded-md border container
 *   - leading type-icon (image / pdf / code / file fallback)
 *   - filename label
 *   - optional remove button (rendered only when `onRemove` is wired)
 *
 * These tests pin the visual contract; a separate `attachment-chip.test.tsx`
 * file already covers the size/uploading/error wiring.
 */
describe("AttachmentChip — chat surface restyle", () => {
  it("renders rounded-md border + filename + type-icon + remove button when wired", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentChip
        file={{
          id: "p-1",
          filename: "diagram.png",
          sizeBytes: 4096,
          status: "ready",
        }}
        onRemove={onRemove}
      />,
    );

    const chip = screen.getByTestId("attachment-chip");
    expect(chip.className).toContain("rounded-md");
    expect(chip.className).toContain("border");
    expect(screen.getByText("diagram.png")).toBeTruthy();
    expect(screen.getByTestId("attachment-chip-icon")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove diagram\.png/ })).toBeTruthy();
  });

  it("hides the remove button when onRemove is omitted (read-only chip)", () => {
    render(
      <AttachmentChip
        file={{
          id: "p-2",
          filename: "spec.pdf",
          sizeBytes: 8192,
          status: "ready",
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: /Remove spec\.pdf/ })).toBeNull();
    // Filename + type-icon still render, since those don't depend on
    // interactivity.
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    expect(screen.getByTestId("attachment-chip-icon")).toBeTruthy();
  });

  it("invokes onRemove with the file id when the X is clicked", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <AttachmentChip
        file={{
          id: "p-42",
          filename: "x.png",
          sizeBytes: 512,
          status: "ready",
        }}
        onRemove={onRemove}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Remove x\.png/ }));
    expect(onRemove).toHaveBeenCalledWith("p-42");
  });

  it("picks distinct icons for image vs pdf vs code vs unknown extensions", () => {
    // Same chip wrapper for all four — what changes is the inner SVG, which
    // we capture via the icon element's class signature (lucide adds a
    // unique class per icon, e.g. `lucide-image`).
    const cases: Array<[string, string]> = [
      ["photo.png", "lucide-image"],
      ["paper.pdf", "lucide-file-text"],
      ["module.ts", "lucide-file-code"],
      ["secret", "lucide-file"],
    ];
    for (const [filename, expectedIconClass] of cases) {
      const { unmount } = render(
        <AttachmentChip
          file={{ id: filename, filename, sizeBytes: 1024, status: "ready" }}
          onRemove={() => {}}
        />,
      );
      const icon = screen.getByTestId("attachment-chip-icon");
      // Lucide icons render as SVG elements, whose `className` is an
      // `SVGAnimatedString` (not a plain string) — read the raw `class`
      // attribute instead.
      const cls = icon.getAttribute("class") ?? "";
      expect(cls.includes(expectedIconClass)).toBe(true);
      unmount();
    }
  });

  it("does not break when 10 chips are stacked horizontally (wrap-friendly)", () => {
    // The chip itself uses `inline-flex` so it'll cooperate with a parent
    // `flex-wrap`. Smoke-test that 10 of them mount without error and each
    // exposes the same testid (negative test from the slice spec).
    render(
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 10 }, (_, i) => (
          <AttachmentChip
            key={i}
            file={{
              id: `p-${i}`,
              filename: `file-${i}.png`,
              sizeBytes: 1024,
              status: "ready",
            }}
            onRemove={() => {}}
          />
        ))}
      </div>,
    );
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(10);
  });
});
