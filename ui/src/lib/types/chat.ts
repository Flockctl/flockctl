import type { PermissionMode } from "./permission";

// --- Chat ---

export const ChatMessageRole = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
  thinking: "thinking",
} as const;
export type ChatMessageRole =
  (typeof ChatMessageRole)[keyof typeof ChatMessageRole];

export interface ChatCreate {
  title?: string | null;
  project_id?: string | null;
  projectId?: number | null;
  workspaceId?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Persisted AI provider key selection (provider is derived from the key). */
  aiProviderKeyId?: number | null;
  /** Persisted model id (e.g. "claude-sonnet-4-20250514"). */
  model?: string | null;
  /**
   * Opt-in isolation mode. `'worktree'` lazily materialises a per-chat
   * git worktree on the first message and pins every subsequent turn
   * to that filesystem. See migration 0060 + worktree-manager.ts.
   */
  isolation?: "worktree" | null;
}

export interface ChatMetrics {
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  /** Sum of GitHub Copilot premium-request multipliers across the chat's
   *  turns — shown in place of USD for Copilot chats, where cost is flat-rate
   *  quota rather than per-token billing. 0 when no Copilot usage. */
  total_copilot_quota: number;
  last_message_at: string | null;
  /**
   * First ~140 chars of the latest message body, single-line and
   * whitespace-collapsed. Null when the chat has no messages yet.
   * Projected by `getChatMetrics` from the same row already fetched
   * for `last_message_at` (zero extra query). Consumed by the chats
   * list row preview (slice 24-02 T01).
   */
  last_message_excerpt: string | null;
  /** Latest TodoWrite snapshot counts, or null when the chat has never
   *  received a TodoWrite call. Projected into the list response so the
   *  chat-list todo badge renders from the existing payload — no per-row
   *  follow-up fetch. Inner keys follow the server's `TodoCounts` shape
   *  (see src/services/todo-store.ts). */
  todos_counts: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
  } | null;
}

/**
 * Reasoning effort level. Mirrors the Claude Agent SDK's `EffortLevel`.
 * `xhigh` is the default; `null` on the chat row means "fall back to the
 * default". The SDK silently degrades `xhigh` to `high` on models that
 * don't support it (Opus 4.7 is the only model that does today).
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatResponse {
  id: string;
  user_id: string;
  project_id: string | null;
  workspace_id: string | null;
  project_name: string | null;
  workspace_name: string | null;
  title: string | null;
  entity_type: string | null;
  entity_id: string | null;
  permission_mode: PermissionMode | null;
  /**
   * Persisted AI provider key selection (serialized as a string by apiFetch's
   * camel → snake conversion, matching every other FK id in the UI). Null
   * when the chat hasn't been sent a message yet.
   */
  ai_provider_key_id: string | null;
  /** Persisted model id. Null falls back to project / global default. */
  model: string | null;
  /**
   * Per-chat adaptive extended thinking toggle. `true` (default) lets the
   * Claude Agent SDK decide when to think; `false` forces thinking off for
   * the next turn. Persisted on the chat row so reloads restore the pick.
   */
  thinking_enabled: boolean;
  /**
   * Per-chat reasoning effort level. `null` means "fall back to the default"
   * (`high` today) — matches the pre-toggle behavior.
   */
  effort: EffortLevel | null;
  /**
   * Per-chat pin toggle. Pinned chats float to the top of the list inside
   * the active filter bucket — the backend orders by `(pinned DESC,
   * created_at DESC)`, so filters still apply first and unpinned order is
   * preserved.
   */
  pinned: boolean;
  created_at: string;
  updated_at: string;
  /**
   * True while the chat-executor is actively running a turn. Mirrors the
   * detail endpoint's `is_running` (named `is_streaming` on the list to
   * match the slice spec language — both are sourced from
   * `chatExecutor.isRunning(id)`). Consumed by the chats list row to
   * paint the live-dot + "live" emerald text (slice 24-02 T01).
   */
  is_streaming?: boolean;
  metrics?: ChatMetrics;
  /**
   * Per-chat isolation mode (NULL = legacy shared cwd, `'worktree'` =
   * per-chat git worktree). See migration 0060.
   */
  isolation?: "worktree" | null;
  /**
   * Absolute path to the per-chat git worktree once the first message
   * has materialised it. NULL until then; NULL again after operator
   * cleanup (POST /chats/:id/end-session, DELETE /chats/:id/worktree).
   */
  worktree_path?: string | null;
  /** Branch name created with the worktree. NULL iff `worktree_path` is. */
  worktree_branch?: string | null;
}

export interface ChatUpdate {
  title?: string | null;
  permission_mode?: PermissionMode | null;
  /** Pass `null` to clear the saved selection (falls back to defaults). */
  aiProviderKeyId?: number | null;
  /** Pass `null` or `""` to clear the saved selection. */
  model?: string | null;
  /** Adaptive-thinking toggle — see `ChatResponse.thinking_enabled`. */
  thinkingEnabled?: boolean;
  /** Reasoning effort — pass `null` to reset back to the default. */
  effort?: EffortLevel | null;
  /** Pin/unpin this chat — pinned chats float to the top of the list. */
  pinned?: boolean;
}

export interface ChatMessageCreate {
  content: string;
  agent?: string;
  model?: string;
  keyId?: number;
  system?: string;
  /**
   * Optional per-turn override for the adaptive-thinking toggle. Sent as
   * `thinking_enabled` on the wire (streamMessage bypasses the camel →
   * snake conversion).
   */
  thinking_enabled?: boolean;
  /** Optional per-turn override for the effort level. */
  effort?: EffortLevel;
  /**
   * Attachment row ids to link to this user message. Client-side caps
   * mirror the server (≤10 per message, images only, ≤10MB each), but the
   * backend re-validates ownership and total byte budget against the DB.
   *
   * Sent as snake_case because streamMessage() bypasses the camelCase key
   * conversion in apiFetch — the backend reads `body.attachment_ids`
   * directly (see `parseAttachmentIds` in src/routes/chats.ts).
   */
  attachment_ids?: number[];
  entity_context?: {
    entity_type: "milestone" | "slice" | "task";
    entity_id: string;
    milestone_id?: string;
    slice_id?: string;
  };
}

/**
 * One attachment as it appears inside a `ChatMessageResponse.attachments`
 * array. Only the fields the UI needs are typed here — server-internal
 * columns like the absolute on-disk `path` are intentionally omitted from
 * the display surface.
 */
export interface ChatMessageAttachment {
  id: string;
  chat_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface ChatMessageResponse {
  id: string;
  chat_id: string;
  role: ChatMessageRole;
  content: string;
  created_at: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  /**
   * Linked attachments for this message. Populated by GET /chats/:id — the
   * backend batches the lookup across every user message in the transcript
   * so there's no per-row follow-up fetch. Assistant rows always come back
   * with an empty array.
   */
  attachments?: ChatMessageAttachment[];
  /**
   * Optional client-side flag — true when the daemon is still actively
   * appending content to this assistant row (e.g. the persisted assistant
   * row that's being filled in mid-turn). Drives the `.agent-glow` left-rule
   * walk on the latest streaming turn so the message visually reads as
   * "alive" without us having to chase liveBlocks vs persisted-row identity.
   * Server typically only sets this on the in-flight assistant row.
   */
  is_streaming?: boolean;
}

export interface ChatDetailResponse extends ChatResponse {
  messages: ChatMessageResponse[];
  metrics?: ChatMetrics;
  /**
   * True while the chat-executor is actively running a turn on the daemon.
   * Named in snake_case because apiFetch deep-converts every response key
   * camelCase → snake_case; if this were `isRunning` the runtime field
   * would still be `is_running` and the UI would read `undefined`,
   * silently hiding the Stop button after a page reload.
   */
  is_running?: boolean;
}

export interface ChatFullMetrics extends ChatMetrics {
  chat_id: string;
  created_at: string;
  updated_at: string;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  models_used: string[];
}

// Tool execution tracking for UI
export interface ToolExecution {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "success" | "error";
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Ordered unit of live-streaming chat output. `useChatStream` appends one of
 * these per SSE event so the conversation renders as a sequence of blocks
 * (text / thinking / tool_call / tool_result) in the exact order the agent
 * produced them — matching Claude Code's transcript layout instead of
 * collapsing the whole turn into three separate state buckets.
 *
 * Text and thinking blocks accumulate chunks; `streaming` flips false when a
 * boundary event (another block or end-of-stream) arrives. Tool blocks are
 * terminal — they land whole from one SSE frame.
 *
 * `id` is a client-side stream-scoped key for React reconciliation only. Once
 * the stream ends and the chat gets refetched, persisted DB rows replace
 * these blocks in the rendered list.
 */
export type LiveChatBlock =
  | { id: string; kind: "text"; content: string; streaming: boolean }
  | { id: string; kind: "thinking"; content: string; streaming: boolean }
  | {
      id: string;
      kind: "tool_call";
      name: string;
      input: unknown;
      summary: string;
      /**
       * Wall-clock ISO 8601 instant the block was appended to the live
       * transcript. Stamped client-side at append time (the SSE event itself
       * doesn't carry a timestamp), so it reflects when the UI saw the call —
       * which is what the "is the agent hung?" check actually wants.
       */
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool_result";
      name: string;
      output: string;
      summary: string;
      createdAt: string;
    };
