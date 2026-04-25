import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../../db/index.js";
import { chats, chatMessages, usageRecords } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import {
  validateAttachmentsForMessage,
  linkAttachmentsToMessage,
  buildMessageContent,
  AttachmentError,
} from "../../services/attachments.js";
import { getAgent } from "../../services/agents/registry.js";
import { getDefaultModel } from "../../config/index.js";
import { resolvePermissionMode, allowedRoots as computeAllowedRoots } from "../../services/permission-resolver.js";
import { AgentSession, type AgentSessionMetrics } from "../../services/agent-session/index.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { formatToolCall, formatToolResult } from "../../services/tool-format.js";
import { calculateCost } from "../../services/ai/cost.js";
import { reconcileClaudeSkillsForProject } from "../../services/claude/skills-sync.js";
import { reconcileMcpForProject } from "../../services/claude/mcp-sync.js";
import {
  parseAttachmentIds,
  resolveKeyConfigDir,
  resolveKeyDispatch,
  resolveChatKeyId,
  assertKeyAllowedForChat,
  classifyKeyIdSource,
  persistChatSelection,
  resolveChatCwd,
  resolveChatScope,
  resolveChatSystemPrompt,
  resolveChatWorkspaceContext,
  loadPriorMessages,
  parseEffortBody,
  parseThinkingEnabledBody,
} from "./helpers.js";

export function registerChatMessages(router: Hono): void {
  // POST /chats/:id/messages — send user message, get AI response
  router.post("/:id/messages", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const body = await c.req.json();
    if (!body.content) throw new ValidationError("content is required");
    const role = body.role ?? "user";
    const content = body.content;
    // Model resolution: explicit body.model → chat's saved model → global
    // default. Project config is applied in the stream handler (below) via
    // `resolveChatScope`; the non-stream path keeps the simpler chain used
    // historically, just widened to read the chat row.
    const model = body.model ?? chat.model ?? getDefaultModel();
    // Same precedence as the stream handler (explicit body.system > entity
    // prompt > workspace prompt > default base). The non-stream path used to
    // skip this resolution and fall straight to the default, which silently
    // stripped the workspace project list from workspace chats and left the
    // agent doing blind `ls` on the workspace root. See resolveChatSystemPrompt.
    const system = resolveChatSystemPrompt(db, chat, body);
    const keyId = resolveChatKeyId(db, body.keyId, chat);
    assertKeyAllowedForChat(db, chat, keyId, classifyKeyIdSource(body.keyId, chat.aiProviderKeyId));
    const configDir = resolveKeyConfigDir(db, keyId);
    const dispatch = resolveKeyDispatch(db, keyId);

    // Per-turn body overrides for the adaptive-thinking toggle + reasoning
    // effort level. `undefined` means "reuse the stored chat value"; an
    // explicit value both drives THIS turn and is persisted on the chat row
    // below so the UI restores the same pick on reload (identical pattern
    // to model / keyId).
    const thinkingEnabledBody = parseThinkingEnabledBody(body);
    const thinkingEnabled = thinkingEnabledBody ?? chat.thinkingEnabled;
    const effortBody = parseEffortBody(body);
    // `effortBody === null` is the explicit "clear back to default" signal;
    // anything else (string | undefined) falls back to the stored chat value
    // and finally `undefined` (the SDK default = "high"). We deliberately do
    // NOT coerce NULL to "high" here — keeping the column nullable lets the
    // runtime default drift later without a DB backfill.
    const effort: import("../../services/ai/client.js").EffortLevel | undefined =
      (effortBody === null ? undefined : effortBody)
      ?? (chat.effort as import("../../services/ai/client.js").EffortLevel | null ?? undefined);

    // Persist the effective selection back to the chat row so a reload restores
    // the UI's key/model dropdowns without re-resolving from globals. Only write
    // when something actually changed, to keep `updated_at` noise-free.
    persistChatSelection(db, id, chat, {
      keyId,
      model,
      thinkingEnabled: thinkingEnabledBody,
      effort: effortBody,
    });

    // attachment_ids must be validated BEFORE the chat_messages insert — any
    // failure (cross-chat id, already-linked, total-size blow-out) should leave
    // no trace of a dangling user message. Shape errors surface as 422 directly;
    // ownership / link / size errors come out of AttachmentError below.
    const attachmentIds = parseAttachmentIds(body);
    try {
      validateAttachmentsForMessage(id, attachmentIds);
    } catch (err) {
      /* v8 ignore next 4 — non-AttachmentError rethrow requires an unrelated throw from validateAttachmentsForMessage; the helper only throws AttachmentError subclasses by construction */
      if (err instanceof AttachmentError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    // Save the incoming message
    const userMsg = db.insert(chatMessages).values({
      chatId: id,
      role,
      content,
    }).returning().get();

    // Link attachments immediately after the message row lands. Validation
    // already proved every id is valid + unlinked, so this UPDATE is safe.
    const linkedAttachments = linkAttachmentsToMessage(userMsg.id, attachmentIds);

    // If role is not "user", just save and return (no AI call)
    if (role !== "user") {
      return c.json({ ...userMsg, attachments: linkedAttachments }, 201);
    }

    // Claim `isRunning` before the async setup (resolveChatScope → AgentSession
    // construction → session.run). Same rationale as the stream handler below:
    // without this, a concurrent `GET /chats/:id` landing between the user-
    // message insert and `chatExecutor.register` sees a torn state that flips
    // the UI into the "Response was not received" fallback. The `finally`
    // at the bottom of this handler calls `unregister`, which also reaps the
    // claim on the error path.
    chatExecutor.claim(id);

    // Resolve scope + permission mode (chat → project → workspace → "auto")
    const { project: chatProject, workspace: chatWorkspace, projectConfig, workspaceConfig } = resolveChatScope(db, chat);
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

    // priorMessages = history WITHOUT the just-inserted user message (we pass it
    // as `prompt` instead, so AgentSession appends it as the final user turn).
    const priorWithNew = loadPriorMessages(db, id);
    const priorMessages = priorWithNew.slice(0, -1);

    // Current-turn content: string if no attachments, otherwise an Anthropic
    // content-block array that pairs the text with each linked image. Same
    // helper as loadPriorMessages — keeps the text-only path identical.
    const promptContent = buildMessageContent(content, linkedAttachments);

    if (chat.projectId) {
      try {
        reconcileClaudeSkillsForProject(chat.projectId);
        reconcileMcpForProject(chat.projectId);
      } catch (err) {
        console.error(`[chats] reconcile for project ${chat.projectId} failed:`, err);
      }
    }

    const provider = getAgent();
    const session = new AgentSession({
      chatId: id,
      prompt: promptContent,
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
      thinkingEnabled,
      effort,
    });

    let sessionId: string | undefined;
    // Persist claudeSessionId IMMEDIATELY on receipt so chat-resume still works
    // if the run is interrupted before finishing (daemon shutdown mid-turn
    // during `make reinstall`, client disconnect, aborted run). Without this
    // eager write the id was only saved in the post-run block below; a
    // mid-stream abort left `chats.claudeSessionId` NULL and the next turn
    // forked a fresh SDK session with no prior context — i.e. the classic
    // "context lost after make reinstall" bug.
    session.on("session_id", (sid) => {
      sessionId = sid;
      if (sid && sid !== chat.claudeSessionId) {
        try {
          db.update(chats)
            .set({ claudeSessionId: sid, updatedAt: new Date().toISOString() })
            .where(eq(chats.id, id))
            .run();
        } catch (err) {
          console.error(`[chats] eager session_id persist failed (chat ${id}):`, err);
        }
      }
    });
    let fullText = "";
    session.on("text", (chunk) => { fullText += chunk; });
    let finalMetrics: AgentSessionMetrics | undefined;
    session.on("usage", (m) => { finalMetrics = m; });

    chatExecutor.register(id, session);
    try {
      // Swallow run errors so we can still persist whatever partial text streamed
      // before the abort — prevents aborted chats from leaving a dangling user msg.
      await session.run().catch(() => { /* partial text already captured via events */ });

      // Persist Claude Code session ID for future resume
      if (sessionId && sessionId !== chat.claudeSessionId) {
        db.update(chats).set({ claudeSessionId: sessionId, updatedAt: new Date().toISOString() }).where(eq(chats.id, id)).run();
      }

      // Save assistant response
      const assistantMsg = db.insert(chatMessages).values({
        chatId: id,
        role: "assistant",
        content: fullText,
      }).returning().get();

      // Record usage — the attached key's `provider` drives the tariff lookup
      // so flat-rate backends (`claude_cli`, `github_copilot`) price as $0 while
      // key-less chats still fall back to the Anthropic API tariff, preserving
      // "what would this have cost?" visibility.
      const inputTokens = finalMetrics?.inputTokens ?? 0;
      const outputTokens = finalMetrics?.outputTokens ?? 0;
      const cacheCreationInputTokens = finalMetrics?.cacheCreationInputTokens ?? 0;
      const cacheReadInputTokens = finalMetrics?.cacheReadInputTokens ?? 0;
      const costProvider = dispatch.keyProvider ?? "anthropic";
      const recordProvider = dispatch.keyProvider ?? "claude_cli";
      const cost = calculateCost(
        costProvider, model,
        inputTokens, outputTokens,
        cacheCreationInputTokens, cacheReadInputTokens,
      );

      if (inputTokens > 0 || outputTokens > 0) {
        db.insert(usageRecords).values({
          chatMessageId: assistantMsg.id,
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

      // Symmetric with the task path's `requiresApproval` gate: a chat marked
      // `requires_approval=true` surfaces each completed turn as a blocker in
      // `/attention` until the user approves or rejects. No-op otherwise.
      chatExecutor.markPendingApprovalIfRequired(id);

      return c.json({
        userMessage: { ...userMsg, attachments: linkedAttachments },
        assistantMessage: assistantMsg,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          costUsd: cost,
        },
      }, 201);
    } finally {
      chatExecutor.unregister(id);
    }
  });

  // POST /chats/:id/messages/stream — send user message, stream AI response (SSE)
  router.post("/:id/messages/stream", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const body = await c.req.json();
    if (!body.content) throw new ValidationError("content is required");
    const content = body.content;
    const keyId = resolveChatKeyId(db, body.keyId, chat);
    assertKeyAllowedForChat(db, chat, keyId, classifyKeyIdSource(body.keyId, chat.aiProviderKeyId));
    const configDir = resolveKeyConfigDir(db, keyId);
    const dispatch = resolveKeyDispatch(db, keyId);

    // System prompt precedence: explicit body.system → entity-aware (chat row or
    // body.entity_context) → default base. See resolveChatSystemPrompt.
    const system = resolveChatSystemPrompt(db, chat, body);

    // Validate attachment_ids BEFORE opening the SSE stream. A 422 here needs to
    // be a regular HTTP response, not an SSE `error:` event the client would
    // have to unwrap. Same ownership / unlinked / total-size rules as the
    // non-stream endpoint.
    const attachmentIds = parseAttachmentIds(body);
    try {
      validateAttachmentsForMessage(id, attachmentIds);
    } catch (err) {
      /* v8 ignore next 4 — non-AttachmentError rethrow requires an unrelated throw from validateAttachmentsForMessage; the helper only throws AttachmentError subclasses by construction */
      if (err instanceof AttachmentError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    // Save the user message
    const userMsg = db
      .insert(chatMessages)
      .values({ chatId: id, role: "user", content })
      .returning()
      .get();
    const linkedAttachments = linkAttachmentsToMessage(userMsg.id, attachmentIds);

    // Mark the chat as running IMMEDIATELY after the user row lands, so any
    // concurrent `GET /chats/:id` sees `isRunning=true` while the rest of
    // the session setup runs (resolveChatScope → AgentSession construction
    // → streamSSE arrow → chatExecutor.register). Without this, the torn
    // state "user message in DB, session not yet registered" makes the UI
    // fall back into "Response was not received" when the user switches
    // chats and comes back mid-setup — `useChatEventStream` invalidates the
    // chat detail query on chatId change, and the refetch lands inside this
    // window. The claim is promoted to a real session by `register()`
    // below; the `finally` in the streamSSE arrow calls `unregister()`,
    // which also reaps the claim on the error path.
    chatExecutor.claim(id);

    // Resolve scope + permission mode
    const { project: chatProject, workspace: chatWorkspace, projectConfig, workspaceConfig } = resolveChatScope(db, chat);
    // Model resolution order: explicit body.model → chat row → project config
    // → global default. The chat row takes precedence over project config so
    // an explicit user pick inside this chat isn't silently overridden by a
    // later .flockctl/config.yaml edit.
    const model = body.model ?? chat.model ?? projectConfig.model ?? getDefaultModel();
    // Per-turn thinking/effort — same precedence + persistence semantics as
    // the non-stream handler (see notes there). Stored NULL on `chat.effort`
    // falls through to the SDK default (`high`).
    const thinkingEnabledBody = parseThinkingEnabledBody(body);
    const thinkingEnabled = thinkingEnabledBody ?? chat.thinkingEnabled;
    const effortBody = parseEffortBody(body);
    const effort: import("../../services/ai/client.js").EffortLevel | undefined =
      (effortBody === null ? undefined : effortBody)
      ?? (chat.effort as import("../../services/ai/client.js").EffortLevel | null ?? undefined);
    // Same save-on-change contract as the non-stream handler.
    persistChatSelection(db, id, chat, {
      keyId,
      model,
      thinkingEnabled: thinkingEnabledBody,
      effort: effortBody,
    });
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

    const priorWithNew = loadPriorMessages(db, id);
    const priorMessages = priorWithNew.slice(0, -1);

    // Current-turn content as a string (no attachments) or Anthropic content
    // blocks (text + image/jpeg|png|gif|webp). Same helper used for prior
    // messages — one widened path, no parallel multimodal branch.
    const promptContent = buildMessageContent(content, linkedAttachments);

    if (chat.projectId) {
      try {
        reconcileClaudeSkillsForProject(chat.projectId);
        reconcileMcpForProject(chat.projectId);
      } catch (err) {
        console.error(`[chats] reconcile for project ${chat.projectId} failed:`, err);
      }
    }

    const provider = getAgent();
    const session = new AgentSession({
      chatId: id,
      prompt: promptContent,
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
      thinkingEnabled,
      effort,
    });

    return streamSSE(c, async (stream) => {
      let fullText = "";
      // Text/thinking accumulated since the last flush boundary (= the last
      // `tool_call` event). Each tool_call marks the end of an assistant turn
      // in Claude Code's rendering model, so we persist `pendingText` as its
      // own `role: "assistant"` row at each boundary instead of concatenating
      // the whole run into one final message. Without this, a multi-turn
      // agent response renders as a single wall of text on reload because
      // everything lands in one `chat_messages` row.
      let pendingText = "";
      let pendingThinking = "";
      let returnedSessionId: string | undefined;
      let finalMetrics: AgentSessionMetrics | undefined;
      let clientDisconnected = false;
      let errorMsg: string | null = null;

      // Preamble: echo the persisted user message + any linked attachments as
      // the first SSE frame so the UI can render the optimistic bubble with
      // thumbnails without a separate round-trip. Safe to skip if the client
      // is already gone.
      try {
        await stream.writeSSE({
          data: JSON.stringify({
            user_message: { ...userMsg, attachments: linkedAttachments },
          }),
        });
      } catch {
        clientDisconnected = true;
      }

      // Buffer events from AgentSession and pump to SSE as they happen.
      //
      // tool_call / tool_result events carry the full payload + a short summary
      // so the UI can render each tool as its own block in-place (matching
      // Claude Code's one-block-per-event model) without waiting for a
      // post-`done` re-fetch. They're echoed alongside chat-executor's own WS
      // broadcasts — the SSE stream is the primary live consumer; WS stays as
      // the channel for secondary viewers (sidebars, other tabs).
      type SseEvent =
        | { content: string }
        | { thinking: string }
        | { tool_call: { name: string; input: unknown; summary: string } }
        | { tool_result: { name: string; output: string; summary: string } };
      const eventQueue: SseEvent[] = [];
      // Count meaningful events (text, thinking, tool_call, tool_result) seen
      // from the session across its whole run. If the run completes with this
      // count at 0 AND no `errorMsg`, the SDK silently returned nothing —
      // which the UI would previously render as a content-less "Response was
      // not received" fallback with no explanation. We surface an explicit
      // error SSE frame in that case so the user sees WHY (model returned no
      // content) rather than the ambiguous fallback.
      let meaningfulEventCount = 0;
      let fullThinking = "";
      let resolveWait: (() => void) | null = null;
      const wakeWaiter = () => {
        if (resolveWait) { resolveWait(); resolveWait = null; }
      };
      const waitForNext = () => new Promise<void>((resolve) => { resolveWait = resolve; });

      session.on("text", (chunk) => {
        fullText += chunk;
        pendingText += chunk;
        eventQueue.push({ content: chunk });
        meaningfulEventCount++;
        wakeWaiter();
      });
      session.on("thinking", (chunk) => {
        fullThinking += chunk;
        pendingThinking += chunk;
        eventQueue.push({ thinking: chunk });
        meaningfulEventCount++;
        wakeWaiter();
      });
      session.on("usage", (m) => { finalMetrics = m; });
      // Persist claudeSessionId IMMEDIATELY on receipt. The post-stream block
      // below also writes it as a belt-and-suspenders pass, but without this
      // eager write a stream aborted mid-turn (daemon shutdown drain during
      // `make reinstall`, client disconnect) left `chats.claudeSessionId` NULL
      // and the next user turn forked a fresh SDK session with no prior
      // context — the classic "context lost after make reinstall" bug.
      session.on("session_id", (sid) => {
        returnedSessionId = sid;
        if (sid && sid !== chat.claudeSessionId) {
          try {
            db.update(chats)
              .set({ claudeSessionId: sid, updatedAt: new Date().toISOString() })
              .where(eq(chats.id, id))
              .run();
          } catch (err) {
            console.error(`[chats.stream] eager session_id persist failed (chat ${id}):`, err);
          }
        }
      });
      session.on("error", (err) => { errorMsg = err.message; });

      // id of the most recently persisted assistant row — used as the anchor
      // for the `usage_records.chat_message_id` FK once the session finishes.
      // Updated by every flush so usage attaches to the last turn's row even
      // when `pendingText` is empty at end-of-stream.
      let lastAssistantRowId: number | null = null;

      // Flush any text/thinking accumulated since the last boundary as its own
      // chat_messages row. Called on `tool_call` (so the tool-call row from
      // chatExecutor lands RIGHT AFTER the text that preceded it), on
      // `turn_end` (so each assistant SDK message gets its own row), and once
      // more at end-of-stream (belt-and-suspenders for the rare case where the
      // SDK stream ended without a trailing turn_end event). Net effect: one
      // persisted row per assistant SDK message, matching Claude Code's
      // per-message rendering.
      const flushPending = (boundary: "tool_call" | "turn_end" | "stream_end") => {
        try {
          /* v8 ignore next — `pendingThinking` is only populated by real SDK thinking deltas; live streaming tests don't emit them */
          if (pendingThinking) {
            db.insert(chatMessages).values({
              chatId: id,
              role: "thinking",
              content: pendingThinking,
            }).run();
            pendingThinking = "";
          }
          if (pendingText) {
            const row = db.insert(chatMessages).values({
              chatId: id,
              role: "assistant",
              content: pendingText,
            }).returning().get();
            lastAssistantRowId = row.id;
            pendingText = "";
          }
        } catch (err) {
          console.error(`[chats.stream] failed to flush pending text at ${boundary} boundary (chat ${id}):`, err);
        }
      };

      // MUST be registered before chatExecutor.register so EventEmitter invokes
      // our tool_call flush first — guarantees the assistant-text row is
      // persisted BEFORE the tool-call row chatExecutor inserts on the same
      // event, preserving chronological order on reload.
      session.on("tool_call", () => flushPending("tool_call"));
      // Mirror tool_call / tool_result onto the SSE stream so the client can
      // render each tool inline without a post-`done` re-fetch. This runs in
      // ADDITION to chat-executor's own DB-write + WS-broadcast listener
      // registered below; EventEmitter fires listeners in registration order so
      // this one pushes the SSE event alongside chat-executor's DB side effects.
      // Registered after `flushPending` so the text that preceded the tool
      // lands on the wire first, matching persistence order.
      session.on("tool_call", (name: string, input: unknown) => {
        const summary = formatToolCall(name, input);
        eventQueue.push({ tool_call: { name, input, summary } });
        meaningfulEventCount++;
        wakeWaiter();
      });
      session.on("tool_result", (name: string, output: string) => {
        const summary = formatToolResult(name, output);
        eventQueue.push({ tool_result: { name, output, summary } });
        meaningfulEventCount++;
        wakeWaiter();
      });
      // Per-assistant-message boundary — closes out the current row so the
      // next turn starts fresh instead of concatenating into the same content.
      session.on("turn_end", () => flushPending("turn_end"));

      chatExecutor.register(id, session);
      let runFinished = false;
      const runPromise = session.run().catch((err: unknown) => {
        /* v8 ignore next — `session.run()` rejection path fires only when the live SDK throws; unit tests mock a successful resolve */
        errorMsg = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        runFinished = true;
        wakeWaiter();
      });

      let done = false;
      try {
        while (!done) {
          while (eventQueue.length > 0) {
            const evt = eventQueue.shift()!;
            try {
              await stream.writeSSE({ data: JSON.stringify(evt) });
            } catch { clientDisconnected = true; break; }
          }
          /* v8 ignore next — mid-loop client-disconnect branch requires the stream writer to throw between iterations; reproducible only with a real TCP socket teardown */
          if (clientDisconnected) break;
          if (runFinished && eventQueue.length === 0) { done = true; break; }
          await waitForNext();
        }
        await runPromise; // ensure all events flushed
        // Drain any remaining events
        /* v8 ignore start — defensive drain after stream end; race-only */
        while (eventQueue.length > 0 && !clientDisconnected) {
          const evt = eventQueue.shift()!;
          try {
            await stream.writeSSE({ data: JSON.stringify(evt) });
          } catch { clientDisconnected = true; }
        }
        /* v8 ignore stop */
      } catch (err: unknown) {
        /* v8 ignore next — defensive: writeSSE rarely throws outside disconnect */
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      // Silent-empty-response guard. If the session finished without emitting
      // a single meaningful event AND without reporting an error, the SDK
      // swallowed the request — often due to a provider-side issue that
      // didn't propagate as an exception (quota hit mid-stream, thinking
      // budget exhausted before first token, proxy dropped the response,
      // etc.). Without this guard the UI sees only `{done: true}` and falls
      // back to the ambiguous "Response was not received" bubble with no
      // explanation. Promoting this to an explicit SSE error makes the cause
      // legible and the retry actionable.
      if (!errorMsg && meaningfulEventCount === 0) {
        errorMsg =
          "AI returned an empty response — no text, thinking, or tool calls were produced. Retry, or check the provider key / model selection.";
      }

      if (errorMsg && !clientDisconnected) {
        try {
          await stream.writeSSE({ data: JSON.stringify({ error: errorMsg }) });
        } catch {
          /* v8 ignore next — defensive: SSE write fails on client disconnect */
          clientDisconnected = true;
        }
      }

      try {
        // Persist session ID + rename for [FLOCKCTL] tagging
        if (returnedSessionId && returnedSessionId !== chat.claudeSessionId) {
          db.update(chats).set({ claudeSessionId: returnedSessionId, updatedAt: new Date().toISOString() }).where(eq(chats.id, id)).run();
          const sessionTitle = `[FLOCKCTL] ${chat.title || fullText.slice(0, 50).replace(/\n/g, " ") || "Chat #" + id}`;
          await provider.renameSession?.(returnedSessionId, sessionTitle);
        }

        // Final flush — closes out anything that didn't hit a `turn_end` or
        // `tool_call` boundary (e.g. aborted run, legacy providers that don't
        // emit turn_end, or shutdown mid-stream). `fullText`/`fullThinking`
        // remain intact for the title slice and session rename below.
        flushPending("stream_end");

        // Usage rows need a `chat_message_id` anchor. Prefer the last flushed
        // assistant row; if the run produced zero assistant content (rare —
        // error before any text, or tool-only turn with empty prose), insert
        // an empty placeholder row so the FK has something to point to.
        let assistantMsgId: number | null = lastAssistantRowId;
        if (assistantMsgId === null) {
          const placeholder = db.insert(chatMessages).values({
            chatId: id,
            role: "assistant",
            content: "",
          }).returning().get();
          assistantMsgId = placeholder.id;
        }

        const inputTokens = finalMetrics?.inputTokens ?? 0;
        const outputTokens = finalMetrics?.outputTokens ?? 0;
        const cacheCreationInputTokens = finalMetrics?.cacheCreationInputTokens ?? 0;
        const cacheReadInputTokens = finalMetrics?.cacheReadInputTokens ?? 0;
        // Same provider-aware pricing rationale as the non-stream handler.
        const costProvider = dispatch.keyProvider ?? "anthropic";
        const recordProvider = dispatch.keyProvider ?? "claude_cli";
        const cost = calculateCost(
          costProvider, model,
          inputTokens, outputTokens,
          cacheCreationInputTokens, cacheReadInputTokens,
        );

        if (inputTokens > 0 || outputTokens > 0) {
          db.insert(usageRecords).values({
            chatMessageId: assistantMsgId,
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

        // Update chat title from first message if untitled
        if (!chat.title && fullText) {
          const title = fullText.slice(0, 60).replace(/\n/g, " ");
          db.update(chats).set({ title, updatedAt: new Date().toISOString() }).where(eq(chats.id, id)).run();
          /* v8 ignore next 3 — renameSession branch depends on provider exposing the optional method and on having a session id; live-only */
          if (returnedSessionId || chat.claudeSessionId) {
            await provider.renameSession?.((returnedSessionId || chat.claudeSessionId)!, `[FLOCKCTL] ${title}`);
          }
        } else {
          db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, id)).run();
        }

        // Surface the finished turn as a pending-approval blocker in /attention
        // when the chat opted in via `requires_approval=true`. Mirror of the
        // task-side `TaskStatus.PENDING_APPROVAL` transition in task-executor.
        if (!errorMsg) {
          chatExecutor.markPendingApprovalIfRequired(id);
        }

        /* v8 ignore next 5 — trailing writeSSE path requires the client to have disconnected mid-stream; live-only */
        if (!clientDisconnected) {
          try {
            await stream.writeSSE({ data: JSON.stringify({ done: true, usage: { inputTokens, outputTokens, costUsd: cost } }) });
          } catch { /* client already gone */ }
        }
      } finally {
        // Unregister only AFTER save — so waitForIdle() on shutdown actually
        // waits for the assistant message to land, not just the run to stop.
        chatExecutor.unregister(id);
      }
    });
  });
}
