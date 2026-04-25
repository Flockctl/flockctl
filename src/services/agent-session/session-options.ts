/**
 * `AgentSessionOptions` — the full option bag accepted by `AgentSession`'s
 * constructor. Split out of `session.ts` purely because the interface is
 * documentation-dense (~100 lines of JSDoc explaining subtle task-vs-chat
 * behaviour) and drowns the class implementation when colocated. Not part
 * of the public barrel — callers pass object literals, they don't import
 * this name directly.
 */
import type { AgentProvider } from "../agents/types.js";
import type { PermissionMode } from "../permission-resolver.js";
import type { RegistryLike } from "../state-machines/sm-registry.js";
import type { MessageContent } from "./types.js";
import type { WorkspaceContext } from "./session-prompts.js";

export interface AgentSessionOptions {
  /** Either taskId or chatId must be provided. Determines ID namespace and WS routing. */
  taskId?: number;
  chatId?: number;
  /**
   * Final user-turn content. A plain string keeps the text-only path
   * unchanged; an array of content blocks is passed through verbatim to the
   * Anthropic SDK so images / other multimodal parts attached to this turn
   * flow to the model without a separate "multimodal" code path.
   */
  prompt: MessageContent;
  model: string;
  codebaseContext: string;
  workingDir?: string;
  timeoutSeconds?: number;
  configDir?: string;
  /** Agent provider id (defaults to registry default, usually "claude-code"). */
  agentId?: string;
  /** Explicit provider override — bypasses registry lookup. Useful for tests. */
  provider?: AgentProvider;
  /** Resolved permission mode (task → chat → project → workspace → "auto"). */
  permissionMode?: PermissionMode;
  /** Directories under which file-write tools are auto-approved in "auto" mode. */
  allowedRoots?: string[];
  /** Claude Code session ID to resume — used when a task was interrupted by a daemon restart. */
  resumeSessionId?: string;
  /** If set, use this verbatim as the system prompt (chat path). Otherwise build the autonomous-agent prompt (task path). */
  systemPromptOverride?: string;
  /**
   * When resuming with `resumeSessionId`, the default (task) behavior replaces the user prompt
   * with a "continue from where you left off" message. Chat sessions need each new message
   * to be used as-is — set this to false for chats.
   */
  useResumeContinuationPrompt?: boolean;
  /**
   * List of past messages (role/content) to seed the conversation when not
   * resuming. Used by chats that don't have a persisted Claude Code session
   * yet. `content` is widened to `string | AnthropicContentBlock[]` so the
   * caller can re-hydrate turns that had linked attachments (images, etc.)
   * without a separate multimodal path — the Anthropic SDK accepts the array
   * form natively.
   */
  priorMessages?: Array<{ role: "user" | "assistant"; content: MessageContent }>;
  /**
   * Optional project scope used by the knowledge-base retrieval layer to
   * surface past incidents into the system prompt on session start. When
   * null/undefined, the retrieval still runs but searches across all
   * projects (matches on symptom/root_cause/resolution text). Never affects
   * model behavior beyond the prepended "Past incidents" section.
   */
  projectId?: number | null;
  /**
   * List of file paths the upcoming task/chat is expected to touch. Used
   * together with `smRegistry` to cross-reference which entities' state
   * machines are in scope, and to inject their valid transitions +
   * invariants into the system prompt. Left undefined when the caller
   * doesn't have a file-scope hint yet (generic chat, ad-hoc prompt).
   */
  touchedFiles?: string[];
  /**
   * State-machine registry (as loaded from `<project>/.flockctl/state-machines/`
   * or hand-constructed in tests). When combined with `touchedFiles`, entries
   * whose `filePatterns` match any touched file are rendered into a
   * `<state_machines>` prompt section so the agent respects the declared
   * transitions while editing.
   */
  smRegistry?: RegistryLike;
  /**
   * Provider-specific credential from the attached AI Provider Key's
   * `keyValue`. Threaded to the provider as `ChatOptions.providerKeyValue`.
   * For `github_copilot` keys this is the GitHub token; for Claude Code this
   * is unused (auth lives in `configDir`).
   */
  providerKeyValue?: string;
  /**
   * Adaptive extended thinking toggle. Forwarded to `provider.chat` which
   * maps it to the SDK's `thinking: { type: "disabled" }` when `false`.
   * When omitted, the SDK's own default applies (adaptive on supported
   * models). Surfaced per-chat via the composer toolbar toggle.
   */
  thinkingEnabled?: boolean;
  /**
   * Reasoning effort level (`low` | `medium` | `high` | `max`). Forwarded
   * verbatim to `provider.chat`. When omitted, the provider falls back to
   * `"high"` — byte-identical to the pre-toggle behavior.
   */
  effort?: "low" | "medium" | "high" | "max";
  /**
   * Workspace scope for this session — name, absolute path, and the list of
   * projects that belong to it. Used to inject a "Workspace projects" block
   * into the system prompt so the agent treats those project paths as the
   * authoritative scope instead of blindly `ls`-ing the workspace root.
   *
   * Chat sessions already get an equivalent block via
   * `resolveChatSystemPrompt` → `buildWorkspaceSystemPrompt` and pass it
   * through `systemPromptOverride`; this option covers TASK sessions (which
   * run off the autonomous-agent prompt without an override) and any other
   * caller that wants the same scoping nudge without pre-rendering it.
   */
  workspaceContext?: WorkspaceContext;
}
