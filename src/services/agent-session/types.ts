import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

/**
 * Content payload accepted for a single chat turn. Mirrors Anthropic's
 * `MessageParam.content` — either a plain string (text-only turn) or an array
 * of content blocks (text + images + other multimodal parts). Reusing the
 * SDK's own `ContentBlockParam` means we don't maintain a parallel shape and
 * the Anthropic SDK accepts the array natively without a second serialization
 * step.
 */
export type AnthropicContentBlock = ContentBlockParam;
export type MessageContent = string | AnthropicContentBlock[];

export interface AgentSessionEvents {
  text: (chunk: string) => void;
  thinking: (chunk: string) => void;
  tool_call: (name: string, input: any) => void;
  tool_result: (name: string, output: string) => void;
  /**
   * Fires once per completed assistant SDK message. Consumers that persist
   * chat history use this as a per-turn boundary so each agent message gets
   * its own `chat_messages` row — matches Claude Code's rendering where an
   * intermediate text-only turn is a separate bubble, not merged into the
   * next turn's text.
   */
  turn_end: () => void;
  error: (err: Error) => void;
  usage: (metrics: AgentSessionMetrics) => void;
  permission_request: (request: PermissionRequest) => void;
  question_request: (request: QuestionRequest) => void;
  session_id: (sessionId: string) => void;
  /**
   * Fires when `updatePermissionMode()` changes the session's live mode.
   * Chats surface this over WebSocket so every connected UI re-syncs its
   * permission switcher without a round-trip GET. `previous` is the value
   * before the swap — useful for logging audit trails of who relaxed perms
   * mid-turn. Not emitted when the new mode equals the old one.
   */
  permission_mode_changed: (event: {
    previous: PermissionModeLiteral;
    current: PermissionModeLiteral;
  }) => void;
  /**
   * Fires once per pending permission entry that `autoResolvePendingForMode`
   * resolved after a mode swap. Unlike UI-driven resolutions (which flow
   * through `chatExecutor.resolvePermission` → `broadcastPermissionResolved`),
   * the auto-resolve path fulfils the promise directly inside the session to
   * unblock the agentic loop without a round-trip. The executor subscribes
   * to this event and broadcasts the canonical `permission_resolved` frame
   * so UI pending-cards disappear the same way they do on manual allow.
   */
  permission_auto_resolved: (requestId: string) => void;
}

/**
 * Re-exported narrow type so this file stays free of a cyclic import on
 * permission-resolver (which pulls in node path/os utils). Session.ts is
 * the sole call site for the typed emit; UI-bound consumers only need the
 * string.
 */
export type PermissionModeLiteral =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "auto";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  toolUseID: string;
}

/**
 * Single option entry in a multiple-choice `AskUserQuestion` payload. Mirrors
 * the Claude Code harness shape — `label` is the visible chip text, while
 * `description` and `preview` are optional metadata the UI can render
 * alongside.
 */
export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

/**
 * Open-ended clarification question surfaced by the agent via the
 * `AskUserQuestion` tool. The session intercepts the tool_use, emits this
 * request, and awaits `resolveQuestion(requestId, answerText)` from the UI
 * before turning the answer into a `tool_result` back to the model.
 *
 * The optional `options` / `multiSelect` / `header` fields carry the
 * harness-style multiple-choice shape forward end-to-end (DB row + WS
 * payload). When `options` is absent or empty the prompt is free-form
 * — backwards-compatible with the original 0029 model.
 */
export interface QuestionRequest {
  requestId: string;
  question: string;
  toolUseID: string;
  /** Optional structured choice list (max 20 items per harness convention). */
  options?: QuestionOption[];
  /** Whether the user may pick more than one option. Defaults to false. */
  multiSelect?: boolean;
  /** Short chip label rendered above the option list (≤ 12 chars typical). */
  header?: string;
}

export interface AgentSessionMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  turns: number;
  durationMs: number;
}

/**
 * Why a session was aborted — set via `abort(reason)` and used by callers to
 * distinguish user cancellation, timeouts, and daemon shutdown. Without this,
 * every abort surfaces as an undifferentiated "AbortError: Task cancelled",
 * which makes timeouts look identical to user cancels in task-executor logs.
 */
export type AbortReason = "user" | "timeout" | "shutdown";
