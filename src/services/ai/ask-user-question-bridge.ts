// Bridge that wires Flockctl's `agent_questions` blocking flow into the
// Claude Agent SDK's tool-execution pipeline.
//
// Why this exists
// ───────────────
// The Claude Agent SDK ships its own built-in `AskUserQuestion` tool. In
// interactive mode, the `claude` CLI handles it via a TUI prompt; in headless
// mode (the mode Flockctl uses for tasks and chats), it auto-resolves with
// empty answers — the agent thinks it asked, never blocks, and the task ends
// without the user ever seeing the question. That is the bug behind
// "milestone: structured agent questions + inbox integration appears to work
// but doesn't". Verified repro: see task 432 logs.
//
// The fix is the same shape Claude Code itself uses for its TUI prompt:
// register an in-process tool that owns the handler, so the SDK routes
// invocations to us instead of stubbing them out. The SDK exposes this via
// `createSdkMcpServer` / `tool()`. The "MCP" in those names is a transport-
// flavor naming convention inside the SDK — there is no spawn, no socket,
// and no JSON-RPC over the wire. Everything runs in-process. Combined with
// `disallowedTools: ["AskUserQuestion"]`, the model only sees our override.
//
// Naming caveat: the SDK namespaces in-process tools as
// `mcp__<server>__<tool>`, so the model sees `mcp__flockctl_host__AskUserQuestion`
// in its tool list. The tool's description is identical to the upstream
// AskUserQuestion description, so the model invokes it for the same reasons
// it would have invoked the built-in.

import { z } from "zod";

import { parseAskUserQuestionInput, type ParsedAskUserQuestion } from "../agent-tools.js";

/**
 * Name of the in-process MCP server used to host the AskUserQuestion bridge.
 * Stable so test assertions and `disallowedTools` filtering can reference it.
 *
 * Note: SDK servers must use names matching `[a-zA-Z0-9_-]+`; the underscore
 * variant is intentional — `flockctl-host` would also work, but we prefer the
 * underscore to avoid confusion with the dashed namespace prefix `mcp__`.
 */
export const FLOCKCTL_HOST_MCP_SERVER_NAME = "flockctl_host";

/**
 * Names the bridge needs to suppress on the SDK's built-in tool inventory so
 * the model only sees our override. Exported so `ai/client.ts` can splice it
 * into `disallowedTools` and tests can assert the exact contract.
 */
export const ASK_USER_QUESTION_BUILTIN_NAME = "AskUserQuestion";

/**
 * Callback the AgentSession hands to the bridge: opens a pending question
 * via `pendingInteractive`, persists `agent_questions` row through the
 * `question_request` event listener, and resolves with the answer text once
 * the UI calls `resolveQuestion(requestId, answerText)`.
 *
 * Mirrors the private `awaitUserAnswer` in `agent-session/session.ts:672` —
 * the bridge is intentionally agnostic about how the answer is sourced; it
 * just awaits the promise and surfaces the result as the tool_result.
 */
export type AwaitUserAnswerHandler = (
  parsed: ParsedAskUserQuestion,
  toolUseId: string,
) => Promise<string>;

// Zod shape we expose to the SDK as the tool's input_schema. We mirror the
// upstream Claude Code harness shape (`questions: [...]`) because that is
// what the model is trained on — see `agent-tools.ts:34-40` for the full
// rationale on why Flockctl tolerates the array-wrapped form. The handler
// then runs `parseAskUserQuestionInput` for strict validation + collapse to
// Flockctl's "one question at a time" model.
//
// `options` is `min(0).max(20)` so free-form questions (no choices) still
// pass schema validation; the upstream harness requires `min(2).max(4)`,
// but Flockctl's M05 contract relaxes that.
const askUserQuestionOptionShape = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  preview: z.string().max(2000).optional(),
});

const askUserQuestionSingleShape = z.object({
  question: z.string().min(1).max(2000),
  header: z.string().max(40).optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(askUserQuestionOptionShape).max(20).optional(),
});

export const askUserQuestionBridgeRawShape = {
  questions: z.array(askUserQuestionSingleShape).min(1).max(4),
};

/**
 * Tool description shown to the model in its tool inventory. Kept terse and
 * matched to the upstream harness wording so the model invokes our bridge
 * for the same reasons it would have invoked the built-in.
 */
export const ASK_USER_QUESTION_BRIDGE_DESCRIPTION =
  "Ask the user an open-ended clarification question that cannot be answered by calling another tool. Use sparingly — only when progress is blocked on information only the user can provide.";

/**
 * Build the bridge's tool handler. Pure function over `awaitUserAnswer`, so
 * the handler can be unit-tested without spinning up the SDK.
 *
 * Behavior contract:
 *   1. Validate input via `parseAskUserQuestionInput` (the same parser used
 *      by the non-streaming AskUserQuestion path in `session.ts:606`). On
 *      validation failure, return an `Error: …` text content — the same
 *      convention `executeToolCall` uses for invalid tool inputs, so the
 *      agent sees a normal-looking tool_result it can recover from instead
 *      of an SDK-level exception that would unwind the agentic loop.
 *   2. On success, await `awaitUserAnswer` and surface the answer string as
 *      a single text content block. The SDK feeds this content back to the
 *      model as the tool_result for the originating `tool_use`.
 *   3. The `extra` argument from the SDK carries metadata (request id,
 *      session id, etc.). We pull `toolUseId` from it when present so the
 *      AgentSession can correlate the question to the SDK's tool_use_id.
 *      Falling back to an empty string is safe — `awaitUserAnswer`
 *      generates its own request id and only uses `toolUseId` for
 *      attribution.
 */
export function createAskUserQuestionBridgeHandler(
  awaitUserAnswer: AwaitUserAnswerHandler,
): (
  args: { questions: Array<Record<string, unknown>> },
  extra: unknown,
) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async (args, extra) => {
    const parsed = parseAskUserQuestionInput(args);
    if (!parsed.ok) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        content: [
          {
            type: "text",
            text: `Error: invalid AskUserQuestion input — ${issues}`,
          },
        ],
      };
    }

    const toolUseId =
      typeof (extra as { toolUseId?: unknown })?.toolUseId === "string"
        ? ((extra as { toolUseId: string }).toolUseId)
        : "";

    const answer = await awaitUserAnswer(parsed.value, toolUseId);
    return {
      content: [{ type: "text", text: answer }],
    };
  };
}

/**
 * Build the in-process MCP server config that registers our AskUserQuestion
 * override with the Claude Agent SDK. Returns a value suitable for splicing
 * into the SDK's `mcpServers` map under `FLOCKCTL_HOST_MCP_SERVER_NAME`.
 *
 * Lazily imports the SDK so this module stays loadable in environments where
 * the optional `@anthropic-ai/claude-agent-sdk` is not installed (the SDK is
 * an optional peer dep — see `package.json`).
 */
export async function buildAskUserQuestionMcpServer(
  awaitUserAnswer: AwaitUserAnswerHandler,
): Promise<unknown> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    createSdkMcpServer: (opts: {
      name: string;
      version: string;
      tools: unknown[];
    }) => unknown;
    tool: (
      name: string,
      description: string,
      inputSchema: Record<string, z.ZodTypeAny>,
      handler: (args: any, extra: unknown) => Promise<unknown>,
      extras?: { alwaysLoad?: boolean },
    ) => unknown;
  };

  const handler = createAskUserQuestionBridgeHandler(awaitUserAnswer);

  return sdk.createSdkMcpServer({
    name: FLOCKCTL_HOST_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      sdk.tool(
        ASK_USER_QUESTION_BUILTIN_NAME,
        ASK_USER_QUESTION_BRIDGE_DESCRIPTION,
        askUserQuestionBridgeRawShape,
        handler,
      ),
    ],
  });
}
