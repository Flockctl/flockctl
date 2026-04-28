import type { AwaitUserAnswerHandler } from "./ask-user-question-bridge.js";
import {
  ASK_USER_QUESTION_BUILTIN_NAME,
  FLOCKCTL_HOST_MCP_SERVER_NAME,
  buildAskUserQuestionMcpServer,
} from "./ask-user-question-bridge.js";

interface StreamEvent {
  /**
   * Event kinds the SDK stream surfaces to consumers.
   * `turn_end` fires once per completed assistant SDK message — it marks the
   * boundary between agent turns so downstream persistence can close out one
   * `chat_messages` row and start a fresh one, mirroring Claude Code's
   * per-message rendering instead of merging all text into a single row.
   *
   * `session_id` fires ONCE as soon as the SDK emits its first message with a
   * `session_id` (the `init` / first assistant message). Surfacing it eagerly
   * — rather than waiting for the `result` at turn end — is what keeps
   * chat-resume working across an interrupted stream (daemon shutdown mid-turn
   * during `make reinstall`, client disconnect, aborted run). Without the
   * eager emit the session id was only captured from the `result` message,
   * which never arrives on abort, so `chat.claudeSessionId` stayed null and
   * the next turn started a fresh SDK session with zero prior context.
   */
  type: "text" | "thinking" | "tool_call" | "tool_result" | "usage" | "turn_end" | "session_id";
  content: string | Record<string, unknown>;
  toolName?: string;
  /**
   * The SDK-assigned id of THIS tool_use block (`toolu_…`). Forwarded so
   * downstream layers can match a later `parent_tool_use_id` (which points
   * AT this id) back to the spawning call — e.g. the `/chats/:id/todos/agents`
   * route correlates sub-agent snapshots to the originating `Task` tool_call
   * message via this id, and uses the Task call's `description` as the tab
   * label. Always set on `tool_call` events; undefined elsewhere.
   */
  toolUseId?: string;
  /**
   * SDK-supplied attribution for `tool_call` events. NULL on a top-level
   * tool_use emitted by the main agent the user is conversing with; a
   * `toolu_…` id when the call was emitted from inside a sub-agent spawned
   * via the `Task` tool — in which case the value points back to the
   * parent `Task` tool_use that created the sub-agent. Plumbed from the
   * SDK through `agent-session` to the projection layers (chat_todos,
   * future per-agent UI grouping) so timelines from different agents in
   * the same chat can be told apart instead of being merged into one
   * flat list.
   */
  parentToolUseId?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostUsd: number;
  };
}

/**
 * Reasoning effort levels surfaced by the Claude Agent SDK. Mirrors the
 * SDK's `EffortLevel` type so consumers don't have to import from the SDK
 * directly. `high` is the pre-toggle default.
 */
export type EffortLevel = "low" | "medium" | "high" | "max";

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
  /**
   * Adaptive extended thinking toggle. Defaults to `true` — matches the
   * SDK's own default where adaptive thinking is enabled on supported
   * models. When `false`, forwards `thinking: { type: "disabled" }` so the
   * model skips the think step entirely (faster, cheaper, no thinking
   * blocks in the stream).
   */
  thinkingEnabled?: boolean;
  /**
   * Reasoning effort level. Defaults to `"high"` when omitted — byte-
   * identical to the pre-toggle behavior. The SDK guides thinking depth
   * from this value when adaptive thinking is enabled.
   */
  effort?: EffortLevel;
  /** Called for each intermediate event during the SDK stream */
  onEvent?: (event: StreamEvent) => void;
  /** Signal to abort the running chat */
  abortSignal?: AbortSignal;
  /** Resolved SDK permission mode. If omitted, defaults to bypass when no canUseTool is given. */
  sdkPermissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** Claude Code session ID to resume — SDK reloads prior conversation. */
  resumeSessionId?: string;
  /**
   * MCP servers to expose to the SDK. Pass-through to the Claude Agent SDK's
   * `mcpServers` option. When omitted, the SDK sees no MCP servers — the
   * interactive `claude` CLI reads `.mcp.json` automatically, but the SDK
   * does NOT, so callers MUST forward servers explicitly.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
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
  /**
   * Hooks the SDK's `AskUserQuestion` tool through Flockctl's structured
   * questions pipeline. When set, ai/client.ts:
   *   1. registers an in-process MCP override under `flockctl_host` whose
   *      handler awaits this callback,
   *   2. adds `AskUserQuestion` to the SDK's `disallowedTools` so the
   *      stubbed-in headless-mode built-in cannot resolve with empty
   *      answers (the bug behind task 432).
   *
   * Callback contract mirrors `agent-session/session.ts:awaitUserAnswer`:
   * resolve with the answer text once the UI / API delivers it; reject on
   * abort. See `services/ai/ask-user-question-bridge.ts` for the full
   * design rationale and why this is *not* an MCP escape hatch.
   */
  askUserQuestionHandler?: AwaitUserAnswerHandler;
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
    /* v8 ignore next 4 — platform-specific candidate arrays only evaluated on
       the target OS; the test suite runs on a single host so only one branch
       is taken. Windows is unsupported per CLAUDE.md. */
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
    /* v8 ignore next — `which` either succeeds with a path or throws; an
       empty-string success case is pathological. */
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
      // When the final user turn carries Anthropic content blocks (e.g. a
      // text block + one or more image blocks for attachments), hand the SDK
      // an AsyncIterable<SDKUserMessage> so the blocks reach the model
      // natively — same flow Anthropic's `MessageParam.content` accepts.
      // Plain strings keep the fast-path (`prompt: string`) so the text-only
      // behavior is byte-identical to pre-multimodal.
      const rawContent = userMessage.content;
      const isBlockArray = Array.isArray(rawContent);
      const promptForSDK: string | AsyncIterable<any> = isBlockArray
        ? (async function* () {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: rawContent },
              parent_tool_use_id: null,
            };
          })()
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent);
      // Retained for the session-rename label below; falls back to a generic
      // marker when the turn is multimodal (no single string to slice).
      const content = typeof rawContent === "string"
        ? rawContent
        : isBlockArray
          ? (rawContent.find((b: any) => b?.type === "text")?.text ?? "[multimodal message]")
          : JSON.stringify(rawContent);

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
      // AskUserQuestion bridge — when the caller wires `askUserQuestionHandler`,
      // we override the SDK's stubbed-headless built-in with an in-process
      // tool that blocks until the UI / API delivers the answer. See
      // `ai/ask-user-question-bridge.ts` for the full design rationale and
      // why this is the same pattern Claude Code itself uses internally.
      const mergedMcpServers: Record<string, unknown> = { ...(opts.mcpServers ?? {}) };
      const disallowedTools: string[] = [];
      if (opts.askUserQuestionHandler) {
        mergedMcpServers[FLOCKCTL_HOST_MCP_SERVER_NAME] = await buildAskUserQuestionMcpServer(
          opts.askUserQuestionHandler,
        );
        // Suppress the SDK's built-in `AskUserQuestion` so the model sees
        // only our override (`mcp__flockctl_host__AskUserQuestion`). Without
        // this, the headless-mode CLI auto-resolves the built-in with empty
        // answers BEFORE our override is even consulted.
        disallowedTools.push(ASK_USER_QUESTION_BUILTIN_NAME);
      }
      const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
      // Thinking / effort resolution — both default to the pre-toggle
      // behavior (adaptive thinking on, effort `high`) so existing callers
      // and existing DB rows (where the columns are NULL / default) are
      // byte-identical to the previous SDK invocation.
      const effort: EffortLevel = opts.effort ?? "high";
      const thinkingEnabled = opts.thinkingEnabled ?? true;
      const queryOpts: Record<string, any> = {
        model: opts.model,
        systemPrompt: opts.system,
        effort,
        ...(!thinkingEnabled && { thinking: { type: "disabled" } }),
        ...permissionOpts,
        persistSession: true,
        ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
        ...(opts.cwd && { cwd: opts.cwd }),
        ...(opts.noTools && { tools: [] }),
        ...(opts.resumeSessionId && { resume: opts.resumeSessionId }),
        ...(disallowedTools.length > 0 && { disallowedTools }),
        ...(hasMcpServers && { mcpServers: mergedMcpServers }),
      };

      if (options?.configDir) {
        const { homedir } = await import("node:os");
        const dir = options.configDir.startsWith("~/")
          ? options.configDir.replace("~", homedir())
          : options.configDir;
        queryOpts.env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      }

      const stream = query({
        prompt: promptForSDK,
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
          // Eagerly surface the session_id from the FIRST SDK message that
          // carries one (system `init`, first `assistant`, etc.). This is the
          // fix for "context lost after make reinstall" — without it, we only
          // captured session_id from the terminal `result` message, so a
          // stream that aborts mid-turn (daemon shutdown draining in-flight
          // chats) left `chat.claudeSessionId` unwritten and the next turn
          // started a fresh SDK session with no prior context. Deduped here
          // so the onEvent fires exactly once per chat() call even though
          // every subsequent SDK message also carries `session_id`.
          const msgSessionId = (message as any).session_id as string | undefined;
          if (msgSessionId && !sessionId) {
            sessionId = msgSessionId;
            opts.onEvent?.({ type: "session_id", content: msgSessionId });
          }
          // Stream intermediate events for live logging
          if (message.type === "assistant") {
            const betaMsg = (message as any).message;
            // The SDK marks every message that originated inside a sub-agent
            // (Task tool side-chain) with `parent_tool_use_id`, set to the
            // tool_use id of the spawning Task call. NULL/undefined means the
            // message came from the main agent the user is talking to. We
            // forward this attribution onto every `tool_call` event we
            // synthesise below so downstream projections (chat_todos
            // per-agent grouping in particular) can split the timeline by
            // agent instead of mashing all sub-agents' snapshots into the
            // main feed.
            const parentToolUseId =
              (message as any).parent_tool_use_id ?? null;
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
            /* v8 ignore next — the Claude SDK always populates content when
               usage is present; this optional-chain guard is defensive. */
            if (betaMsg?.content) {
              for (const block of betaMsg.content) {
                if (block.type === "text" && block.text) {
                  opts.onEvent?.({ type: "text", content: block.text });
                } else if (block.type === "thinking" && (block as any).thinking) {
                  opts.onEvent?.({ type: "thinking", content: (block as any).thinking });
                  /* v8 ignore next — the SDK only emits text / thinking /
                     tool_use blocks inside content; any other type is
                     defensive and never observed in practice. */
                } else if (block.type === "tool_use") {
                  opts.onEvent?.({
                    type: "tool_call",
                    content: block.input ?? {},
                    toolName: block.name,
                    toolUseId: block.id,
                    parentToolUseId,
                  });
                }
              }
            }
            // Mark end-of-turn for every assistant SDK message so listeners
            // persist one `chat_messages` row per turn. Without this, an
            // intermediate text-only turn (no tool_use) merges into the
            // following turn's row because only `tool_call` currently
            // triggers a flush — Claude Code renders each assistant message
            // as its own bubble, so we match that 1:1 here.
            opts.onEvent?.({ type: "turn_end", content: "" });
          } else if (message.type === "tool_use_summary") {
            opts.onEvent?.({
              type: "tool_result",
              content: (message as any).summary ?? "",
              toolName: (message as any).tool_name,
            });
          } else if (message.type === "result") {
            resultText = (message as any).result ?? "";
            // Terminal result's session_id is the authoritative post-turn id
            // (the SDK may fork on resume). Overwrite the eagerly-captured
            // value from the first assistant/system message.
            sessionId = (message as any).session_id ?? sessionId;
            // NOTE: result.usage and result.total_cost_usd from Claude Agent SDK
            // describe only the LAST turn, not the full session. Keep the values
            // accumulated from assistant messages above, which sum across all turns.
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
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        /* v8 ignore next — DOMException already covers AbortSignal.abort();
           the plain-Error AbortError branch exists for older Node fallbacks. */
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new Error(`AI stream error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Tag session with [FLOCKCTL] prefix in Claude Code UI
      if (sessionId) {
        const label = opts.sessionLabel || content.slice(0, 50).replace(/\n/g, " ");
        const { renameClaudeSession } = await import("../claude/cli.js");
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
