import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentQuestionPrompt } from "@/components/AgentQuestionPrompt";

/**
 * Slice 03 (24-ui-redesign-working-surfaces / 03-chat-conversation /
 * 03-attachment-and-question) shape contract for the prompt:
 *
 *   - amber-tinted FlatCard wrapper (border-amber-* + amber background)
 *   - question text + single-line input + Submit button
 *   - plain Enter on the input submits; existing Cmd/Ctrl+Enter still works
 *
 * These tests pin the visual + keyboard contract for the chat surface
 * restyle; the broader free-form vs. picker behaviour is covered in
 * `agent-question-prompt.test.tsx`.
 */
describe("AgentQuestionPrompt — chat surface restyle", () => {
  it("wraps the prompt in an amber-tinted FlatCard", () => {
    const { container } = render(
      <AgentQuestionPrompt
        question="Which directory?"
        requestId="req-1"
        onAnswer={async () => {}}
      />,
    );
    // FlatCard root is the outermost div the component renders; it carries
    // the amber border + amber background classes the slice spec calls for.
    const root = container.firstElementChild as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root!.className).toContain("border-amber-500");
    expect(root!.className).toMatch(/bg-amber-50|bg-amber-950/);
    // FlatCard also brings the rounded-xl + border + bg-card structure from
    // its base contract.
    expect(root!.className).toContain("rounded-xl");
  });

  it("renders question text + a single-line input + a Submit button", () => {
    render(
      <AgentQuestionPrompt
        question="Which directory should I use?"
        requestId="r-1"
        onAnswer={async () => {}}
      />,
    );
    expect(screen.getByTestId("agent-question-text").textContent).toBe(
      "Which directory should I use?",
    );

    // The free-form control is now a single-line `<input>`, not a textarea —
    // the slice contract is "input + Submit" with plain Enter submitting.
    const input = screen.getByTestId("agent-question-textarea");
    expect(input.tagName).toBe("INPUT");

    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.textContent).toContain("Submit");
  });

  it("Submit stays disabled while the input is empty", () => {
    render(
      <AgentQuestionPrompt
        question="q"
        requestId="r"
        onAnswer={async () => {}}
      />,
    );
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("submits the trimmed answer when plain Enter is pressed inside the input", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />,
    );
    const input = screen.getByTestId("agent-question-textarea");
    await user.type(input, "  yes  ");
    // Plain Enter — single-line Input contract; should submit, not insert
    // a newline.
    await user.keyboard("{Enter}");
    expect(onAnswer).toHaveBeenCalledWith("yes");
  });

  it("still submits via Cmd/Ctrl+Enter (back-compat with existing keybinding)", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />,
    );
    const input = screen.getByTestId("agent-question-textarea");
    await user.type(input, "ok");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onAnswer).toHaveBeenCalledWith("ok");
  });

  it("clicking Submit invokes onAnswer with the typed value", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />,
    );
    await user.type(screen.getByTestId("agent-question-textarea"), "answered");
    await user.click(screen.getByTestId("agent-question-send"));
    expect(onAnswer).toHaveBeenCalledWith("answered");
  });

  it("re-enables Submit when the answer promise rejects", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockRejectedValue(new Error("network down"));
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />,
    );
    await user.type(screen.getByTestId("agent-question-textarea"), "x");
    await user.click(screen.getByTestId("agent-question-send"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("network down");
    });
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });
});
