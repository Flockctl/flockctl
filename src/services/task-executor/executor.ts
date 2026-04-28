import { AgentSession } from "../agent-session/index.js";
import type { AgentSessionMetrics, PermissionRequest, QuestionRequest } from "../agent-session/index.js";
import { getDb } from "../../db/index.js";
import { tasks, taskLogs, chats } from "../../db/schema.js";
import { and, eq } from "drizzle-orm";
import { recordTodoWrite } from "../todo-store.js";
import { wsManager } from "../ws-manager.js";
import type { KeySelection } from "../ai/key-selection.js";
import { reconcileClaudeSkillsForProject } from "../claude/skills-sync.js";
import { reconcileMcpForProject } from "../claude/mcp-sync.js";
import { formatToolCall, formatToolResult } from "../tool-format.js";
import { TaskStatus } from "../../lib/types.js";
import { broadcastPermissionRequest } from "../agent-interaction.js";
import { checkBudget } from "../budget.js";
import { syncPlan } from "./helpers.js";
import {
  buildEntriesFromToolCall,
  parseJournal,
  type FileEditJournal,
} from "../file-edit-journal.js";
import { KeyPool } from "./executor-key-pool.js";
import { saveUsage } from "./executor-usage.js";
import { resetStaleTasks as resetStaleTasksImpl } from "./executor-stale.js";
import {
  findPendingQuestionRow,
  handleQuestionEmitted as handleQuestionEmittedImpl,
  listPendingQuestions,
  resolveQuestionCold,
  resolveQuestionHot,
} from "./executor-questions.js";
import { buildTaskRunContext } from "./executor-setup.js";
import {
  classifyRunError,
  finalizeError,
  finalizeSuccess,
  scheduleRetry,
} from "./executor-finalize.js";
import { classifyLimit } from "../agents/rate-limit-classifier.js";
import { rateLimitScheduler } from "../agents/rate-limit-scheduler.js";

export class TaskExecutor {
  private sessions = new Map<number, AgentSession>();
  private runningMetrics = new Map<number, AgentSessionMetrics>();
  private pool = new KeyPool();
  private queue: number[] = [];
  /** Set during graceful shutdown so in-flight aborts are recognized as restart-induced
   *  and don't mark tasks as cancelled — resetStaleTasks re-queues them on next boot. */
  private shuttingDown = false;

  constructor() {
    // Wire up the rate-limit scheduler so a parked task wakes up with a fresh
    // session created from the same `claudeSessionId`. Done in the constructor
    // so the singleton at module bottom is reachable from any caller — the
    // bootstrap recovery in server-entry.ts only has to call
    // `rateLimitScheduler.recoverFromDatabase()` and the handler is already
    // attached.
    rateLimitScheduler.registerHandler("task", (taskId: number) =>
      this.resumeFromRateLimit(taskId),
    );
  }

  /** Compatibility setter used by tests; now interpreted as per-key capacity. */
  setMaxConcurrent(n: number) {
    this.pool.setMax(n);
  }

  async execute(taskId: number): Promise<void> {
    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    let reservation: { key: KeySelection | null; enqueue: boolean };
    try {
      reservation = await this.pool.reserveForTask(taskId, task);
    } catch (err: any) {
      /* v8 ignore next — defensive: reserveForTask always throws an Error with
       * a message; the `String(err)` RHS is unreachable in practice. */
      this.failBeforeStart(taskId, err.message ?? String(err));
      syncPlan(taskId);
      return;
    }

    if (reservation.enqueue) {
      this.enqueue(taskId);
      return;
    }

    try {
      await this._run(taskId, reservation.key);
    } finally {
      this.pool.release(taskId);
      this._processQueue();
    }
  }

  private enqueue(taskId: number): void {
    if (!this.queue.includes(taskId)) {
      this.queue.push(taskId);
    }
  }

  private failBeforeStart(taskId: number, message: string): void {
    const db = getDb();
    db.update(tasks)
      .set({ status: TaskStatus.FAILED, errorMessage: message, completedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    wsManager.broadcastTaskStatus(taskId, TaskStatus.FAILED);
  }

  private async _run(taskId: number, selectedKey: KeySelection | null): Promise<void> {
    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    // Mark as running immediately — before any async preparation
    db.update(tasks)
      .set({ status: TaskStatus.RUNNING, startedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();

    wsManager.broadcastTaskStatus(taskId, TaskStatus.RUNNING);

    const budgetResult = checkBudget(task.projectId);
    if (!budgetResult.allowed) {
      const reasons = budgetResult.exceededLimits
        .filter(e => e.action === "pause")
        .map(e => `${e.scope} ${e.period}: $${e.spentUsd.toFixed(2)}/$${e.limitUsd.toFixed(2)}`)
        .join("; ");

      db.update(tasks)
        .set({
          status: TaskStatus.FAILED,
          errorMessage: `Budget exceeded: ${reasons}`,
          completedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId))
        .run();

      wsManager.broadcastTaskStatus(taskId, TaskStatus.FAILED);
      syncPlan(taskId);
      return;
    }

    const warnings = budgetResult.exceededLimits.filter(e => e.action === "warn");
    if (warnings.length > 0) {
      const msg = warnings.map(e => `${e.scope} ${e.period}: $${e.spentUsd.toFixed(2)}/$${e.limitUsd.toFixed(2)}`).join("; ");
      this.appendLog(taskId, `⚠️ Budget warning: ${msg}`, "stderr");
    }

    // Reconcile .claude/skills/ and .mcp.json for the project before we start
    // the session — progressive disclosure and MCP auto-discovery both require
    // these files to exist on disk at session launch.
    if (task.projectId) {
      try {
        reconcileClaudeSkillsForProject(task.projectId);
        reconcileMcpForProject(task.projectId);
      } catch (err) {
        console.error(`[task-executor] reconcile for project ${task.projectId} failed:`, err);
      }
    }

    let ctx;
    try {
      ctx = await buildTaskRunContext(task, selectedKey);
    } catch (err: any) {
      db.update(tasks)
        .set({ status: TaskStatus.FAILED, errorMessage: err.message, completedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId))
        .run();
      wsManager.broadcastTaskStatus(taskId, TaskStatus.FAILED);
      syncPlan(taskId);
      return;
    }

    // Update assigned key now that selection is done
    if (selectedKey?.id) {
      db.update(tasks)
        .set({ assignedKeyId: selectedKey.id })
        .where(eq(tasks.id, taskId))
        .run();
    }

    const session = new AgentSession({
      taskId,
      prompt: ctx.prompt,
      model: ctx.model,
      codebaseContext: ctx.codebaseCtx,
      workingDir: ctx.workingDir,
      timeoutSeconds: ctx.timeout,
      configDir: selectedKey?.configDir ?? undefined,
      agentId: ctx.agentId,
      permissionMode: ctx.permissionMode,
      allowedRoots: ctx.allowedRoots,
      resumeSessionId: task.claudeSessionId ?? undefined,
      projectId: task.projectId ?? null,
      providerKeyValue: selectedKey?.keyValue ?? undefined,
      workspaceContext: ctx.workspaceContext,
    });

    this.sessions.set(taskId, session);

    // Tasks can be entity-linked to a chat (entity_type='task', entity_id=<taskId>);
    // when they are, TodoWrite snapshots from the task session project into
    // that chat's chat_todos timeline. Without a backing chat, the NOT NULL
    // chat_id column means we can't persist, so we skip silently.
    const backingChat = db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.entityType, "task"), eq(chats.entityId, String(taskId))))
      .get();
    const backingChatId: number | null = backingChat?.id ?? null;

    // File-edit journal — accumulates { filePath, original, current } for
    // every Edit/Write/MultiEdit call so `GET /tasks/:id/diff` can synthesize
    // a session-isolated unified diff later. See file-edit-journal.ts for
    // why this replaces the former `git diff` flow. Held in memory for the
    // run and flushed once at the end; no per-call DB write to avoid
    // contention on the tasks row.
    const fileEditJournal: FileEditJournal = parseJournal(task.fileEdits);

    this._wireSessionEvents(taskId, session, fileEditJournal, backingChatId);

    try {
      const result = await session.run();
      saveUsage({
        taskId,
        projectId: task.projectId,
        aiProviderKeyId: selectedKey?.id ?? null,
        keyProvider: selectedKey?.provider ?? null,
        model: ctx.model,
        metrics: result,
      });

      finalizeSuccess({
        taskId,
        workingDir: ctx.workingDir,
        gitCommitBefore: ctx.gitCommitBefore,
        fileEditJournal,
        requiresApproval: ctx.requiresApproval,
      });
    } catch (err: any) {
      // Graceful shutdown aborts running sessions — leave the task's status as
      // RUNNING so resetStaleTasks re-queues it on next startup (where it will
      // resume via the persisted claudeSessionId).
      const isShutdown = err.reason === "shutdown" || (this.shuttingDown && err.name === "AbortError");
      if (isShutdown) {
        return;
      }

      // Provider rate-limit / usage-limit detection. If the error matches the
      // classifier (Anthropic 429, Pro/Max usage cap, Copilot quota), we PARK
      // the task in `rate_limited` and arm a wake-up timer instead of failing
      // it. The persisted `claudeSessionId` lets the scheduled resume continue
      // the same SDK conversation. See rate-limit-classifier.ts for the full
      // shape and rate-limit-scheduler.ts for the wake-up handler. This block
      // MUST run before classifyRunError() — otherwise a 429 would be
      // classified as a generic FAILED and trigger scheduleRetry, defeating
      // the pause-and-resume behavior.
      const limit = classifyLimit(err);
      if (limit) {
        this.parkRateLimited(taskId, limit.resumeAtMs, limit.rawMessage);
        return;
      }

      const status = classifyRunError(err);
      const logPrefix = status === TaskStatus.CANCELLED ? "Cancelled"
                      : status === TaskStatus.TIMED_OUT ? "Timed out"
                      : "Failed";
      // Abort/timeout messages already describe the cause; stack only adds noise.
      /* v8 ignore next — defensive: Error objects in V8 always carry a `.stack`
       * string, so the `err.message` RHS is unreachable in practice. */
      const logBody = status === TaskStatus.FAILED ? (err.stack ?? err.message) : err.message;
      this.appendLog(taskId, `${logPrefix}: ${logBody}`, "stderr");

      finalizeError({ taskId, status, errorMessage: err.message });

      // Auto-retry
      if (status === TaskStatus.FAILED) {
        const newTaskId = scheduleRetry(taskId);
        if (newTaskId !== null) {
          setTimeout(() => this.execute(newTaskId), 0);
        }
      }
    } finally {
      this.sessions.delete(taskId);
      this.runningMetrics.delete(taskId);
    }
  }

  private _wireSessionEvents(
    taskId: number,
    session: AgentSession,
    fileEditJournal: FileEditJournal,
    backingChatId: number | null,
  ): void {
    const db = getDb();

    session.on("text", (chunk: string) => {
      this.appendLog(taskId, chunk, "stdout");
    });
    session.on("tool_call", (
      name: string,
      input: any,
      parentToolUseId: string | null = null,
      // toolUseId is accepted for signature parity with chat-executor (the
      // session emits a 4th arg). Tasks don't persist tool calls into
      // chat_messages, so we don't store it — the per-agent tab label for
      // a task-backed sub-agent falls back to a synthesised name in the
      // /chats/:id/todos/agents route when no spawning Task message can be
      // resolved.
      _toolUseId: string | null = null,
    ) => {
      this.appendLog(taskId, formatToolCall(name, input), "tool_call");
      // recordTodoWrite handles the WS broadcast internally (only after a
      // successful insert — dedup hits stay silent). Keep the call here
      // purely for the DB-projection side effect.
      //
      // `parentToolUseId` flows in from the SDK (null for the main agent,
      // a `toolu_…` id for any sub-agent spawned via the Task tool). The
      // chat_todos projection keys on it so the per-agent tabs UI can
      // split the timeline cleanly even when a task is the conduit.
      if (name === "TodoWrite" && backingChatId !== null) {
        recordTodoWrite({ chatId: backingChatId, taskId, parentToolUseId, input });
      }
      const newEntries = buildEntriesFromToolCall(name, input);
      if (newEntries.length > 0) {
        fileEditJournal.entries.push(...newEntries);
      }
    });
    session.on("tool_result", (name: string, output: string) => {
      this.appendLog(taskId, formatToolResult(name, output), "tool_result");
    });
    session.on("error", (err: Error) => {
      this.appendLog(taskId, `ERROR: ${err.message}`, "stderr");
    });
    session.on("session_id", (sessionId: string) => {
      db.update(tasks)
        .set({ claudeSessionId: sessionId })
        .where(eq(tasks.id, taskId))
        .run();
    });
    session.on("permission_request", (request: PermissionRequest) => {
      this.appendLog(taskId, `🔐 Permission request: ${request.title ?? request.toolName}`, "permission");
      broadcastPermissionRequest({ kind: "task", id: taskId }, request);
    });
    // Agent-emitted clarification question (AskUserQuestion tool). Persist a
    // row and flip the task to waiting_for_input so the UI can surface the
    // block and so cost/concurrency accounting stops for the idle interval.
    // The row is created idempotently on `request_id` — any retry of the
    // same emitter ID is swallowed by the UNIQUE constraint and logged.
    session.on("question_request", (request: QuestionRequest) => {
      this.handleQuestionEmitted(taskId, request);
    });
    session.on("usage", (metrics: AgentSessionMetrics) => {
      this.runningMetrics.set(taskId, metrics);
      wsManager.broadcast(taskId, {
        type: "task_metrics",
        payload: {
          task_id: String(taskId),
          input_tokens: metrics.inputTokens,
          output_tokens: metrics.outputTokens,
          cache_creation_tokens: metrics.cacheCreationInputTokens,
          cache_read_tokens: metrics.cacheReadInputTokens,
          total_cost_usd: metrics.totalCostUsd,
          turns: metrics.turns,
          duration_ms: metrics.durationMs,
        },
      });
    });
  }

  cancel(taskId: number): boolean {
    // Remove from queue if waiting
    const qIdx = this.queue.indexOf(taskId);
    if (qIdx !== -1) this.queue.splice(qIdx, 1);

    // Tear down a pending rate-limit wake-up too — without this, a task
    // cancelled during pause would still get resumed when the timer fires
    // minutes later. cancel() is idempotent so calling for an unscheduled
    // task is a no-op (matches the queue-removal contract above).
    rateLimitScheduler.cancel("task", taskId);

    const session = this.sessions.get(taskId);
    if (session) {
      session.abort("user");
      return true;
    }
    return false;
  }

  /**
   * Park a task that was just hit with a provider rate-limit / usage-limit.
   * Persists the new status and `resume_at`, broadcasts via WS so the UI can
   * show the countdown immediately, and arms the wake-up timer.
   *
   * No file-edit-journal flush here — the in-flight session never reached a
   * tool boundary that would have populated the journal (the limit error is
   * thrown from inside the SDK stream loop before any tool executes); for
   * tasks that DID make edits before the failure, those were already persisted
   * by the per-call `tool_call` listener in `_wireSessionEvents`.
   */
  private parkRateLimited(taskId: number, resumeAtMs: number, errorMessage: string): void {
    const db = getDb();
    db.update(tasks)
      .set({
        status: TaskStatus.RATE_LIMITED,
        resumeAt: resumeAtMs,
        errorMessage,
      })
      .where(eq(tasks.id, taskId))
      .run();
    // Broadcast snake_case `resume_at` to match the HTTP response shape (the
     // UI's apiFetch converter spits out snake_case; WS frames bypass that
     // converter so we have to match by hand).
    wsManager.broadcastTaskStatus(taskId, TaskStatus.RATE_LIMITED, {
      resume_at: resumeAtMs,
    });
    this.appendLog(
      taskId,
      `⏸ Rate limit hit — task parked, will resume at ${new Date(resumeAtMs).toISOString()}`,
      "stderr",
    );
    rateLimitScheduler.schedule({ kind: "task", id: taskId, resumeAtMs });
    syncPlan(taskId);
  }

  /**
   * Wake-up handler invoked by the rate-limit scheduler. Flips the parked
   * task back to `queued` (the `claudeSessionId` is preserved on the row, so
   * `_run()` will pass it as `resumeSessionId` to the new AgentSession),
   * clears `resumeAt`, then dispatches via the normal execute() path. If the
   * limit is still in force, the next failure will park it again with an
   * escalated `resumeAt` (the classifier's MIN/MAX lattice handles this; the
   * scheduler does not need to track attempt count itself because each park
   * call simply replaces the prior timer).
   *
   * Cancellation safety: a user DELETE during pause flips the task to
   * `cancelled`. This handler MUST refuse to resume a cancelled row — the
   * scheduler's own cancel() also tears down the timer when the route runs,
   * but a tiny race window exists where the timer fires between the DB write
   * and the cancel() call. The status guard below closes that.
   */
  private async resumeFromRateLimit(taskId: number): Promise<void> {
    const db = getDb();
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) return;
    if (row.status !== TaskStatus.RATE_LIMITED) {
      // Status changed under us (cancel race / manual DB edit / second timer)
      // — leave the row alone.
      return;
    }
    db.update(tasks)
      .set({ status: TaskStatus.QUEUED, resumeAt: null, errorMessage: null })
      .where(eq(tasks.id, taskId))
      .run();
    wsManager.broadcastTaskStatus(taskId, TaskStatus.QUEUED);
    this.appendLog(taskId, `▶ Resuming after rate-limit pause`, "stdout");
    void this.execute(taskId);
  }

  private handleQuestionEmitted(taskId: number, request: QuestionRequest): void {
    handleQuestionEmittedImpl(taskId, request);
    this.appendLog(taskId, `❓ Question: ${request.question}`, "question");
  }

  /**
   * Answer a pending agent question. UPDATEs the row, relays the answer to
   * the live session (which unblocks the agentic loop), and flips the task
   * back to `running`. Returns false when `requestId` is unknown or already
   * answered/cancelled — callers can treat that as "the UI raced us".
   */
  answerQuestion(taskId: number, requestId: string, answer: string): boolean {
    const row = findPendingQuestionRow(taskId, requestId);
    if (!row) return false;

    const session = this.sessions.get(taskId);
    if (session) {
      // Hot path: session is still in memory — hand the answer straight to
      // the agentic loop, which unblocks inside awaitUserAnswer().
      const ok = session.resolveQuestion(requestId, answer);
      if (!ok) return false;

      resolveQuestionHot(taskId, row, requestId, answer);
      return true;
    }

    // Cold path: daemon restarted after the question was emitted. The old
    // in-memory session is gone, so we cannot resolveQuestion() against it.
    // Persist the answer, flip the task back to queued, and kick off a fresh
    // session — the resumeSessionId flow replays the prior Claude Code
    // session (which saw the AskUserQuestion tool_use) and continues from
    // there. The answer text is preserved on the agent_questions row so the
    // UI can still show it in history.
    if (!resolveQuestionCold(taskId, row, requestId, answer)) return false;
    // Fire-and-forget: the returned Promise resolves when the resumed
    // session completes. Errors are logged inside _run.
    void this.execute(taskId);
    return true;
  }

  /**
   * Pending questions awaiting a UI answer for this task, oldest-first.
   *
   * Mirrors `chat-executor.pendingQuestions` shape — including the parsed
   * `options` JSON, `multiSelect`, and `header` so the task page can render
   * the same single/multi-select picker the inbox renders. Without those
   * fields the UI fell back to a text-only input even when the row had
   * structured options (see `executor-questions.ts:listPendingQuestions`
   * for the full rationale).
   */
  pendingQuestions(taskId: number): Array<{
    id: number;
    requestId: string;
    question: string;
    toolUseId: string;
    createdAt: string | null;
    options: Array<{ label: string; description?: string; preview?: string }> | null;
    multiSelect: boolean;
    header: string | null;
  }> {
    return listPendingQuestions(taskId);
  }

  /**
   * Resolve a pending permission request from the UI.
   */
  resolvePermission(taskId: number, requestId: string, result: { behavior: "allow" } | { behavior: "deny"; message: string }): boolean {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    return session.resolvePermission(requestId, result);
  }

  isRunning(taskId: number): boolean {
    return this.sessions.has(taskId);
  }

  /** Full pending permission requests awaiting a UI response for this task. */
  pendingPermissions(taskId: number): PermissionRequest[] {
    const session = this.sessions.get(taskId);
    return session ? session.pendingPermissionRequests() : [];
  }

  /** Iterable of `[taskId, session]` for every in-flight task session. Used
   *  by the attention aggregator to surface pending permission requests. */
  activeSessions(): IterableIterator<[number, AgentSession]> {
    return this.sessions.entries();
  }

  getMetrics(taskId: number): AgentSessionMetrics | null {
    return this.runningMetrics.get(taskId) ?? null;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  cancelAll(): void {
    this.shuttingDown = true;
    for (const [, session] of this.sessions) {
      session.abort("shutdown");
    }
    this.queue.length = 0;
    // Tear down rate-limit wake-up timers so the daemon can exit cleanly.
    // The persisted `tasks.resume_at` survives — `recoverFromDatabase()`
    // re-arms timers on the next boot from those rows.
    rateLimitScheduler.cancelAll();
  }

  private appendLog(taskId: number, content: string, streamType: string) {
    const db = getDb();
    let insertId: string;
    try {
      const result = db.insert(taskLogs).values({ taskId, content, streamType }).run();
      insertId = String(result.lastInsertRowid);
    } catch (err) {
      /* v8 ignore next — defensive: better-sqlite3 always throws an Error
       * subclass; the `String(err)` RHS is unreachable in practice. */
      console.error("Failed to insert task log:", err instanceof Error ? err.message : String(err));
      insertId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    wsManager.broadcast(taskId, {
      type: "log_line",
      payload: {
        id: insertId,
        task_id: String(taskId),
        content,
        stream_type: streamType,
        timestamp: new Date().toISOString(),
      },
    });
  }

  private _processQueue() {
    if (this.queue.length === 0) return;

    // Evaluate each queued task at most once per flush to avoid spin-loops
    // when all candidate keys are saturated.
    const pending = [...this.queue];
    this.queue.length = 0;
    for (const nextId of pending) {
      void this.execute(nextId);
    }
  }

  resetStaleTasks(): number[] {
    return resetStaleTasksImpl(new Set(this.sessions.keys()));
  }
}

export const taskExecutor = new TaskExecutor();
