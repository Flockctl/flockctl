import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentQuestionPrompt } from "@/components/AgentQuestionPrompt";

/**
 * Picker-variant unit coverage for AgentQuestionPrompt.
 *
 * The component supports three render modes:
 *   - free-form textarea (no `options`)
 *   - radio picker + Other textarea (`options` provided, `multiSelect=false`)
 *   - checkbox picker + Other textarea (`options` provided, `multiSelect=true`)
 *
 * These tests exercise each mode through the public surface (DOM + onAnswer
 * callback) — no implementation details, no snapshots.
 */
describe("AgentQuestionPrompt picker variants", () => {
  function getRadios() {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    );
  }
  function getCheckboxes() {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
  }
  function getTextareas() {
    return Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea"));
  }

  it("textarea_when_no_options: renders only a textarea, no radio/checkbox; submits typed value", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt
        question="What is your favourite colour?"
        requestId="r1"
        onAnswer={onAnswer}
      />
    );

    expect(getTextareas()).toHaveLength(1);
    expect(getRadios()).toHaveLength(0);
    expect(getCheckboxes()).toHaveLength(0);

    await user.type(screen.getByTestId("agent-question-textarea"), "hello");
    await user.click(screen.getByTestId("agent-question-send"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("hello");
  });

  it("radios_when_options_and_multi_select_false: renders 3 radios + descriptions, no checkboxes", () => {
    render(
      <AgentQuestionPrompt
        question="Pick"
        requestId="r-radio"
        options={[
          { label: "red", description: "warm" },
          { label: "blue", description: "cool" },
          { label: "green" },
        ]}
        onAnswer={async () => {}}
      />
    );

    expect(getRadios()).toHaveLength(3);
    expect(getCheckboxes()).toHaveLength(0);

    // Each label is rendered.
    expect(screen.getByText("red")).toBeInTheDocument();
    expect(screen.getByText("blue")).toBeInTheDocument();
    expect(screen.getByText("green")).toBeInTheDocument();

    // Descriptions where present are rendered.
    expect(screen.getByText("warm")).toBeInTheDocument();
    expect(screen.getByText("cool")).toBeInTheDocument();

    // The third option had no description — the string shouldn't leak in.
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
  });

  it("checkboxes_when_multi_select_true: renders 3 checkboxes; submits comma-joined labels in original order", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt
        question="Pick any"
        requestId="r-multi"
        multiSelect
        options={[
          { label: "alpha" },
          { label: "beta" },
          { label: "gamma" },
        ]}
        onAnswer={onAnswer}
      />
    );

    expect(getCheckboxes()).toHaveLength(3);
    expect(getRadios()).toHaveLength(0);

    // Click in reverse order to prove the submit value uses original options
    // order (alpha, gamma) not click order (gamma, alpha).
    await user.click(screen.getByTestId("agent-question-option-2"));
    await user.click(screen.getByTestId("agent-question-option-0"));
    await user.click(screen.getByTestId("agent-question-send"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("alpha, gamma");
  });

  it("disables_Send_until_selection_or_other_text: toggles enable/disable state correctly", async () => {
    const user = userEvent.setup();
    render(
      <AgentQuestionPrompt
        question="Pick any"
        requestId="r-toggle"
        multiSelect
        options={[
          { label: "a" },
          { label: "b" },
          { label: "c" },
        ]}
        onAnswer={async () => {}}
      />
    );
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;

    // Initial: nothing selected, no Other text.
    expect(send.disabled).toBe(true);

    // Check a box → enabled.
    await user.click(screen.getByTestId("agent-question-option-1"));
    expect(send.disabled).toBe(false);

    // Uncheck the same box → disabled again.
    await user.click(screen.getByTestId("agent-question-option-1"));
    expect(send.disabled).toBe(true);

    // Type into Other → enabled (Other escape hatch overrides empty selection).
    await user.type(screen.getByTestId("agent-question-textarea"), "x");
    expect(send.disabled).toBe(false);
  });

  it("submits_chosen_label_for_radio_mode: clicking 'blue' then Send sends 'blue'", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt
        question="Pick"
        requestId="r-radio-submit"
        options={[
          { label: "red" },
          { label: "blue" },
          { label: "green" },
        ]}
        onAnswer={onAnswer}
      />
    );

    await user.click(screen.getByTestId("agent-question-option-1"));
    await user.click(screen.getByTestId("agent-question-send"));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("blue");
  });

  it("submits_comma_joined_labels_for_checkbox_mode: 'a' and 'c' → 'a, c'", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt
        question="Pick any"
        requestId="r-multi-submit"
        multiSelect
        options={[
          { label: "a" },
          { label: "b" },
          { label: "c" },
        ]}
        onAnswer={onAnswer}
      />
    );

    await user.click(screen.getByTestId("agent-question-option-0"));
    await user.click(screen.getByTestId("agent-question-option-2"));
    await user.click(screen.getByTestId("agent-question-send"));

    // Implementation uses ", " (comma + space) — see AgentQuestionPrompt.tsx
    // submitValue branch. This test locks that format.
    expect(onAnswer).toHaveBeenCalledWith("a, c");
  });

  it("submits_other_textarea_when_other_filled: Other escape hatch wins over picker", async () => {
    // Case A: no radio selected, only Other typed → Other is what's submitted.
    const user = userEvent.setup();
    const onAnswerA = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <AgentQuestionPrompt
        question="Pick"
        requestId="r-other-1"
        options={[{ label: "red" }, { label: "blue" }]}
        onAnswer={onAnswerA}
      />
    );
    await user.type(
      screen.getByTestId("agent-question-textarea"),
      "freeform"
    );
    await user.click(screen.getByTestId("agent-question-send"));
    expect(onAnswerA).toHaveBeenCalledTimes(1);
    expect(onAnswerA).toHaveBeenLastCalledWith("freeform");

    // Mount a fresh instance for case B — the post-submit state of case A's
    // component keeps `pending=true` forever (parent is expected to unmount),
    // so reusing it would leave the picker disabled.
    unmount();

    // Case B: radio selected AND Other filled — Other wins.
    const onAnswerB = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentQuestionPrompt
        question="Pick"
        requestId="r-other-2"
        options={[{ label: "red" }, { label: "blue" }]}
        onAnswer={onAnswerB}
      />
    );
    await user.click(screen.getByTestId("agent-question-option-0"));
    await user.type(
      screen.getByTestId("agent-question-textarea"),
      "override"
    );
    await user.click(screen.getByTestId("agent-question-send"));
    expect(onAnswerB).toHaveBeenCalledTimes(1);
    expect(onAnswerB).toHaveBeenLastCalledWith("override");
  });

  it("renders_header_chip_when_header_present: chip with header text appears, otherwise hidden", () => {
    const { rerender } = render(
      <AgentQuestionPrompt
        question="q"
        requestId="r-header-1"
        header="Pick one"
        onAnswer={async () => {}}
      />
    );

    const chip = screen.getByTestId("agent-question-header");
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe("Pick one");

    rerender(
      <AgentQuestionPrompt
        question="q"
        requestId="r-header-2"
        onAnswer={async () => {}}
      />
    );
    expect(screen.queryByTestId("agent-question-header")).not.toBeInTheDocument();
  });

  it("handles_options_with_empty_label_array_gracefully: empty options falls back to textarea mode", () => {
    render(
      <AgentQuestionPrompt
        question="q"
        requestId="r-empty"
        options={[]}
        onAnswer={async () => {}}
      />
    );

    // Falls back to single textarea, no picker rendered at all.
    expect(getTextareas()).toHaveLength(1);
    expect(getRadios()).toHaveLength(0);
    expect(getCheckboxes()).toHaveLength(0);
    expect(screen.queryByTestId("agent-question-options")).not.toBeInTheDocument();
  });

  it("does_not_submit_when_only_whitespace_in_other: whitespace-only Other keeps Send disabled", async () => {
    const user = userEvent.setup();
    render(
      <AgentQuestionPrompt
        question="Pick"
        requestId="r-whitespace"
        options={[{ label: "x" }, { label: "y" }]}
        onAnswer={async () => {}}
      />
    );
    const send = screen.getByTestId("agent-question-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await user.type(screen.getByTestId("agent-question-textarea"), "   ");
    expect(send.disabled).toBe(true);

    // Sanity: no radio was clicked, and the Other content is whitespace only,
    // so submitValue must remain null.
    const card = screen.getByTestId("agent-question-prompt");
    expect(within(card).queryAllByRole("alert")).toHaveLength(0);
  });
});
