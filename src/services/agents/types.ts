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
  | { type: "tool_call"; toolName: string; content: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; content: string }
  | { type: "usage"; usage: AgentStreamUsage };

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
