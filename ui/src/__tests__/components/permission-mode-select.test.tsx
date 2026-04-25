import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PermissionModeSelect,
  PERMISSION_MODE_OPTIONS,
  INHERIT_VALUE,
} from "@/components/permission-mode-select";

// Radix Select calls hasPointerCapture / setPointerCapture / scrollIntoView
// on the trigger — jsdom doesn't implement them, so stub before any render.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as any;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
});

describe("PermissionModeSelect", () => {
  it("exposes a stable options list", () => {
    const values = PERMISSION_MODE_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      "auto",
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(INHERIT_VALUE).toBe("__inherit__");
  });

  it("shows the label of the current mode in the trigger", () => {
    render(<PermissionModeSelect value="plan" onChange={() => {}} />);
    expect(screen.getByText("Plan only")).toBeTruthy();
  });

  it("shows 'Inherit' when value is null", () => {
    render(<PermissionModeSelect value={null} onChange={() => {}} />);
    expect(screen.getByText("Inherit")).toBeTruthy();
  });

  it("emits onChange(null) when user picks 'Inherit'", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PermissionModeSelect value="plan" onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    const inheritItems = await screen.findAllByText("Inherit");
    await user.click(inheritItems[inheritItems.length - 1]!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("emits onChange with the picked mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PermissionModeSelect value={null} onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    const planItems = await screen.findAllByText("Plan only");
    await user.click(planItems[planItems.length - 1]!);
    expect(onChange).toHaveBeenCalledWith("plan");
  });

  it("does not render the inherit option when allowInherit is false", async () => {
    const user = userEvent.setup();
    render(
      <PermissionModeSelect value="auto" onChange={() => {}} allowInherit={false} />
    );
    await user.click(screen.getByRole("combobox"));
    // The trigger shows 'Auto' (label for current value); there is no
    // "Inherit" entry in the content.
    expect(screen.queryByText("Inherit")).toBeNull();
  });

  it("respects disabled", () => {
    render(<PermissionModeSelect value="auto" onChange={() => {}} disabled />);
    const trigger = screen.getByRole("combobox") as HTMLButtonElement;
    expect(trigger.getAttribute("data-disabled")).not.toBeNull();
  });
});
