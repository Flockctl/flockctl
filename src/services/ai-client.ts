interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "usage";
  content: string | Record<string, unknown>;
  toolName?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostUsd: number;
  };
}

interface ChatOptions {
  model: string;
  system: string;
  messages: any[];
  tools?: any[];
  max_tokens?: number;
  noTools?: boolean;
  cwd?: string;
  /** Label used for [FLOCKCTL] session title in Claude Code UI */
  sessionLabel?: string;
  /** Called for each intermediate event during the SDK stream */
  onEvent?: (event: StreamEvent) => void;
  /** Signal to abort the running chat */
  abortSignal?: AbortSignal;
  /** Resolved SDK permission mode. If omitted, defaults to bypass when no canUseTool is given. */
  sdkPermissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** Claude Code session ID to resume — SDK reloads prior conversation. */
  resumeSessionId?: string;
  /** Custom permission handler — when provided, uses 'default' permissionMode instead of bypass */
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: {
    signal: AbortSignal;
    suggestions?: any[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  }) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }>;
}

interface ChatResult {
  text: string;
  rawContent?: any;
  toolCalls?: Array<{ id: string; name: string; input: any }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  costUsd?: number;
  sessionId?: string;
}

export interface AIClient {
  chat(opts: ChatOptions): Promise<ChatResult>;
}

/**
 * Resolve path to the Claude Code CLI executable.
 * Priority: native SDK binary → global `claude` in PATH → fallback to SDK cli.js
 */
function resolveClaudeExecutable(): string | undefined {
  // 1. Try native platform binary from optional SDK package
  try {
    const { createRequire } = require("module");
    const req = createRequire(__filename);
    const platform = process.platform;
    const arch = process.arch;
    const candidates = platform === "linux"
      ? [`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/cli`, `@anthropic-ai/claude-agent-sdk-linux-${arch}/cli`]
      : platform === "win32"
        ? [`@anthropic-ai/claude-agent-sdk-win32-${arch}/cli.exe`]
        : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/cli`];
    for (const candidate of candidates) {
      try { return req.resolve(candidate); } catch {}
    }
  } catch {}

  // 2. Try globally installed `claude` CLI
  try {
    const { execFileSync } = require("child_process");
    const globalPath = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 3000 }).trim();
    if (globalPath) return globalPath;
  } catch {}

  // 3. Let SDK try its own fallback (node cli.js)
  /* v8 ignore next — defensive: only reached when `which claude` fails */
  return undefined;
}

let _cachedClaudePath: string | undefined | null = null;
function getClaudeExecutablePath(): string | undefined {
  if (_cachedClaudePath === null) {
    _cachedClaudePath = resolveClaudeExecutable();
  }
  return _cachedClaudePath;
}

export function createAIClient(options?: { configDir?: string }): AIClient {
  return {
    async chat(opts: ChatOptions): Promise<ChatResult> {
      if (!opts.messages.length) throw new Error("messages array must not be empty");

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const { calculateCost } = await import("./cost.js");
      const userMessage = opts.messages[opts.messages.length - 1];
      const content = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);

      const claudePath = getClaudeExecutablePath();
      const sdkMode = opts.sdkPermissionMode
        ?? (opts.canUseTool ? "default" : "bypassPermissions");
      const permissionOpts: Record<string, any> = { permissionMode: sdkMode };
      if (sdkMode === "bypassPermissions") {
        permissionOpts.allowDangerouslySkipPermissions = true;
      }
      if (opts.canUseTool) {
        permissionOpts.canUseTool = opts.canUseTool;
      }
      const queryOpts: Record<string, any> = {
        model: opts.model,
        systemPrompt: opts.system,
        ...permissionOpts,
        persistSession: true,
        ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
        ...(opts.cwd && { cwd: opts.cwd }),
        ...(opts.noTools && { tools: [] }),
        ...(opts.resumeSessionId && { resume: opts.resumeSessionId }),
      };

      if (options?.configDir) {
        const { homedir } = await import("node:os");
        const dir = options.configDir.startsWith("~/")
          ? options.configDir.replace("~", homedir())
          : options.configDir;
        queryOpts.env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      }

      const stream = query({
        prompt: content,
        options: queryOpts,
      });

      let resultText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationInputTokens = 0;
      let cacheReadInputTokens = 0;
      let totalCostUsd = 0;
      let sessionId: string | undefined;

      try {
        for await (const message of stream) {
          // Check abort signal between SDK messages
          if (opts.abortSignal?.aborted) {
            throw new DOMException("Task cancelled", "AbortError");
          }
          // Stream intermediate events for live logging
          if (message.type === "assistant") {
            const betaMsg = (message as any).message;
            // Extract per-turn usage for live metrics
            if (betaMsg?.usage) {
              inputTokens += betaMsg.usage.input_tokens ?? 0;
              outputTokens += betaMsg.usage.output_tokens ?? 0;
              cacheCreationInputTokens += betaMsg.usage.cache_creation_input_tokens ?? 0;
              cacheReadInputTokens += betaMsg.usage.cache_read_input_tokens ?? 0;
              totalCostUsd = calculateCost(
                "anthropic",
                opts.model,
                inputTokens,
                outputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
              );
              opts.onEvent?.({
                type: "usage",
                content: "",
                usage: {
                  inputTokens,
                  outputTokens,
                  cacheCreationInputTokens,
                  cacheReadInputTokens,
                  totalCostUsd,
                },
              });
            }
            if (betaMsg?.content) {
              for (const block of betaMsg.content) {
                if (block.type === "text" && block.text) {
                  opts.onEvent?.({ type: "text", content: block.text });
                } else if (block.type === "tool_use") {
                  opts.onEvent?.({
                    type: "tool_call",
                    content: block.input ?? {},
                    toolName: block.name,
                  });
                }
              }
            }
          } else if (message.type === "tool_use_summary") {
            opts.onEvent?.({
              type: "tool_result",
              content: (message as any).summary ?? "",
              toolName: (message as any).tool_name,
            });
          } else if (message.type === "result") {
            resultText = (message as any).result ?? "";
            sessionId = (message as any).session_id;
            const usage = (message as any).usage;
            if (usage) {
              // Final cumulative values from SDK override intermediate accumulation
              inputTokens = usage.input_tokens ?? inputTokens;
              outputTokens = usage.output_tokens ?? outputTokens;
              cacheCreationInputTokens = usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
              cacheReadInputTokens = usage.cache_read_input_tokens ?? cacheReadInputTokens;
            }
            // Prefer exact SDK cost when available; otherwise keep live estimate
            const sdkCost = (message as any).total_cost_usd;
            totalCostUsd = sdkCost && sdkCost > 0
              ? sdkCost
              : calculateCost(
                  "anthropic",
                  opts.model,
                  inputTokens,
                  outputTokens,
                  cacheCreationInputTokens,
                  cacheReadInputTokens,
                );
            opts.onEvent?.({
              type: "usage",
              content: "",
              usage: {
                inputTokens,
                outputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                totalCostUsd,
              },
            });
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new Error(`AI stream error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Tag session with [FLOCKCTL] prefix in Claude Code UI
      if (sessionId) {
        const label = opts.sessionLabel || content.slice(0, 50).replace(/\n/g, " ");
        const { renameClaudeSession } = await import("./claude-cli.js");
        renameClaudeSession(sessionId, `[FLOCKCTL] ${label}`);
      }

      return {
        text: resultText,
        costUsd: totalCostUsd,
        usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
        sessionId,
      };
    },
  };
}
