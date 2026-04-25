import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "@/components/confirm-dialog";

describe("ConfirmDialog", () => {
  it("renders title, description, and default labels when open", () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="Delete thing"
        description="This cannot be undone"
        onConfirm={() => {}}
      />
    );
    expect(screen.getByText("Delete thing")).toBeTruthy();
    expect(screen.getByText("This cannot be undone")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="x"
        description="y"
        onConfirm={() => {}}
      />
    );
    expect(screen.queryByText("x")).toBeNull();
  });

  it("calls onConfirm when confirm button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="t"
        description="d"
        onConfirm={onConfirm}
      />
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenChange(false) when cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="t"
        description="d"
        onConfirm={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables the confirm button and shows pending label while isPending", () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Remove"
        isPending
        onConfirm={() => {}}
      />
    );
    const btn = screen.getByRole("button", { name: "Remove..." }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("honors custom labels", () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Archive"
        cancelLabel="Back"
        onConfirm={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });
});
