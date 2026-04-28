export interface AgentModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface AgentReadiness {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface AgentStreamUsage extends AgentUsage {
  totalCostUsd: number;
}

export type AgentStreamEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      content: Record<string, unknown>;
      /**
       * SDK-assigned id of THIS tool_use block (`toolu_…`). Forwarded so
       * downstream layers can match a later `parentToolUseId` (which points
       * AT this id) back to the spawning call — the
       * `/chats/:id/todos/agents` route correlates sub-agent snapshots to
       * the originating Task tool_call message via this id, and uses the
       * Task call's `description` as the per-agent tab label.
       */
      toolUseId?: string | null;
      /**
       * Sub-agent attribution from the Claude Agent SDK. NULL on a top-
       * level tool_use emitted by the main agent the user is conversing
       * with. A `toolu_…` id when the call was emitted from inside a
       * sub-agent spawned via the Task tool — in which case the value
       * points back to the parent Task tool_use that created the sub-
       * agent. Plumbed from the SDK through the provider layer to
       * `chat_todos` so per-agent timelines stay separated.
       */
      parentToolUseId?: string | null;
    }
  | { type: "tool_result"; toolName: string; content: string }
  | { type: "turn_end"; content?: string }
  | { type: "usage"; usage: AgentStreamUsage }
  // Eager session_id emit. Fired once per chat() call, from the first SDK
  // message carrying a session_id — well before the terminal `result`.
  // Lets AgentSession propagate the id up to chat-routes so it can be
  // persisted as `chat.claudeSessionId` BEFORE the stream finishes, closing
  // the "context lost after make reinstall" window where a mid-turn abort
  // left the id unwritten and the next turn forked to a fresh SDK session.
  | { type: "session_id"; content: string };

export interface PermissionDecision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface PermissionQuery {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
}

export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionQuery,
) => Promise<PermissionDecision>;

/**
 * MCP server spec passed to the agent SDK. The shape is pass-through to the
 * Claude Agent SDK's `mcpServers` option (stdio/sse/http variants), so it is
 * intentionally a loose record type — the provider layer doesn't interpret
 * the fields, it just forwards them. Resolution from flockctl's global /
 * workspace / project MCP directories happens in the caller (usually
 * `AgentSession`) via `resolveMcpServersForProject`.
 */
export type AgentMcpServers = Record<string, Record<string, unknown>>;

export interface ChatOptions {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  noTools?: boolean;
  cwd?: string;
  configDir?: string;
  sessionLabel?: string;
  onEvent?: (event: AgentStreamEvent) => void;
  abortSignal?: AbortSignal;
  canUseTool?: PermissionHandler;
  /** Resolved SDK permission mode. Provider decides how (or whether) to apply it. */
  sdkPermissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** Claude Code session ID to resume — SDK reloads prior conversation. */
  resumeSessionId?: string;
  /**
   * Provider-specific credential (`ai_provider_keys.keyValue`) supplied by the
   * task / chat's assigned key. For `github_copilot`-backed keys this is the
   * GitHub token; for Claude Code it is unused (auth lives in `configDir`).
   */
  providerKeyValue?: string;
  /**
   * MCP servers to make available to the agent. Forwarded to the Claude Agent
   * SDK's `mcpServers` option. When omitted, the SDK sees no MCP servers
   * (flockctl's on-disk `.mcp.json` is NOT auto-read by the SDK — only by the
   * interactive `claude` CLI). Typically resolved upstream via
   * `resolveMcpServersForProject(projectId)`.
   */
  mcpServers?: AgentMcpServers;
  /**
   * Adaptive extended thinking toggle. When `false`, the provider is
   * expected to forward `thinking: { type: "disabled" }` to the Claude
   * Agent SDK. When omitted, the SDK's own default applies (adaptive on
   * supported models).
   */
  thinkingEnabled?: boolean;
  /**
   * Reasoning effort level (`low` | `medium` | `high` | `max`). Forwarded
   * verbatim to the SDK. When omitted, providers default to `"high"` —
   * byte-identical to the pre-toggle behavior.
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Hooks the SDK's built-in `AskUserQuestion` through Flockctl's structured
   * questions pipeline. When set, the provider must (1) register an in-process
   * MCP override that delegates to this callback and (2) add `AskUserQuestion`
   * to the SDK's `disallowedTools`. See
   * `services/ai/ask-user-question-bridge.ts` for the design rationale.
   *
   * The callback is the same shape as the AgentSession's private
   * `awaitUserAnswer` — it receives a parsed (Flockctl-singular) question
   * payload plus the SDK-assigned `tool_use_id`, and resolves with the
   * answer text once the UI / API delivers one. Rejects on session abort.
   *
   * Currently only the Claude Code provider honors this; other providers
   * keep using `session.ts`'s in-loop AskUserQuestion handling because they
   * surface tool calls directly via `response.toolCalls`.
   */
  askUserQuestionHandler?: (
    parsed: import("../agent-tools.js").ParsedAskUserQuestion,
    toolUseId: string,
  ) => Promise<string>;
}

export interface ChatResult {
  text: string;
  rawContent?: unknown;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  usage?: AgentUsage;
  costUsd?: number;
  sessionId?: string;
}

export interface StreamChatOptions {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  cwd?: string;
  configDir?: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  canUseTool?: PermissionHandler;
  sdkPermissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** See `ChatOptions.providerKeyValue`. */
  providerKeyValue?: string;
  /** See `ChatOptions.mcpServers`. */
  mcpServers?: AgentMcpServers;
}

export interface StreamChatEvent {
  type: "text" | "done" | "error";
  text?: string;
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  };
  error?: string;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): AgentModel[];
  checkReadiness(): AgentReadiness;
  chat(opts: ChatOptions): Promise<ChatResult>;
  streamChat(opts: StreamChatOptions): AsyncIterable<StreamChatEvent>;
  /** Returns cost in USD, or null if the provider cannot calculate it. */
  estimateCost(model: string, usage: CostInput): number | null;
  /** Optional: provider-specific session rename (e.g. Claude Code `[FLOCKCTL]` prefix). */
  renameSession?(sessionId: string, title: string): Promise<void>;
  /** Optional: clear cached readiness state (for tests / manual refresh). */
  clearReadinessCache?(): void;
}
