/**
 * Chat-side companion to `services/agents/rate-limit-classifier.ts` and
 * `services/agents/rate-limit-scheduler.ts`. Owns the two transitions a
 * paused chat goes through:
 *
 *   running  →  rate_limited     (parkChatForRateLimit)
 *   rate_limited  →  idle (running again under the hood)  (resumeChatAfterRateLimit)
 *
 * The chat lifecycle here mirrors what task-executor.parkRateLimited /
 * resumeFromRateLimit do for tasks, but is more involved because:
 *   1. Chats stream via SSE to a live HTTP client; pausing has to close the
 *      stream cleanly with a typed `rate_limited` frame so the UI can render
 *      a countdown card. The SSE handler does that part — this module only
 *      writes DB state and arms the timer.
 *   2. Chats have no executor queue. On wake-up we have to *re-run* the last
 *      assistant turn ourselves: spin up a fresh `AgentSession` carrying the
 *      saved `claude_session_id`, persist text/thinking/tool events the same
 *      way the SSE handler does (just over WS instead of SSE), and record
 *      usage.
 *
 * The resume implementation deliberately mirrors the non-streaming
 * `POST /chats/:id/messages` handler in `routes/chats/messages.ts` rather
 * than reuse it directly — that route is HTTP-bound (Hono `c.req`/`c.json`),
 * and refactoring it for callability from a setTimeout would be a much
 * bigger surgery than this slice warrants. The duplicated setup paths are
 * watched by the integration test suite; if they drift, the rate-limit
 * resume test fails before users do.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { chats, chatMessages, usageRecords } from "../db/schema.js";
import { wsManager } from "./ws-manager.js";
import { rateLimitScheduler } from "./agents/rate-limit-scheduler.js";
import { classifyLimit } from "./agents/rate-limit-classifier.js";
import { AgentSession, type AgentSessionMetrics } from "./agent-session/index.js";
import { calculateCost } from "./ai/cost.js";
import { resolvePermissionMode, allowedRoots as computeAllowedRoots } from "./permission-resolver.js";
import {
  resolveChatScope,
  resolveChatCwd,
  resolveChatSystemPrompt,
  resolveChatWorkspaceContext,
  loadPriorMessages,
  resolveKeyConfigDir,
  resolveKeyDispatch,
  resolveChatKeyId,
} from "../routes/chats/helpers.js";
import { reconcileClaudeSkillsForProject } from "./claude/skills-sync.js";
import { reconcileMcpForProject } from "./claude/mcp-sync.js";

export interface ParkChatArgs {
  chatId: number;
  resumeAtMs: number;
  errorMessage: string;
}

/**
 * Park a running chat that just hit a provider rate-limit. Writes
 * `status='rate_limited'` + `resume_at` to the chat row, broadcasts a
 * `chat_status` WS frame so any open chat detail page renders the
 * countdown banner, and arms the wake-up timer with the rate-limit
 * scheduler.
 *
 * Caller (the SSE handler) is responsible for emitting a final SSE
 * `rate_limited` frame and closing the stream — this module deliberately
 * does NOT touch the SSE layer because we run from non-HTTP contexts too
 * (the wake-up handler that fails with another rate-limit immediately).
 */
export function parkChatForRateLimit(args: ParkChatArgs): void {
  const { chatId, resumeAtMs, errorMessage } = args;
  const db = getDb();
  db.update(chats)
    .set({
      status: "rate_limited",
      resumeAt: resumeAtMs,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(chats.id, chatId))
    .run();
  // snake_case keys to match the HTTP response shape (apiFetch converts
  // camelCase responses to snake_case; WS frames don't go through that
  // converter — match by hand).
  wsManager.broadcastChatStatus(chatId, "rate_limited", {
    resume_at: resumeAtMs,
    error_message: errorMessage,
  });
  rateLimitScheduler.schedule({ kind: "chat", id: chatId, resumeAtMs });
}

/**
 * Wake-up handler — invoked by the rate-limit scheduler when a chat's
 * `resume_at` falls due. Loads the chat row, verifies it's still parked
 * (defends against a cancel race), then re-runs the last user turn in the
 * background through a fresh `AgentSession` carrying the saved
 * `claude_session_id`. Any new assistant rows persist directly to
 * `chat_messages`; text deltas broadcast via WS to whatever chat-detail
 * pages happen to be open.
 *
 * Failure modes:
 *   - No last user message → flip back to 'idle' silently. Nothing to retry.
 *   - Re-run hits another rate-limit → re-park with the classifier's
 *     escalated `resumeAtMs` (the scheduler caps at 60 min — see
 *     `nextEstimatedDelayMs`). The caller's prior timer is replaced
 *     atomically by the new schedule call.
 *   - Re-run hits any other error → log it and flip to 'idle'. We do NOT
 *     auto-park on generic failures because that would loop forever.
 */
export async function resumeChatAfterRateLimit(chatId: number): Promise<void> {
  const db = getDb();
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) return;
  if (chat.status !== "rate_limited") {
    // Cancelled / status-changed under us. The scheduler entry was already
    // torn down before we got here; bail.
    return;
  }

  // Find the last user message — that's what the resumed turn will replay.
  // Without one, there's nothing to send; just unpark and exit.
  const lastUser = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .all()
    .filter((m) => m.role === "user")
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .at(-1);

  if (!lastUser) {
    db.update(chats)
      .set({ status: "idle", resumeAt: null, updatedAt: new Date().toISOString() })
      .where(eq(chats.id, chatId))
      .run();
    wsManager.broadcastChatStatus(chatId, "idle", { resume_at: null });
    return;
  }

  /* v8 ignore start — the provider-execution half of resumeChatAfterRateLimit
   * (resolving config, constructing AgentSession, running it, reclassifying
   * rate-limits on failure, etc.) is unreachable in unit tests without a real
   * provider. The test file pins the bail-out branches explicitly; everything
   * below requires a live AgentSession session to wire `text` / `usage` /
   * `session_id` events, which we deliberately don't fake (faking would test
   * the fake, not the real provider contract). When live tests cover this in
   * the `test:live` tier (per CLAUDE.md tier ladder for AI integration), the
   * directive is removed.
   */
  // Resolve everything the SSE handler resolves at the top of streamSSE().
  // Nothing here writes — they're all pure derivations from chat row +
  // project / workspace config.
  const keyId = resolveChatKeyId(db, undefined, chat);
  const configDir = resolveKeyConfigDir(db, keyId);
  const dispatch = resolveKeyDispatch(db, keyId);
  const system = resolveChatSystemPrompt(db, chat, {});
  const { project: chatProject, workspace: chatWorkspace, projectConfig, workspaceConfig } = resolveChatScope(db, chat);
  const model = chat.model ?? projectConfig.model ?? "claude-sonnet-4-5-20250929";
  const permissionMode = resolvePermissionMode({
    chat: chat.permissionMode,
    project: projectConfig.permissionMode,
    workspace: workspaceConfig.permissionMode,
  });
  const cwd = resolveChatCwd(db, chat);
  const allowedRoots = computeAllowedRoots({
    workspacePath: chatWorkspace?.path,
    projectPath: chatProject?.path,
    workingDir: cwd,
  });
  const workspaceContext = resolveChatWorkspaceContext(db, chat);
  const priorWithNew = loadPriorMessages(db, chatId);
  const priorMessages = priorWithNew.slice(0, -1);

  // Mark the chat live again BEFORE constructing the session so a concurrent
  // GET /chats/:id sees `running`, not the now-stale `rate_limited`. Cleared
  // in the finally block below.
  db.update(chats)
    .set({ status: "running", resumeAt: null, updatedAt: new Date().toISOString() })
    .where(eq(chats.id, chatId))
    .run();
  wsManager.broadcastChatStatus(chatId, "running", { resume_at: null });

  // Reconcile project skills/MCP same as the live SSE path. Best-effort —
  // a corrupt project shouldn't block a resume.
  if (chat.projectId) {
    try {
      reconcileClaudeSkillsForProject(chat.projectId);
      reconcileMcpForProject(chat.projectId);
    } catch (err) {
      console.error(`[chat-rate-limit] reconcile for project ${chat.projectId} failed:`, err);
    }
  }

  // Re-issue the last user message verbatim. The SDK's `resume` option carries
  // the prior conversation context, so Claude sees this as a retry of the
  // turn that was cut short by the limit. (Not perfect — Claude may regenerate
  // a slightly different response than it would have completed before the
  // pause — but the conversation stays coherent and the user lost no input.)
  const session = new AgentSession({
    chatId,
    prompt: lastUser.content,
    model,
    codebaseContext: "",
    workingDir: cwd,
    configDir,
    agentId: dispatch.agentId,
    providerKeyValue: dispatch.providerKeyValue,
    permissionMode,
    allowedRoots,
    resumeSessionId: chat.claudeSessionId ?? undefined,
    systemPromptOverride: system,
    useResumeContinuationPrompt: false,
    priorMessages,
    projectId: chat.projectId ?? null,
    workspaceContext,
    thinkingEnabled: chat.thinkingEnabled ?? true,
    effort: (chat.effort as "low" | "medium" | "high" | "max" | null) ?? undefined,
  });

  let fullText = "";
  let finalMetrics: AgentSessionMetrics | undefined;
  session.on("text", (chunk: string) => {
    fullText += chunk;
    // Broadcast each text delta to any open chat-detail page so the user
    // sees the resumed turn arrive in real time. Mirrors the SSE writer in
    // routes/chats/messages.ts but routed through WS because there's no
    // HTTP client to stream to here.
    wsManager.broadcastChat(chatId, { type: "chat_text_delta", payload: { content: chunk } });
  });
  session.on("usage", (m) => { finalMetrics = m; });
  session.on("session_id", (sid: string) => {
    if (sid && sid !== chat.claudeSessionId) {
      try {
        db.update(chats)
          .set({ claudeSessionId: sid, updatedAt: new Date().toISOString() })
          .where(eq(chats.id, chatId))
          .run();
      } catch (err) {
        console.error(`[chat-rate-limit] eager session_id persist failed (chat ${chatId}):`, err);
      }
    }
  });

  // Lazy import — chatExecutor → chat-rate-limit → chatExecutor would create
  // a cycle at module load time. Resolving at call time breaks it.
  const { chatExecutor } = await import("./chat-executor.js");
  chatExecutor.register(chatId, session);
  try {
    await session.run();

    if (fullText) {
      db.insert(chatMessages).values({
        chatId,
        role: "assistant",
        content: fullText,
      }).run();
    }

    const inputTokens = finalMetrics?.inputTokens ?? 0;
    const outputTokens = finalMetrics?.outputTokens ?? 0;
    const cacheCreationInputTokens = finalMetrics?.cacheCreationInputTokens ?? 0;
    const cacheReadInputTokens = finalMetrics?.cacheReadInputTokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const recordProvider = dispatch.keyProvider ?? "claude_cli";
      const cost = calculateCost(
        dispatch.keyProvider ?? "anthropic",
        model,
        inputTokens, outputTokens,
        cacheCreationInputTokens, cacheReadInputTokens,
      );
      db.insert(usageRecords).values({
        projectId: chat.projectId,
        aiProviderKeyId: keyId ?? null,
        provider: recordProvider,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        totalCostUsd: cost,
      }).run();
    }

    db.update(chats)
      .set({ status: "idle", updatedAt: new Date().toISOString() })
      .where(eq(chats.id, chatId))
      .run();
    wsManager.broadcastChatStatus(chatId, "idle");
  } catch (err) {
    // If the resumed run hit ANOTHER rate-limit, classify and re-park. The
    // classifier-supplied resumeAtMs incorporates the polling-lattice
    // escalation when the backend gave an estimated rather than exact time.
    const limit = classifyLimit(err);
    if (limit) {
      parkChatForRateLimit({
        chatId,
        resumeAtMs: limit.resumeAtMs,
        errorMessage: limit.rawMessage,
      });
      return;
    }
    // Generic failure on resume — flip back to idle so the user can manually
    // retry. We don't auto-loop on non-limit errors (would mask real bugs).
    console.error(`[chat-rate-limit] resume for chat ${chatId} failed:`, err);
    db.update(chats)
      .set({ status: "idle", updatedAt: new Date().toISOString() })
      .where(eq(chats.id, chatId))
      .run();
    wsManager.broadcastChatStatus(chatId, "idle", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  } finally {
    chatExecutor.unregister(chatId);
  }
  /* v8 ignore stop */
}
