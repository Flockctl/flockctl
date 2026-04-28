import { EventEmitter } from "events";
import {
  getAgentTools,
  executeToolCall,
  parseAskUserQuestionInput,
  type ParsedAskUserQuestion,
} from "../agent-tools.js";
import { getAgent } from "../agents/registry.js";
import type { AgentProvider } from "../agents/types.js";
import {
  type PermissionMode,
  DEFAULT_PERMISSION_MODE,
  decideAuto,
  modeToSdkOptions,
  FILE_WRITE_TOOLS,
  READ_ONLY_TOOLS,
  denyIfTouchesSensitivePath,
} from "../permission-resolver.js";
import { emitAttentionChanged } from "../attention.js";
import { wsManager } from "../ws-manager.js";
import type {
  PermissionRequest,
  QuestionRequest,
  AgentSessionMetrics,
  AbortReason,
} from "./types.js";
import {
  buildAutonomousSystemPrompt,
  injectIncidents,
  injectStateMachines,
  injectWorkspaceProjects,
  injectAgentGuidance,
} from "./session-prompts.js";
import { resolveMcpServersForSession } from "./session-mcp.js";
import type { AgentSessionOptions } from "./session-options.js";

type PermissionResult = { behavior: "allow" } | { behavior: "deny"; message: string };

type PermissionEntry = {
  kind: "permission";
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
  createdAt: Date;
};

type QuestionEntry = {
  kind: "question";
  request: QuestionRequest;
  resolve: (answerText: string) => void;
  createdAt: Date;
};

type InteractiveEntry = PermissionEntry | QuestionEntry;

export class AgentSession extends EventEmitter {
  private abortController = new AbortController();
  private messages: Array<{ role: string; content: any }> = [];
  private opts: AgentSessionOptions;
  /**
   * Unified in-flight registry for blockers that need a UI-side decision:
   * permission requests (canUseTool) and free-form questions
   * (AskUserQuestion). Keyed by a session-scoped requestId. Keeping both in
   * one map removes the drift risk of two parallel maps/counters going out
   * of sync, and lets `resolvePermission` / `resolveQuestion` share a single
   * lookup path.
   */
  private pendingInteractive = new Map<string, InteractiveEntry>();
  private permissionCounter = 0;
  private questionCounter = 0;
  private _abortReason: AbortReason | null = null;
  /**
   * Live-mutable permission mode. Initialised from `opts.permissionMode`
   * at construction time and re-read by `canUseTool` on every invocation so
   * that mid-turn calls to `updatePermissionMode()` (e.g. user switches from
   * `default` → `bypassPermissions` while the agent is blocked on a
   * permission prompt) take effect without restarting the session.
   *
   * Caveat: the SDK-level `permissionMode` (`sdkOpts.permissionMode`) is
   * captured ONCE when `run()` calls `provider.chat()`, so a change that
   * moves OUT of `bypassPermissions` only affects the next turn (the
   * current `provider.chat` has already disabled `canUseTool` wiring). For
   * the common restrictive→permissive transition this is a non-issue
   * because `canUseTool` is already wired and observes the new mode.
   */
  private _permissionMode: PermissionMode;
  private _allowedRoots: string[];

  constructor(opts: AgentSessionOptions) {
    super();
    if (opts.taskId == null && opts.chatId == null) {
      throw new Error("AgentSession requires either taskId or chatId");
    }
    this.opts = opts;
    this._permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this._allowedRoots = opts.allowedRoots ?? [];
  }

  /** Current live permission mode — re-read on every canUseTool call. */
  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  /**
   * Mutate the session's permission mode mid-flight. No-ops when the new
   * mode equals the current one (avoids spurious UI refreshes). After the
   * swap, walks every pending permission entry and auto-resolves the ones
   * the new mode would have allowed:
   *
   * - `bypassPermissions` → allow every pending request unconditionally.
   * - `acceptEdits`       → allow pending requests for file-write tools
   *                         (Write/Edit/MultiEdit/NotebookEdit); leave
   *                         the rest pending for user decision.
   * - `auto`              → re-run `decideAuto()` against the stored
   *                         allowed roots; allow on "allow", leave the
   *                         rest pending.
   * - `default` / `plan`  → no pending entries are auto-resolved; future
   *                         tool requests still prompt.
   *
   * Emits `permission_mode_changed` exactly once on a real transition.
   */
  updatePermissionMode(mode: PermissionMode): void {
    const previous = this._permissionMode;
    if (previous === mode) return;
    this._permissionMode = mode;
    this.emit("permission_mode_changed", { previous, current: mode });
    this.autoResolvePendingForMode(mode);
  }

  /**
   * Walk the pending-permission entries and resolve those that the given
   * `mode` would auto-approve. Each resolution removes the entry from the
   * pending map and fires the original `resolve` with `{ behavior: "allow" }`
   * — the permission handler inside `canUseTool` echoes `updatedInput` back
   * to the SDK, so the agent resumes as if the user clicked allow.
   *
   * Emits a single `attention_changed` broadcast at the end so sidebar
   * badges refresh once per swap, matching the invariant enforced by
   * `attention-broadcast.test.ts`.
   */
  private autoResolvePendingForMode(mode: PermissionMode): void {
    if (mode !== "bypassPermissions" && mode !== "acceptEdits" && mode !== "auto") {
      return;
    }
    const toResolve: PermissionEntry[] = [];
    for (const entry of this.pendingInteractive.values()) {
      if (entry.kind !== "permission") continue;
      if (mode === "bypassPermissions") {
        toResolve.push(entry);
      } else if (mode === "acceptEdits") {
        if (FILE_WRITE_TOOLS.has(entry.request.toolName)) toResolve.push(entry);
      } else if (mode === "auto") {
        const decision = decideAuto(
          entry.request.toolName,
          entry.request.toolInput,
          this._allowedRoots,
        );
        if (decision.behavior === "allow") toResolve.push(entry);
      }
    }
    if (toResolve.length === 0) return;
    for (const entry of toResolve) {
      this.pendingInteractive.delete(entry.request.requestId);
      entry.resolve({ behavior: "allow" });
      // Surface the auto-resolution to the executor so it can broadcast a
      // `permission_resolved` WS frame — otherwise the UI pending-card for
      // this request would stay on screen until the next page reload.
      this.emit("permission_auto_resolved", entry.request.requestId);
    }
    emitAttentionChanged(wsManager);
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
   * Resolve a pending permission request from the UI. Returns false when
   * `requestId` is unknown or refers to a non-permission entry (e.g. a
   * question) — callers can treat both as "the UI raced the session".
   */
  resolvePermission(requestId: string, result: PermissionResult): boolean {
    const entry = this.pendingInteractive.get(requestId);
    if (!entry || entry.kind !== "permission") return false;
    this.pendingInteractive.delete(requestId);
    entry.resolve(result);
    emitAttentionChanged(wsManager);
    return true;
  }

  /**
   * Resolve a pending AskUserQuestion from the UI. `answerText` is relayed
   * back to the model verbatim as the tool_result content. Returns false
   * when `requestId` is unknown or refers to a non-question entry.
   */
  resolveQuestion(requestId: string, answerText: string): boolean {
    const entry = this.pendingInteractive.get(requestId);
    if (!entry || entry.kind !== "question") return false;
    this.pendingInteractive.delete(requestId);
    entry.resolve(answerText);
    return true;
  }

  /** Number of permission requests currently awaiting a UI response. */
  get pendingPermissionCount(): number {
    let n = 0;
    for (const entry of this.pendingInteractive.values()) {
      if (entry.kind === "permission") n++;
    }
    return n;
  }

  /** Snapshot of every permission request currently awaiting a UI response. */
  pendingPermissionRequests(): PermissionRequest[] {
    return this.filterInteractive("permission").map((e) => e.request);
  }

  /**
   * Snapshot of every permission request currently awaiting a UI response,
   * paired with the time it was created. Used by the attention aggregator to
   * sort blockers by recency.
   */
  pendingPermissionEntries(): Array<{ request: PermissionRequest; createdAt: Date }> {
    return this.filterInteractive("permission").map((e) => ({
      request: e.request,
      createdAt: e.createdAt,
    }));
  }

  /** Snapshot of every AskUserQuestion currently awaiting a UI response. */
  pendingQuestionRequests(): QuestionRequest[] {
    return this.filterInteractive("question").map((e) => e.request);
  }

  private filterInteractive<K extends InteractiveEntry["kind"]>(
    kind: K,
  ): Array<Extract<InteractiveEntry, { kind: K }>> {
    const out: Array<Extract<InteractiveEntry, { kind: K }>> = [];
    for (const entry of this.pendingInteractive.values()) {
      if (entry.kind === kind) {
        out.push(entry as Extract<InteractiveEntry, { kind: K }>);
      }
    }
    return out;
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
    const baseSystemPrompt =
      this.opts.systemPromptOverride ??
      buildAutonomousSystemPrompt(this.opts.workingDir, this.opts.codebaseContext);
    // Single seam for context injection — mirrors how skills used to be
    // appended to the system prompt (the seam itself survived the migration
    // to progressive disclosure). Past-incident retrieval and state-machine
    // registry injection both ride this path so task and chat sessions pick
    // them up uniformly without every caller having to remember to stitch
    // them in.
    const logPrefix = this.sessionPrefix();
    const withIncidents = injectIncidents(
      baseSystemPrompt,
      this.opts.prompt,
      this.opts.codebaseContext,
      this.opts.projectId,
      logPrefix,
    );
    const withSM = injectStateMachines(
      withIncidents,
      this.opts.touchedFiles,
      this.opts.smRegistry,
      logPrefix,
    );
    const withWP = injectWorkspaceProjects(withSM, this.opts.workspaceContext);
    const systemPrompt = await injectAgentGuidance(
      withWP,
      this.opts.workingDir,
      this.opts.workspaceContext?.path ?? null,
      logPrefix,
    );
    let totalIn = 0, totalOut = 0;
    let cacheCreationIn = 0, cacheReadIn = 0;
    let totalCostUsd = 0;
    let turns = 0;
    const startTime = Date.now();

    // SDK options captured at turn start — the SDK's own `permissionMode`
    // is fixed for the duration of this `provider.chat` call. Live mode
    // changes land on `this._permissionMode` and are re-read inside
    // `canUseTool` below, so any mid-turn swap still takes effect for
    // subsequent tool prompts (that's the whole point of variant B).
    const sdkOpts = modeToSdkOptions(this._permissionMode);

    // Resolve MCP servers ONCE per session (flockctl precedence:
    // project > workspace > global from ~/flockctl/mcp/). The Claude Agent
    // SDK does not auto-read a project's `.mcp.json` — unlike the interactive
    // `claude` CLI — so we MUST forward servers explicitly or `mcp__*` tools
    // never reach the agent. Resolver is cheap (a few FS reads + one DB
    // lookup) but doing it once outside the agentic loop avoids re-hitting
    // disk on every turn. Non-Claude-Code providers ignore the field.
    const mcpServers = resolveMcpServersForSession(this.opts.projectId, logPrefix);

    // Permission handler — relays tool permission requests to the UI,
    // short-circuiting based on the CURRENT (live-mutable) mode so a
    // `updatePermissionMode("bypassPermissions")` mid-turn unblocks every
    // future tool call in the same turn, not just the next one.
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
      // Hard path denylist — runs BEFORE mode dispatch so it applies even
      // when the user escalated to `bypassPermissions` / `acceptEdits` /
      // `plan`. Covers `.mcp.json` (plaintext-substituted MCP config),
      // the master encryption key, and the SQLite database. See
      // `permission-resolver.ts` for the full list and rationale.
      const denial = denyIfTouchesSensitivePath(toolName, input, this._allowedRoots);
      if (denial.denied) {
        return { behavior: "deny", message: denial.reason! };
      }

      const currentMode = this._permissionMode;
      if (currentMode === "bypassPermissions") {
        return { behavior: "allow", updatedInput: input };
      }
      if (currentMode === "acceptEdits") {
        // SDK previously auto-approved reads in this mode; now that we wire
        // canUseTool for every mode (to enforce the denylist), we must also
        // emulate the read-through here or Read would fall into the
        // interactive prompt path and regress UX.
        if (FILE_WRITE_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
      }
      if (currentMode === "plan") {
        // SDK enforces no-writes in plan mode (edits rejected before
        // canUseTool fires), so anything that reaches the handler is safe to
        // auto-allow once the denylist has cleared.
        if (READ_ONLY_TOOLS.has(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
      }
      if (currentMode === "auto") {
        const decision = decideAuto(toolName, input, this._allowedRoots);
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
          this.pendingInteractive.delete(requestId);
          emitAttentionChanged(wsManager);
          resolve({ behavior: "deny", message: "Task cancelled" });
        };
        if (this.abortController.signal.aborted) {
          resolve({ behavior: "deny", message: "Task cancelled" });
          return;
        }
        this.abortController.signal.addEventListener("abort", onAbort, { once: true });

        this.pendingInteractive.set(requestId, {
          kind: "permission",
          request,
          createdAt: new Date(),
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
        emitAttentionChanged(wsManager);
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
          providerKeyValue: this.opts.providerKeyValue,
          mcpServers,
          ...(this.opts.thinkingEnabled !== undefined && { thinkingEnabled: this.opts.thinkingEnabled }),
          ...(this.opts.effort !== undefined && { effort: this.opts.effort }),
          ...(sdkOpts.useCanUseTool ? { canUseTool } : {}),
          // Hook AskUserQuestion through the bridge so providers that run
          // tools inside the SDK subprocess (Claude Code) route question
          // requests back into our `pendingInteractive` flow. For providers
          // that surface tool calls via `response.toolCalls` (Copilot et al.)
          // the bridge is unused — `session.ts:606` still owns that path.
          askUserQuestionHandler: (parsed, toolUseId) => this.awaitUserAnswer(toolUseId, parsed),
          onEvent: (event) => {
            if (event.type === "text") {
              streamedText = true;
              this.emit("text", event.content);
            } else if (event.type === "thinking") {
              this.emit("thinking", event.content as string);
            } else if (event.type === "tool_call") {
              // Third arg carries the SDK's `parent_tool_use_id` attribution:
              // null for the main agent's calls, a `toolu_…` id for any
              // sub-agent spawned via the Task tool. Downstream listeners
              // (chat-executor, task-executor) read this off the third slot
              // and forward it into recordTodoWrite so chat_todos can pivot
              // the history into one per-agent timeline.
              //
              // Fourth arg is the SDK-assigned id of THIS tool_use block —
              // forwarded so chat-executor can persist it in chat_messages
              // content JSON. The /chats/:id/todos/agents route then joins
              // chat_todos.parent_tool_use_id back to the spawning Task call's
              // tool_use_id to recover the sub-agent's `description` for the
              // tab label.
              this.emit(
                "tool_call",
                event.toolName ?? "unknown",
                event.content,
                event.parentToolUseId ?? null,
                event.toolUseId ?? null,
              );
            } else if (event.type === "tool_result") {
              this.emit("tool_result", event.toolName ?? "", event.content);
            } else if (event.type === "turn_end") {
              this.emit("turn_end");
            } else if (event.type === "session_id") {
              // Eagerly propagate the SDK's session_id as soon as it's known —
              // normally from the first assistant/system message of the turn,
              // well before the terminal `result`. Downstream listeners (chat
              // routes) persist it to `chats.claudeSessionId` so chat-resume
              // survives a mid-turn daemon shutdown (`make reinstall`, client
              // disconnect, aborted run). The post-turn emit below then becomes
              // a no-op because `currentSessionId` is already up-to-date.
              const sid = event.content as string;
              if (sid && sid !== currentSessionId) {
                currentSessionId = sid;
                this.emit("session_id", sid);
              }
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

        // Mark the end of this assistant turn. Provider-agnostic boundary —
        // fires once per agentic-loop iteration regardless of which provider
        // handled the turn. For Claude Code, ai-client.ts already emits
        // `turn_end` per SDK assistant message during the stream (the
        // finer-grained source of truth); this trailing emit is then a
        // harmless no-op because `pendingText` on the consumer side is
        // already empty. For GitHub Copilot, whose `chat()` emits the full
        // turn text as one block at the end and never emits its own
        // `turn_end`, THIS is the only boundary that prevents consecutive
        // text-only turns from merging into one `chat_messages` row on
        // reload — i.e. what keeps Copilot chats on par with Claude Code's
        // per-message rendering.
        this.emit("turn_end");

        // If no tool calls — task is done
        if (!response.toolCalls || response.toolCalls.length === 0) break;

        // Execute tool calls. AskUserQuestion is special-cased: instead of
        // running through executeToolCall (which throws — see agent-tools.ts),
        // we open a pending question, wait for the UI to call
        // resolveQuestion, and feed the answer back as the tool_result.
        const toolResults = [];
        for (const tc of response.toolCalls) {
          // Non-streaming providers (Copilot, etc.) have no sub-agent
          // mechanism — the Task tool is Claude-Agent-SDK-only and only
          // surfaces in the streaming `onEvent` branch above. Pass null as
          // the parentToolUseId so listeners see "main agent" attribution.
          this.emit("tool_call", tc.name, tc.input, null, tc.id ?? null);
          let result: string;
          if (tc.name === "AskUserQuestion") {
            // Strict-validate the input through the shared Zod schema. On
            // failure we relay an error string back to the agent as the
            // tool_result content (mirrors the convention in
            // executeToolCall — invalid inputs surface as `Error: …`
            // strings, never as thrown exceptions that would crash the
            // agentic loop) and DO NOT emit a question_request event, so
            // no `agent_questions` row is written and no UI block is shown.
            const parsed = parseAskUserQuestionInput(tc.input);
            if (!parsed.ok) {
              const issues = parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ");
              const msg = `Error: invalid AskUserQuestion input — ${issues}`;
              console.error(`[agent-session] ${this.sessionPrefix()} AskUserQuestion validation failed: ${issues}`);
              result = msg;
            } else {
              result = await this.awaitUserAnswer(tc.id, parsed.value);
            }
          } else {
            result = executeToolCall(tc.name, tc.input, this.opts.workingDir, this.abortController.signal);
          }
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

  /**
   * Open a pending question, emit `question_request`, and resolve with the
   * answer text once the UI calls `resolveQuestion(requestId, answerText)`.
   * On abort, resolves with a placeholder so the agentic loop can still
   * build a valid tool_result and unwind cleanly.
   *
   * `parsed` is the post-validation `AskUserQuestion` payload — `options`
   * (already-empty arrays dropped by the parser), `multi_select` (defaults
   * to false), and `header` ride into the `QuestionRequest` so executors
   * persist the structured shape and WS subscribers see it on the
   * `agent_question` frame.
   */
  private awaitUserAnswer(toolUseID: string, parsed: ParsedAskUserQuestion): Promise<string> {
    return new Promise<string>((resolve) => {
      const requestId = `q-${this.sessionPrefix()}-${++this.questionCounter}`;
      const request: QuestionRequest = {
        requestId,
        question: parsed.question,
        toolUseID,
        // `options` is omitted when absent (free-form) so consumers can
        // distinguish "no options" from "empty options" without re-checking
        // length. The parser already drops `[]` to undefined for us.
        ...(parsed.options ? { options: parsed.options } : {}),
        multiSelect: parsed.multi_select ?? false,
        ...(parsed.header ? { header: parsed.header } : {}),
      };

      const onAbort = () => {
        this.pendingInteractive.delete(requestId);
        resolve("(question cancelled)");
      };
      if (this.abortController.signal.aborted) {
        resolve("(question cancelled)");
        return;
      }
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });

      this.pendingInteractive.set(requestId, {
        kind: "question",
        request,
        createdAt: new Date(),
        resolve: (answerText: string) => {
          this.abortController.signal.removeEventListener("abort", onAbort);
          resolve(answerText);
        },
      });
      this.emit("question_request", request);
    });
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
}
