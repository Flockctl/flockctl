import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiscardConfirm } from "@/components/git/DiscardConfirm";

/**
 * Unit tests for {@link DiscardConfirm}.
 *
 * The dialog wraps the existing {@link ConfirmDialog} primitive, so the
 * tests below focus on the bits DiscardConfirm owns: the path block, the
 * "cannot be undone" line, and the conditional dirty-tab warning. Button
 * mechanics (cancel / disabled-while-pending / confirm-fires-once) live
 * in the ConfirmDialog spec already and are not duplicated here.
 */

describe("DiscardConfirm", () => {
  it("renders the path inside a monospace block", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="src/auth.ts"
        onConfirm={() => {}}
      />,
    );
    const pathEl = screen.getByTestId("discard-confirm-path");
    expect(pathEl.textContent).toBe("src/auth.ts");
    // The block uses font-mono; we check the class lands on the element so
    // a future refactor that switches to a default-font label is caught.
    expect(pathEl.className).toMatch(/font-mono/);
  });

  it("always shows the 'cannot be undone' reminder", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="x"
        onConfirm={() => {}}
      />,
    );
    expect(
      screen.getByTestId("discard-confirm-undo-warning").textContent,
    ).toMatch(/cannot be undone/i);
  });

  it("does NOT render the dirty-tab warning by default", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="src/auth.ts"
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByTestId("discard-confirm-warning")).toBeNull();
  });

  it("prepends the dirty-tab warning when dirtyTab=true", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="src/auth.ts"
        dirtyTab
        onConfirm={() => {}}
      />,
    );
    const warning = screen.getByTestId("discard-confirm-warning");
    expect(warning).toBeTruthy();
    // The warning must mention unsaved changes — copy is the user-visible
    // signal that explains why the path is risky to discard.
    expect(warning.textContent).toMatch(/unsaved changes/i);

    // Order check: warning sits BEFORE the path in DOM order so a screen
    // reader hits the heads-up before the path it applies to.
    const path = screen.getByTestId("discard-confirm-path");
    const order = warning.compareDocumentPosition(path);
    // DOCUMENT_POSITION_FOLLOWING = 4 — `path` follows `warning`.
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the Discard / Cancel buttons (default destructive variant)", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="x"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("disables the Discard button and switches its label while isPending", () => {
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="x"
        isPending
        onConfirm={() => {}}
      />,
    );
    const btn = screen.getByRole("button", {
      name: "Discard...",
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("invokes onConfirm exactly once when Discard is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <DiscardConfirm
        open
        onOpenChange={() => {}}
        path="x"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when open=false", () => {
    render(
      <DiscardConfirm
        open={false}
        onOpenChange={() => {}}
        path="x"
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByTestId("discard-confirm")).toBeNull();
  });
});
