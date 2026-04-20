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
import { createAIClient } from "../../ai-client.js";
import {
  CLAUDE_CODE_MODELS,
  streamViaClaudeAgentSDK,
  renameClaudeSession,
  isClaudeBinaryPresent,
  isClaudeCodeAuthed,
  isClaudeCodeReady,
  clearReadinessCache,
} from "../../claude-cli.js";
import { calculateCost } from "../../cost.js";

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";

  listModels(): AgentModel[] {
    return CLAUDE_CODE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
  }

  checkReadiness(): AgentReadiness {
    return {
      installed: isClaudeBinaryPresent(),
      authenticated: isClaudeCodeAuthed(),
      ready: isClaudeCodeReady(),
    };
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const client = createAIClient({ configDir: opts.configDir });
    return client.chat({
      model: opts.model,
      system: opts.system,
      messages: opts.messages as any,
      tools: opts.tools as any,
      noTools: opts.noTools,
      cwd: opts.cwd,
      sessionLabel: opts.sessionLabel,
      onEvent: opts.onEvent as any,
      abortSignal: opts.abortSignal,
      canUseTool: opts.canUseTool as any,
      sdkPermissionMode: opts.sdkPermissionMode,
      resumeSessionId: opts.resumeSessionId,
    });
  }

  async *streamChat(opts: StreamChatOptions): AsyncIterable<StreamChatEvent> {
    const iter = streamViaClaudeAgentSDK({
      model: opts.model,
      system: opts.system,
      messages: opts.messages as any,
      cwd: opts.cwd,
      configDir: opts.configDir,
      resumeSessionId: opts.resumeSessionId,
      signal: opts.signal,
    });
    for await (const event of iter) {
      yield event as StreamChatEvent;
    }
  }

  estimateCost(model: string, usage: CostInput): number {
    return calculateCost(
      "claude_cli",
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationInputTokens ?? 0,
      usage.cacheReadInputTokens ?? 0,
    );
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    return renameClaudeSession(sessionId, title);
  }

  clearReadinessCache(): void {
    clearReadinessCache();
  }
}
