import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentChip } from "@/components/AttachmentChip";

describe("AttachmentChip", () => {
  it("renders filename and size in KB when ready", () => {
    render(
      <AttachmentChip
        file={{
          id: "p-1",
          filename: "hello.png",
          sizeBytes: 2048,
          status: "ready",
        }}
        onRemove={() => {}}
      />
    );
    expect(screen.getByText("hello.png")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe(
      "ready"
    );
  });

  it("shows ellipsis placeholder while uploading", () => {
    render(
      <AttachmentChip
        file={{
          id: "p-1",
          filename: "hello.png",
          sizeBytes: 2048,
          status: "uploading",
        }}
        onRemove={() => {}}
      />
    );
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("uses error title when status=error", () => {
    render(
      <AttachmentChip
        file={{
          id: "p-1",
          filename: "bad.png",
          sizeBytes: 1024,
          status: "error",
          errorMessage: "File too big",
        }}
        onRemove={() => {}}
      />
    );
    const chip = screen.getByTestId("attachment-chip");
    expect(chip.getAttribute("title")).toBe("File too big");
    expect(chip.getAttribute("data-status")).toBe("error");
  });

  it("calls onRemove with the file id when the X is clicked", async () => {
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
      />
    );
    await user.click(screen.getByRole("button", { name: /Remove x\.png/ }));
    expect(onRemove).toHaveBeenCalledWith("p-42");
  });

  it("clamps zero-byte size to 1 KB (display only)", () => {
    render(
      <AttachmentChip
        file={{
          id: "p-1",
          filename: "blank",
          sizeBytes: 0,
          status: "ready",
        }}
        onRemove={() => {}}
      />
    );
    expect(screen.getByText("1 KB")).toBeTruthy();
  });
});
