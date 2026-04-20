import { EventEmitter } from "events";
import { getAgentTools, executeToolCall } from "./agent-tools.js";
import { getFlockctlHome } from "../config.js";
import { getAgent } from "./agents/registry.js";
import type { AgentProvider } from "./agents/types.js";
import {
  type PermissionMode,
  DEFAULT_PERMISSION_MODE,
  decideAuto,
  modeToSdkOptions,
} from "./permission-resolver.js";

interface AgentSessionOptions {
  /** Either taskId or chatId must be provided. Determines ID namespace and WS routing. */
  taskId?: number;
  chatId?: number;
  prompt: string;
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
  /** List of past messages (role/content) to seed the conversation when not resuming. Used by chats that don't have a persisted Claude Code session yet. */
  priorMessages?: Array<{ role: "user" | "assistant"; content: unknown }>;
}

export interface AgentSessionEvents {
  text: (chunk: string) => void;
  tool_call: (name: string, input: any) => void;
  tool_result: (name: string, output: string) => void;
  error: (err: Error) => void;
  usage: (metrics: AgentSessionMetrics) => void;
  permission_request: (request: PermissionRequest) => void;
  session_id: (sessionId: string) => void;
}

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

export class AgentSession extends EventEmitter {
  private abortController = new AbortController();
  private messages: Array<{ role: string; content: any }> = [];
  private opts: AgentSessionOptions;
  private pendingPermissions = new Map<string, {
    resolve: (result: { behavior: "allow" } | { behavior: "deny"; message: string }) => void;
  }>();
  private permissionCounter = 0;
  private _abortReason: AbortReason | null = null;

  constructor(opts: AgentSessionOptions) {
    super();
    if (opts.taskId == null && opts.chatId == null) {
      throw new Error("AgentSession requires either taskId or chatId");
    }
    this.opts = opts;
  }

  /** Short identifier used for permission request IDs and log prefixes. */
  private sessionPrefix(): string {
    if (this.opts.taskId != null) return `t${this.opts.taskId}`;
    return `c${this.opts.chatId}`;
  }

  /** Public numeric ref — taskId if task session, otherwise chatId. */
  get refId(): number {
    return (this.opts.taskId ?? this.opts.chatId)!;
  }

  get refKind(): "task" | "chat" {
    return this.opts.taskId != null ? "task" : "chat";
  }

  /**
   * Resolve a pending permission request from the UI.
   */
  resolvePermission(requestId: string, result: { behavior: "allow" } | { behavior: "deny"; message: string }): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve(result);
    return true;
  }

  /** Number of permission requests currently awaiting a UI response. */
  get pendingPermissionCount(): number {
    return this.pendingPermissions.size;
  }

  /** Why this session was aborted (if any). */
  get abortReason(): AbortReason | null {
    return this._abortReason;
  }

  async run(): Promise<AgentSessionMetrics> {
    // Yield once so synchronous abort() calls made right after run() is invoked
    // can take effect before we enter the agentic loop.
    await Promise.resolve();
    const provider: AgentProvider = this.opts.provider ?? getAgent(this.opts.agentId);
    const tools = getAgentTools(this.opts.workingDir);
    const systemPrompt = this.opts.systemPromptOverride ?? this.buildSystemPrompt();
    let totalIn = 0, totalOut = 0;
    let cacheCreationIn = 0, cacheReadIn = 0;
    let totalCostUsd = 0;
    let turns = 0;
    const startTime = Date.now();

    const permissionMode: PermissionMode =
      this.opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const sdkOpts = modeToSdkOptions(permissionMode);
    const allowedRoots = this.opts.allowedRoots ?? [];

    // Permission handler — relays tool permission requests to the UI, with
    // a path-scoped short-circuit when mode is "auto".
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: any[];
        blockedPath?: string;
        decisionReason?: string;
        title?: string;
        displayName?: string;
        description?: string;
        toolUseID: string;
        agentID?: string;
      },
    ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
      if (permissionMode === "auto") {
        const decision = decideAuto(toolName, input, allowedRoots);
        if (decision.behavior === "allow") {
          return { behavior: "allow", updatedInput: input };
        }
      }

      const requestId = `perm-${this.sessionPrefix()}-${++this.permissionCounter}`;
      const request: PermissionRequest = {
        requestId,
        toolName,
        toolInput: input,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        toolUseID: options.toolUseID,
      };

      return new Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }>((resolve) => {
        // If session is aborted, deny immediately
        const onAbort = () => {
          this.pendingPermissions.delete(requestId);
          resolve({ behavior: "deny", message: "Task cancelled" });
        };
        if (this.abortController.signal.aborted) {
          resolve({ behavior: "deny", message: "Task cancelled" });
          return;
        }
        this.abortController.signal.addEventListener("abort", onAbort, { once: true });

        this.pendingPermissions.set(requestId, {
          resolve: (result) => {
            this.abortController.signal.removeEventListener("abort", onAbort);
            // SDK subprocess Zod schema requires `updatedInput` on allow —
            // echo the original input when the UI approves unchanged.
            if (result.behavior === "allow") {
              resolve({ behavior: "allow", updatedInput: input });
            } else {
              resolve(result);
            }
          },
        });
        this.emit("permission_request", request);
      });
    };

    // Initial message — when resuming, SDK already has prior context. For
    // tasks, replace the prompt with a "continue" nudge (recovery after daemon
    // restart). For chats, each new user message must be passed through as-is.
    const isResume = !!this.opts.resumeSessionId;
    const useContinuation = this.opts.useResumeContinuationPrompt ?? true;

    // When NOT resuming a Claude Code session, seed prior messages so the SDK
    // has chat history context. On resume, the SDK already has it internally.
    if (!isResume && this.opts.priorMessages) {
      for (const m of this.opts.priorMessages) {
        this.messages.push({ role: m.role, content: m.content });
      }
    }

    this.messages.push({
      role: "user",
      content: isResume && useContinuation
        ? "Continue from where you left off. The previous run was interrupted."
        : this.opts.prompt,
    });

    let currentSessionId: string | undefined = this.opts.resumeSessionId;

    // Timeout setup
    const timeout = this.opts.timeoutSeconds
      ? setTimeout(() => this.abort("timeout"), this.opts.timeoutSeconds * 1000)
      : null;

    try {
      // Agentic loop: repeat until AI responds without tool calls
      while (true) {
        this.abortController.signal.throwIfAborted();

        let streamedText = false;
        let turnUsageFromEvent = false;
        const response = await provider.chat({
          model: this.opts.model,
          system: systemPrompt,
          messages: this.messages,
          tools,
          cwd: this.opts.workingDir,
          configDir: this.opts.configDir,
          sessionLabel: this.refKind === "task" ? `Task #${this.refId}` : `Chat #${this.refId}`,
          abortSignal: this.abortController.signal,
          sdkPermissionMode: sdkOpts.permissionMode,
          resumeSessionId: currentSessionId,
          ...(sdkOpts.useCanUseTool ? { canUseTool } : {}),
          onEvent: (event) => {
            if (event.type === "text") {
              streamedText = true;
              this.emit("text", event.content);
            } else if (event.type === "tool_call") {
              this.emit("tool_call", event.toolName ?? "unknown", event.content);
            } else if (event.type === "tool_result") {
              this.emit("tool_result", event.toolName ?? "", event.content);
            } else if (event.type === "usage" && event.usage) {
              turnUsageFromEvent = true;
              totalIn = event.usage.inputTokens;
              totalOut = event.usage.outputTokens;
              cacheCreationIn = event.usage.cacheCreationInputTokens;
              cacheReadIn = event.usage.cacheReadInputTokens;
              totalCostUsd = event.usage.totalCostUsd;
              this.emit("usage", {
                inputTokens: totalIn,
                outputTokens: totalOut,
                cacheCreationInputTokens: cacheCreationIn,
                cacheReadInputTokens: cacheReadIn,
                totalCostUsd,
                turns,
                durationMs: Date.now() - startTime,
              } satisfies AgentSessionMetrics);
            }
          },
        });

        // Capture the returned sessionId so the next turn resumes the same
        // Claude Code session — and so task-executor can persist it for
        // daemon-restart recovery.
        if (response.sessionId && response.sessionId !== currentSessionId) {
          currentSessionId = response.sessionId;
          this.emit("session_id", response.sessionId);
        }

        if (turnUsageFromEvent) {
          // onEvent already set cumulative SDK values; just sync cost
          totalCostUsd = response.costUsd ?? totalCostUsd;
        } else {
          // No onEvent usage (e.g. mock) — accumulate from response
          totalIn += response.usage?.inputTokens ?? 0;
          totalOut += response.usage?.outputTokens ?? 0;
          cacheCreationIn += response.usage?.cacheCreationInputTokens ?? 0;
          cacheReadIn += response.usage?.cacheReadInputTokens ?? 0;
          totalCostUsd += response.costUsd ?? 0;
        }
        turns++;

        // Emit final metrics with correct turn count
        this.emit("usage", {
          inputTokens: totalIn,
          outputTokens: totalOut,
          cacheCreationInputTokens: cacheCreationIn,
          cacheReadInputTokens: cacheReadIn,
          totalCostUsd,
          turns,
          durationMs: Date.now() - startTime,
        } satisfies AgentSessionMetrics);

        // Fallback: emit final text if no streaming events were received
        if (!streamedText && response.text) {
          this.emit("text", response.text);
        }

        // Add assistant response to history
        this.messages.push({ role: "assistant", content: response.rawContent ?? response.text });

        // If no tool calls — task is done
        if (!response.toolCalls || response.toolCalls.length === 0) break;

        // Execute tool calls
        const toolResults = [];
        for (const tc of response.toolCalls) {
          this.emit("tool_call", tc.name, tc.input);
          const result = executeToolCall(tc.name, tc.input, this.opts.workingDir, this.abortController.signal);
          this.emit("tool_result", tc.name, result);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
        }

        this.messages.push({ role: "user", content: toolResults });
      }

      return {
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheCreationInputTokens: cacheCreationIn,
        cacheReadInputTokens: cacheReadIn,
        totalCostUsd,
        turns,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      // Re-throw with a name that reflects WHY we aborted. Without this,
      // timeouts surface as AbortError and get misclassified as user cancels.
      if (this.isAbortLikeError(err) && this._abortReason) {
        const mapped = new Error(this.abortMessage());
        (mapped as any).name = this._abortReason === "timeout" ? "TimeoutError" : "AbortError";
        (mapped as any).reason = this._abortReason;
        (mapped as any).cause = err;
        throw mapped;
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private isAbortLikeError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const name = (err as { name?: string }).name;
    return name === "AbortError" || name === "TimeoutError";
  }

  private abortMessage(): string {
    switch (this._abortReason) {
      case "timeout": return `Task timed out after ${this.opts.timeoutSeconds ?? "?"}s`;
      case "shutdown": return "Daemon shutting down — task will resume on next start";
      case "user": return "Cancelled by user";
      default: return "Task cancelled";
    }
  }

  abort(reason: AbortReason = "user") {
    // First call wins — preserves the true root cause (e.g. timeout) when a
    // later shutdown/user cancel hits the same session on its way down.
    if (this._abortReason === null) {
      this._abortReason = reason;
    }
    this.abortController.abort();
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [];
    const workDir = this.opts.workingDir ?? getFlockctlHome();

    // Core identity and behavior
    parts.push(`You are an autonomous software engineering agent with FULL permissions inside the project workspace.

WORKSPACE: ${workDir}
You operate EXCLUSIVELY within this directory. All file paths are relative to it.

PERMISSIONS — you have FULL access to:
- Read any file (Read tool)
- Write/create any file (Write tool)
- Edit any file in place (Edit tool)
- Run ANY shell command — npm, git, make, curl, etc. (Bash tool)
- Search code with regex (Grep tool)
- Find files by glob pattern (Glob tool)
- List directory contents (ListDir tool)

EXECUTION RULES:
1. ACT, don't describe. Never say "you should do X" — DO IT with your tools.
2. Never ask for permission. You already have unrestricted access within the workspace.
3. Never suggest manual steps. If something needs doing, do it yourself.
4. Chain actions: read → understand → edit → verify. Always verify changes (run tests, build, lint).
5. If a command fails, read the error, diagnose, and fix it. Retry with a corrected approach.
6. Install dependencies freely (npm install, pip install, etc.).
7. Create, delete, rename files and directories as needed.
8. Run git commands freely (commit, branch, diff, log, etc.).
9. Be concise in text output. Report what you DID, not what should be done.

SECURITY BOUNDARY:
- You MUST NOT access files or directories outside ${workDir}.
- All file operations are sandboxed to the workspace. Attempts to escape will be blocked.
- Do not write secrets, tokens, or credentials into files.

FLOCKCTL SKILL DIRECTORIES (NOT ~/.claude/):
- Global skills: ~/flockctl/skills/<skill-name>/SKILL.md
- Workspace skills: <workspace-path>/.flockctl/skills/<skill-name>/SKILL.md
- Project skills: <project-path>/.flockctl/skills/<skill-name>/SKILL.md
When creating or managing skills, ALWAYS use these Flockctl paths. NEVER use ~/.claude/skills/.

FLOCKCTL MCP DIRECTORIES:
- Global MCP configs: ~/flockctl/mcp/<server-name>.json
- Workspace MCP configs: <workspace-path>/.flockctl/mcp/<server-name>.json
- Project MCP configs: <project-path>/.flockctl/mcp/<server-name>.json
The project's .mcp.json is auto-managed by the reconciler — do NOT edit it directly. Create or modify MCP configs in .flockctl/mcp/ instead.`);

    // Codebase context
    if (this.opts.codebaseContext) {
      parts.push(`<codebase_context>\n${this.opts.codebaseContext}\n</codebase_context>`);
    }

    return parts.join("\n\n");
  }
}
