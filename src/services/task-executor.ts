import { AgentSession } from "./agent-session.js";
import type { AgentSessionMetrics, PermissionRequest } from "./agent-session.js";
import { getDb } from "../db/index.js";
import { tasks, taskLogs, usageRecords, projects, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  resolvePermissionMode,
  allowedRoots as computeAllowedRoots,
} from "./permission-resolver.js";
import { wsManager } from "./ws-manager.js";
import { buildCodebaseContext } from "./git-context.js";
import { selectKeyForTask } from "./key-selection.js";
import { getDefaultModel, getFlockctlHome } from "../config.js";
import { resolveTaskPrompt } from "./prompt-resolver.js";
import { loadProjectConfig } from "./project-config.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { reconcileClaudeSkillsForProject } from "./claude-skills-sync.js";
import { reconcileMcpForProject } from "./claude-mcp-sync.js";
import { formatToolCall, formatToolResult } from "./tool-format.js";
import { calculateCost } from "./cost.js";
import { TaskStatus } from "../lib/types.js";
import { checkBudget } from "./budget.js";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

function syncPlan(taskId: number): void {
  import("./auto-executor.js").then(m => m.syncPlanFromExecutionTask(taskId)).catch(() => {});
}

function repointPlan(previousTaskId: number, newTaskId: number): void {
  import("./auto-executor.js").then(m => m.repointPlanTask(previousTaskId, newTaskId)).catch(() => {});
}

class TaskExecutor {
  private sessions = new Map<number, AgentSession>();
  private runningMetrics = new Map<number, AgentSessionMetrics>();
  private runningCount = 0;
  private maxConcurrent = 5;
  private queue: number[] = [];
  /** Set during graceful shutdown so in-flight aborts are recognized as restart-induced
   *  and don't mark tasks as cancelled — resetStaleTasks re-queues them on next boot. */
  private shuttingDown = false;

  setMaxConcurrent(n: number) {
    this.maxConcurrent = n;
  }

  async execute(taskId: number): Promise<void> {
    if (this.runningCount >= this.maxConcurrent) {
      this.queue.push(taskId);
      return;
    }

    this.runningCount++;
    try {
      await this._run(taskId);
    } finally {
      this.runningCount--;
      this._processQueue();
    }
  }

  private async _run(taskId: number): Promise<void> {
    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    // Mark as running immediately — before any async preparation
    db.update(tasks)
      .set({ status: TaskStatus.RUNNING, startedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();

    wsManager.broadcastAll({ type: "task_status", taskId, status: TaskStatus.RUNNING });

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

      wsManager.broadcastAll({ type: "task_status", taskId, status: TaskStatus.FAILED });
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

    let codebaseCtx, selectedKey;
    try {
      codebaseCtx = task.projectId ? await buildCodebaseContext(task.projectId) : "";
      selectedKey = await selectKeyForTask(task);
    } catch (err: any) {
      db.update(tasks)
        .set({ status: TaskStatus.FAILED, errorMessage: err.message, completedAt: new Date().toISOString() })
        .where(eq(tasks.id, taskId))
        .run();
      wsManager.broadcastAll({ type: "task_status", taskId, status: TaskStatus.FAILED });
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

    // Always fetch project so we can read permission_mode / workspace link
    let projectRecord: typeof projects.$inferSelect | undefined;
    if (task.projectId) {
      projectRecord = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    }
    let workspaceRecord: typeof workspaces.$inferSelect | undefined;
    if (projectRecord?.workspaceId) {
      workspaceRecord = db.select().from(workspaces).where(eq(workspaces.id, projectRecord.workspaceId)).get();
    }

    // Resolution order: task override > project path > flockctl home
    let workingDir = task.workingDir ?? undefined;
    if (!workingDir && projectRecord?.path) workingDir = projectRecord.path;
    if (!workingDir) workingDir = getFlockctlHome();

    // Ensure workingDir exists — spawn will ENOENT on missing cwd
    if (!existsSync(workingDir)) {
      mkdirSync(workingDir, { recursive: true });
    }

    let gitCommitBefore: string | null = null;
    if (existsSync(join(workingDir, ".git"))) {
      try {
        gitCommitBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        db.update(tasks)
          .set({ gitCommitBefore })
          .where(eq(tasks.id, taskId))
          .run();
      } catch {
        // Not a git repo — skip diff tracking
      }
    }

    // .flockctl/config.yaml is the single source of truth for project + workspace
    // settings (portable across machines via git). DB holds only machine-local state
    // (name, path, workspaceId, status counters).
    const projectConfig = projectRecord?.path ? loadProjectConfig(projectRecord.path) : {};
    const workspaceConfig = workspaceRecord?.path ? loadWorkspaceConfig(workspaceRecord.path) : {};

    // Resolution order: task > project config.yaml > global default
    const model = task.model ?? projectConfig.model ?? getDefaultModel();
    const timeout = task.timeoutSeconds ?? projectConfig.defaultTimeout ?? undefined;
    const requiresApproval = task.requiresApproval ?? projectConfig.requiresApproval ?? false;

    const prompt = resolveTaskPrompt(task);
    const permissionMode = resolvePermissionMode({
      task: task.permissionMode,
      project: projectConfig.permissionMode,
      workspace: workspaceConfig.permissionMode,
    });
    const allowedRoots = computeAllowedRoots({
      workspacePath: workspaceRecord?.path,
      projectPath: projectRecord?.path,
      workingDir,
    });
    const session = new AgentSession({
      taskId,
      prompt,
      model,
      codebaseContext: codebaseCtx,
      workingDir,
      timeoutSeconds: timeout,
      configDir: selectedKey?.configDir ?? undefined,
      permissionMode,
      allowedRoots,
      resumeSessionId: task.claudeSessionId ?? undefined,
    });

    this.sessions.set(taskId, session);

    session.on("text", (chunk: string) => {
      this.appendLog(taskId, chunk, "stdout");
    });
    session.on("tool_call", (name: string, input: any) => {
      this.appendLog(taskId, formatToolCall(name, input), "tool_call");
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
      wsManager.broadcast(taskId, {
        type: "permission_request",
        payload: {
          task_id: String(taskId),
          request_id: request.requestId,
          tool_name: request.toolName,
          tool_input: request.toolInput,
          title: request.title ?? null,
          display_name: request.displayName ?? null,
          description: request.description ?? null,
          decision_reason: request.decisionReason ?? null,
          tool_use_id: request.toolUseID,
        },
      });
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

    try {
      const result = await session.run();
      this.saveUsage(taskId, task.projectId, selectedKey?.id ?? null, model, result);

      let gitCommitAfter: string | null = null;
      let gitDiffSummary: string | null = null;
      if (gitCommitBefore && workingDir) {
        try {
          gitCommitAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingDir, encoding: "utf-8" }).trim();
          gitDiffSummary = execFileSync(
            "git", ["diff", "--stat", `${gitCommitBefore}..${gitCommitAfter}`],
            { cwd: workingDir, encoding: "utf-8", maxBuffer: 1024 * 1024 }
          ).trim();
          // If no commits made (agent edited without committing), diff against working tree
          if (!gitDiffSummary && gitCommitBefore === gitCommitAfter) {
            gitDiffSummary = execFileSync(
              "git", ["diff", "--stat"],
              { cwd: workingDir, encoding: "utf-8", maxBuffer: 1024 * 1024 }
            ).trim();
          }
        } catch { /* git error — skip */ }
      }

      const finalStatus = requiresApproval ? TaskStatus.PENDING_APPROVAL : TaskStatus.DONE;
      // Don't overwrite if task was already cancelled via the cancel endpoint
      const currentTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (currentTask?.status === TaskStatus.CANCELLED) return;
      db.update(tasks)
        .set({
          status: finalStatus,
          exitCode: requiresApproval ? undefined : 0,
          gitCommitAfter,
          gitDiffSummary: gitDiffSummary || null,
          completedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, taskId))
        .run();
      wsManager.broadcastAll({ type: "task_status", taskId, status: finalStatus });
      syncPlan(taskId);
    } catch (err: any) {
      // Graceful shutdown aborts running sessions — leave the task's status as
      // RUNNING so resetStaleTasks re-queues it on next startup (where it will
      // resume via the persisted claudeSessionId).
      const isShutdown = err.reason === "shutdown" || (this.shuttingDown && err.name === "AbortError");
      if (isShutdown) {
        return;
      }

      const status = err.name === "TimeoutError" ? TaskStatus.TIMED_OUT :
                     err.name === "AbortError" ? TaskStatus.CANCELLED : TaskStatus.FAILED;
      const logPrefix = status === TaskStatus.CANCELLED ? "Cancelled"
                      : status === TaskStatus.TIMED_OUT ? "Timed out"
                      : "Failed";
      // Abort/timeout messages already describe the cause; stack only adds noise.
      const logBody = status === TaskStatus.FAILED ? (err.stack ?? err.message) : err.message;
      this.appendLog(taskId, `${logPrefix}: ${logBody}`, "stderr");

      // Don't overwrite if task was already cancelled via the cancel endpoint
      const currentTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (currentTask?.status !== TaskStatus.CANCELLED) {
        db.update(tasks)
          .set({ status, exitCode: 1, errorMessage: err.message, completedAt: new Date().toISOString() })
          .where(eq(tasks.id, taskId))
          .run();
        wsManager.broadcastAll({ type: "task_status", taskId, status });
      }
      syncPlan(taskId);

      // Auto-retry
      if (status === TaskStatus.FAILED) {
        const updated = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
        if (updated && updated.maxRetries && updated.retryCount !== null && updated.retryCount < updated.maxRetries) {
          const newTask = db.insert(tasks).values({
            projectId: updated.projectId,
            prompt: updated.prompt,
            promptFile: updated.promptFile,
            agent: updated.agent,
            model: updated.model,
            taskType: updated.taskType,
            label: `retry-${taskId}-${(updated.retryCount ?? 0) + 1}`,
            maxRetries: updated.maxRetries,
            retryCount: (updated.retryCount ?? 0) + 1,
            parentTaskId: taskId,
            workingDir: updated.workingDir,
            timeoutSeconds: updated.timeoutSeconds,
            targetSliceSlug: updated.targetSliceSlug,
            permissionMode: updated.permissionMode,
            envVars: updated.envVars,
            requiresApproval: updated.requiresApproval,
          }).returning().get();
          if (newTask) {
            repointPlan(taskId, newTask.id);
            setTimeout(() => this.execute(newTask.id), 0);
          }
        }
      }
    } finally {
      this.sessions.delete(taskId);
      this.runningMetrics.delete(taskId);
    }
  }

  cancel(taskId: number): boolean {
    // Remove from queue if waiting
    const qIdx = this.queue.indexOf(taskId);
    if (qIdx !== -1) this.queue.splice(qIdx, 1);

    const session = this.sessions.get(taskId);
    if (session) {
      session.abort("user");
      return true;
    }
    return false;
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

  getMetrics(taskId: number): AgentSessionMetrics | null {
    return this.runningMetrics.get(taskId) ?? null;
  }

  get activeCount(): number {
    return this.runningCount;
  }

  cancelAll(): void {
    this.shuttingDown = true;
    for (const [, session] of this.sessions) {
      session.abort("shutdown");
    }
    this.queue.length = 0;
  }

  private saveUsage(
    taskId: number,
    projectId: number | null,
    aiProviderKeyId: number | null,
    model: string,
    metrics: AgentSessionMetrics,
  ) {
    const db = getDb();
    const provider = this.inferProvider(model);
    // Use SDK-reported cost, or fall back to calculated cost
    const cost = metrics.totalCostUsd > 0
      ? metrics.totalCostUsd
      : calculateCost(
          provider, model,
          metrics.inputTokens, metrics.outputTokens,
          metrics.cacheCreationInputTokens, metrics.cacheReadInputTokens,
        );
    try {
      db.insert(usageRecords).values({
        taskId,
        projectId,
        aiProviderKeyId,
        provider,
        model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cacheCreationInputTokens: metrics.cacheCreationInputTokens,
        cacheReadInputTokens: metrics.cacheReadInputTokens,
        totalCostUsd: cost,
      }).run();
    } catch (err) {
      console.error("Failed to save usage record:", err instanceof Error ? err.message : String(err));
    }
  }

  private inferProvider(model: string): string {
    if (model.includes("claude") || model.includes("haiku") || model.includes("sonnet") || model.includes("opus")) return "anthropic";
    if (model.includes("gpt") || model.includes("o3") || model.includes("o1")) return "openai";
    if (model.includes("gemini")) return "google";
    if (model.includes("mistral") || model.includes("codestral")) return "mistral";
    return "anthropic"; // default — Claude Code SDK
  }

  private appendLog(taskId: number, content: string, streamType: string) {
    const db = getDb();
    let insertId: string;
    try {
      const result = db.insert(taskLogs).values({ taskId, content, streamType }).run();
      insertId = String(result.lastInsertRowid);
    } catch (err) {
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
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const nextId = this.queue.shift()!;
      this.execute(nextId);
    }
  }

  /** Re-queue tasks left as "running" by a previous daemon instance so they are retried. */
  resetStaleTasks(): number[] {
    const db = getDb();
    const stale = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, TaskStatus.RUNNING))
      .all();

    const requeued: number[] = [];
    for (const t of stale) {
      if (!this.sessions.has(t.id)) {
        db.update(tasks)
          .set({
            status: TaskStatus.QUEUED,
            exitCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
          })
          .where(eq(tasks.id, t.id))
          .run();
        requeued.push(t.id);
      }
    }

    if (requeued.length > 0) {
      console.log(`Re-queued ${requeued.length} stale running task(s) from previous daemon`);
    }
    return requeued;
  }
}

export const taskExecutor = new TaskExecutor();
