import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentQuestionPrompt } from "@/components/AgentQuestionPrompt";

describe("AgentQuestionPrompt", () => {
  it("renders the question text", () => {
    render(
      <AgentQuestionPrompt
        question="Which directory should I use?"
        requestId="req-1"
        onAnswer={async () => {}}
      />
    );
    expect(screen.getByTestId("agent-question-text").textContent).toBe(
      "Which directory should I use?"
    );
  });

  it("keeps Send disabled while the textarea is empty", () => {
    render(
      <AgentQuestionPrompt
        question="q"
        requestId="r"
        onAnswer={async () => {}}
      />
    );
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("enables Send once text is entered and submits trimmed value", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />
    );
    await user.type(screen.getByTestId("agent-question-textarea"), "  yes  ");
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await user.click(send);
    expect(onAnswer).toHaveBeenCalledWith("yes");
  });

  it("submits via Cmd/Ctrl+Enter shortcut", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />
    );
    const textarea = screen.getByTestId("agent-question-textarea");
    await user.type(textarea, "go");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onAnswer).toHaveBeenCalledWith("go");
  });

  it("shows error on rejected submission and re-enables the button", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockRejectedValue(new Error("network down"));
    render(
      <AgentQuestionPrompt question="q" requestId="r" onAnswer={onAnswer} />
    );
    await user.type(screen.getByTestId("agent-question-textarea"), "x");
    await user.click(screen.getByTestId("agent-question-send"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("network down");
    });
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it("clears the draft when requestId rotates", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentQuestionPrompt
        question="q1"
        requestId="r1"
        onAnswer={async () => {}}
      />
    );
    const textarea = screen.getByTestId(
      "agent-question-textarea"
    ) as HTMLTextAreaElement;
    await user.type(textarea, "draft");
    expect(textarea.value).toBe("draft");

    rerender(
      <AgentQuestionPrompt
        question="q2"
        requestId="r2"
        onAnswer={async () => {}}
      />
    );
    expect(
      (screen.getByTestId("agent-question-textarea") as HTMLTextAreaElement).value
    ).toBe("");
  });
});
