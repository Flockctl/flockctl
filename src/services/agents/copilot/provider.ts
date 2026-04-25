import type {
  AgentProvider,
  AgentModel,
  AgentReadiness,
  ChatOptions,
  ChatResult,
  StreamChatOptions,
  StreamChatEvent,
  CostInput,
} from "../types.js";
import {
  COPILOT_MODELS,
  checkCopilotReadiness,
  clearCopilotReadinessCache,
  streamViaCopilotSdk,
} from "../../ai/copilot-sdk.js";
import type { AgentUsage } from "../types.js";

/**
 * GitHub Copilot provider.
 *
 * Selected per-task / per-chat via an AI Provider Key with `provider ==
 * "github_copilot"`. The task executor forwards the key's `keyValue` (a
 * GitHub token) as `opts.providerKeyValue`; when absent the SDK falls back
 * to `$GH_TOKEN` / `$GITHUB_TOKEN` / `gh auth status`.
 *
 * Billing contract (measured 2026-04-21 via `scripts/copilot-spike.ts`):
 *   - Each `chat()` / `streamChat()` turn consumes one premium request,
 *     multiplied by the model's `multiplier` field. `claude-opus-4.7` = 7.5x,
 *     most other models = 1x, `gpt-4.1` / `gpt-5-mini` = 0 (free on Pro+).
 *   - Tool calls INSIDE a turn are free — batch multi-step work into one
 *     prompt rather than chaining follow-ups.
 *   - `estimateCost()` returns 0 USD because Copilot is a flat-rate
 *     subscription; the real cost is quota consumption, not dollars.
 */
export class CopilotProvider implements AgentProvider {
  readonly id = "copilot";
  readonly displayName = "GitHub Copilot";

  listModels(): AgentModel[] {
    return COPILOT_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
  }

  checkReadiness(): AgentReadiness {
    return checkCopilotReadiness();
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    // Drive the streaming SDK directly so intermediate events — text deltas,
    // `tool.execution_start`, `tool.execution_complete` — reach the caller's
    // `onEvent` in the order the Copilot session emits them. The previous
    // implementation deferred to `chatViaCopilotSdk`, which accumulated the
    // full turn and emitted a single text block at the end; that erased all
    // tool-boundary context and made Copilot chats render as one post-hoc
    // blob instead of a per-block live transcript.
    let text = "";
    const usage: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    let errorMsg: string | undefined;

    for await (const ev of streamViaCopilotSdk({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      resumeSessionId: opts.resumeSessionId,
      signal: opts.abortSignal,
      canUseTool: opts.canUseTool,
      sdkPermissionMode: opts.sdkPermissionMode,
      githubToken: opts.providerKeyValue,
      workingDirectory: opts.cwd,
      onEvent: opts.onEvent,
    })) {
      if (ev.type === "text" && ev.text) {
        text += ev.text;
        opts.onEvent?.({ type: "text", content: ev.text });
      } else if (ev.type === "done" && ev.usage) {
        usage.inputTokens = ev.usage.inputTokens;
        usage.outputTokens = ev.usage.outputTokens;
      } else if (ev.type === "error") {
        errorMsg = ev.error;
      }
    }
    if (errorMsg) {
      throw new Error(`Copilot SDK error: ${errorMsg}`);
    }
    return {
      text,
      usage,
      costUsd: 0,
    };
  }

  async *streamChat(opts: StreamChatOptions): AsyncIterable<StreamChatEvent> {
    for await (const ev of streamViaCopilotSdk({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      resumeSessionId: opts.resumeSessionId,
      signal: opts.signal,
      canUseTool: opts.canUseTool,
      sdkPermissionMode: opts.sdkPermissionMode,
      githubToken: opts.providerKeyValue,
      workingDirectory: opts.cwd,
    })) {
      yield ev;
    }
  }

  /**
   * Copilot usage is covered by the flat-rate subscription, not billed per
   * token, so we report 0 USD. Callers who need quota-based cost can look
   * up `COPILOT_MODELS[model].multiplier` directly.
   */
  estimateCost(_model: string, _usage: CostInput): number {
    return 0;
  }

  clearReadinessCache(): void {
    clearCopilotReadinessCache();
  }
}
