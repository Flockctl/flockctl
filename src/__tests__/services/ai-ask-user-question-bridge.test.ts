import { describe, it, expect, vi } from "vitest";

import {
  ASK_USER_QUESTION_BRIDGE_DESCRIPTION,
  ASK_USER_QUESTION_BUILTIN_NAME,
  FLOCKCTL_HOST_MCP_SERVER_NAME,
  askUserQuestionBridgeRawShape,
  createAskUserQuestionBridgeHandler,
  type AwaitUserAnswerHandler,
} from "../../services/ai/ask-user-question-bridge.js";

describe("ask-user-question-bridge — public constants", () => {
  it("exposes a stable MCP-server name for disallowedTools / SDK plumbing", () => {
    // Several places in ai/client.ts and the test suite reference this by
    // string literal — the constant exists so accidental rename gets caught
    // by typecheck rather than silently breaking the bridge.
    expect(FLOCKCTL_HOST_MCP_SERVER_NAME).toBe("flockctl_host");
  });

  it("uses 'AskUserQuestion' as the override tool name (matches built-in)", () => {
    // The tool MUST share the name the SDK's built-in uses, so combined with
    // disallowedTools the model sees only our override under the same
    // semantic identity (description + purpose).
    expect(ASK_USER_QUESTION_BUILTIN_NAME).toBe("AskUserQuestion");
  });

  it("ships a description that says it asks an open-ended question", () => {
    // Keeps regressions visible if the wording drifts — model picks the
    // tool from the inventory partly via this string.
    expect(ASK_USER_QUESTION_BRIDGE_DESCRIPTION).toMatch(/clarification question/i);
  });

  it("rawShape requires a non-empty 'questions' array (matches harness shape)", () => {
    // The SDK rejects empty rawShapes; this also documents the wire format
    // the model emits — `{ questions: [{ question, ...}] }`. Free-form
    // (no `options`) MUST still validate.
    const Shape = askUserQuestionBridgeRawShape.questions;
    expect(() => Shape.parse([])).toThrow();
    expect(() =>
      Shape.parse([{ question: "Why?", header: "Reason" }]),
    ).not.toThrow(); // free-form
    expect(() =>
      Shape.parse([
        {
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    ).not.toThrow(); // multiple-choice
  });
});

describe("ask-user-question-bridge — handler", () => {
  it("forwards a valid harness-shape payload to awaitUserAnswer and surfaces the answer text", async () => {
    const awaitUserAnswer = vi.fn<AwaitUserAnswerHandler>(async () => "the answer");
    const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

    const result = await handler(
      {
        questions: [
          {
            question: "Which library should we use?",
            header: "Library",
            options: [
              { label: "luxon", description: "Modern" },
              { label: "dayjs", description: "Tiny" },
            ],
          },
        ],
      },
      { toolUseId: "toolu_abc" },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "the answer" }],
    });
    // The bridge collapses `questions: [...]` to a singular question (Flockctl's
    // M05 contract). awaitUserAnswer must see exactly one parsed question.
    expect(awaitUserAnswer).toHaveBeenCalledTimes(1);
    const [parsed, toolUseId] = awaitUserAnswer.mock.calls[0]!;
    expect(parsed.question).toBe("Which library should we use?");
    expect(parsed.header).toBe("Library");
    expect(parsed.options).toHaveLength(2);
    expect(toolUseId).toBe("toolu_abc");
  });

  it("returns an Error: tool_result on validation failure (no exception, no awaitUserAnswer call)", async () => {
    // The agent must keep running on malformed input — surfacing a normal-
    // looking tool_result that says "Error: …" matches the convention used
    // by `executeToolCall` for other invalid inputs and prevents an SDK-
    // level exception from unwinding the agentic loop.
    const awaitUserAnswer = vi.fn<AwaitUserAnswerHandler>(async () => "should-not-be-called");
    const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

    const result = (await handler(
      {
        // empty `question` violates `min(1)` — strict-validate rejects.
        questions: [{ question: "", header: "X" }],
      },
      {},
    )) as { content: Array<{ type: "text"; text: string }> };

    expect(awaitUserAnswer).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toMatch(/^Error: invalid AskUserQuestion input/);
  });

  it("falls back to an empty toolUseId string when the SDK extra omits it", async () => {
    // The SDK's `extra` parameter shape isn't formally typed by us; we
    // tolerate undefined/missing toolUseId gracefully because awaitUserAnswer
    // generates its own requestId — toolUseId is only used for attribution.
    const awaitUserAnswer = vi.fn<AwaitUserAnswerHandler>(async () => "ok");
    const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

    await handler(
      { questions: [{ question: "Q?" }] },
      undefined as unknown as Record<string, unknown>,
    );

    const [, toolUseId] = awaitUserAnswer.mock.calls[0]!;
    expect(toolUseId).toBe("");
  });

  it("formats a root-level validation error with the (root) sentinel when path is empty", async () => {
    // The error mapper falls back to `(root)` when a Zod issue's `path` is
    // an empty array — typical for non-object root inputs (e.g. when the
    // SDK hands us `null` or a primitive instead of `{ questions: [...] }`).
    // Without this branch the error string would interpolate to ": ..."
    // which is harder to grep in logs.
    const awaitUserAnswer = vi.fn<AwaitUserAnswerHandler>(async () => "should-not-be-called");
    const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

    const result = (await handler(
      // SDK could also strip top-level `questions` key entirely if a future
      // schema change drops the wrapper — exercise that path too. The Zod
      // schema in `agent-tools.ts` will reject this with a `(root)`-pathed
      // issue.
      null as unknown as { questions: Array<Record<string, unknown>> },
      {},
    )) as { content: Array<{ type: "text"; text: string }> };

    expect(awaitUserAnswer).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toMatch(/Error: invalid AskUserQuestion input — \(root\):/);
  });

  it("propagates the awaitUserAnswer rejection so the SDK records a tool failure", async () => {
    // If the user cancels the task while a question is pending, awaitUserAnswer
    // rejects (or resolves with a cancel sentinel — see session.ts:687). The
    // bridge must not swallow rejections; the SDK surfaces them as tool-use
    // failures, which the agentic loop then handles via standard abort flow.
    const awaitUserAnswer = vi.fn<AwaitUserAnswerHandler>(async () => {
      throw new Error("aborted");
    });
    const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

    await expect(
      handler({ questions: [{ question: "Q?" }] }, {}),
    ).rejects.toThrow("aborted");
  });
});
