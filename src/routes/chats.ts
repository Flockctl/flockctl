import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/index.js";
import { chats, chatMessages, usageRecords, aiProviderKeys, projects, workspaces } from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { getAgent } from "../services/agents/registry.js";
import { getDefaultModel, getDefaultKeyId, getFlockctlHome } from "../config.js";
import { getPlanDir } from "../services/plan-store.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parsePermissionModeBody } from "./_permission-mode.js";
import { resolvePermissionMode, allowedRoots as computeAllowedRoots } from "../services/permission-resolver.js";
import { AgentSession, type AgentSessionMetrics } from "../services/agent-session.js";
import { chatExecutor } from "../services/chat-executor.js";
import { loadProjectConfig } from "../services/project-config.js";
import { loadWorkspaceConfig } from "../services/workspace-config.js";
import { reconcileClaudeSkillsForProject } from "../services/claude-skills-sync.js";
import { reconcileMcpForProject } from "../services/claude-mcp-sync.js";

export const chatRoutes = new Hono();

// Max messages to send to AI (sliding window). Keeps last N messages.
// System prompt is always sent separately, not counted here.
const MAX_CHAT_MESSAGES = 50;

/** Compute compact metrics for a chat (message counts + usage). */
function getChatMetrics(db: ReturnType<typeof getDb>, chatId: number) {
  const messageCounts = db.select({
    messageCount: sql<number>`count(*)`,
    userMessageCount: sql<number>`SUM(CASE WHEN ${chatMessages.role} = 'user' THEN 1 ELSE 0 END)`,
    assistantMessageCount: sql<number>`SUM(CASE WHEN ${chatMessages.role} = 'assistant' THEN 1 ELSE 0 END)`,
  }).from(chatMessages).where(eq(chatMessages.chatId, chatId)).get();

  const usage = db.select({
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
  }).from(usageRecords)
    .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
    .where(eq(chatMessages.chatId, chatId))
    .get();

  const lastMessage = db.select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1)
    .get();

  return {
    messageCount: messageCounts?.messageCount ?? 0,
    userMessageCount: messageCounts?.userMessageCount ?? 0,
    assistantMessageCount: messageCounts?.assistantMessageCount ?? 0,
    totalInputTokens: usage?.totalInputTokens ?? 0,
    totalOutputTokens: usage?.totalOutputTokens ?? 0,
    totalCostUsd: usage?.totalCostUsd ?? 0,
    lastMessageAt: lastMessage?.createdAt ?? null,
  };
}

/** Resolve configDir from a keyId (if provided). */
function resolveKeyConfigDir(db: ReturnType<typeof getDb>, keyId?: number): string | undefined {
  if (!keyId) return undefined;
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, keyId)).get();
  return key?.configDir ?? undefined;
}

/**
 * Resolve which AI Provider Key id to use for a chat turn.
 * Order: explicit body.keyId → global defaultKeyId (if still active) → undefined.
 * Inactive defaults are silently skipped so a stale rc setting can't pin the
 * chat to a disabled key.
 */
function resolveChatKeyId(db: ReturnType<typeof getDb>, bodyKeyId: unknown): number | undefined {
  if (bodyKeyId !== undefined && bodyKeyId !== null) {
    const parsed = typeof bodyKeyId === "number" ? bodyKeyId : parseInt(String(bodyKeyId));
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const fallback = getDefaultKeyId();
  if (fallback === null) return undefined;
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, fallback)).get();
  if (!key || key.isActive === false) return undefined;
  return fallback;
}

/** Resolve working directory from chat's workspace or project. */
function resolveChatCwd(db: ReturnType<typeof getDb>, chat: typeof chats.$inferSelect): string {
  // 1. Workspace path takes priority
  if (chat.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).get();
    if (ws?.path) return ws.path;
  }
  // 2. Fall back to project path
  if (chat.projectId) {
    const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
    if (project?.path) return project.path;
  }
  // 3. Always default to flockctl home, never process.cwd()
  return getFlockctlHome();
}

/** Resolve project and workspace names for a chat. */
function resolveChatContext(db: ReturnType<typeof getDb>, chat: { projectId: number | null; workspaceId: number | null }) {
  let projectName: string | null = null;
  let workspaceName: string | null = null;
  if (chat.projectId) {
    const p = db.select({ name: projects.name }).from(projects).where(eq(projects.id, chat.projectId)).get();
    if (p) projectName = p.name;
  }
  if (chat.workspaceId) {
    const w = db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, chat.workspaceId)).get();
    if (w) workspaceName = w.name;
  }
  return { projectName, workspaceName };
}

/** Build an entity-aware system prompt from entity_context + project data. */
function buildEntitySystemPrompt(
  db: ReturnType<typeof getDb>,
  chat: typeof chats.$inferSelect,
  entityContext: { entity_type: string; entity_id: string; milestone_id?: string; slice_id?: string },
): string | undefined {
  if (!chat.projectId) return undefined;
  const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
  if (!project) return undefined;

  const projectPath = project.path ?? "";
  if (!projectPath) return undefined;

  const entityType = entityContext.entity_type;
  const entityId = entityContext.entity_id;

  // Resolve slugs
  let milestoneSlug: string | undefined;
  let sliceSlug: string | undefined;
  let taskSlug: string | undefined;

  if (entityType === "milestone") {
    milestoneSlug = entityId;
  } else if (entityType === "slice") {
    milestoneSlug = entityContext.milestone_id;
    sliceSlug = entityId;
  } else if (entityType === "task") {
    milestoneSlug = entityContext.milestone_id;
    sliceSlug = entityContext.slice_id;
    taskSlug = entityId;
  }

  // Read entity markdown file
  let entityContent = "";
  try {
    const planDir = getPlanDir(projectPath);
    let filePath: string;
    if (entityType === "milestone" && milestoneSlug) {
      filePath = join(planDir, milestoneSlug, "milestone.md");
    } else if (entityType === "slice" && milestoneSlug && sliceSlug) {
      filePath = join(planDir, milestoneSlug, sliceSlug, "slice.md");
    } else if (entityType === "task" && milestoneSlug && sliceSlug && taskSlug) {
      filePath = join(planDir, milestoneSlug, sliceSlug, `${taskSlug}.md`);
    } else {
      return undefined;
    }
    if (existsSync(filePath)) {
      entityContent = readFileSync(filePath, "utf-8");
    }
  } catch {
    // Entity file may not exist yet — proceed with no file context
  }

  const parts = [
    `You are an AI assistant helping with project planning for "${project.name}".`,
    `You are discussing a ${entityType}: "${entityId}".`,
  ];
  if (entityContent) {
    parts.push(`\nCurrent ${entityType} file content:\n\`\`\`markdown\n${entityContent}\n\`\`\``);
  }
  parts.push(
    `\nHelp the user refine this ${entityType}. You can discuss goals, structure, success criteria, and implementation details.`,
    `Keep responses focused and actionable. Use the project working directory: ${projectPath}`,
  );
  return parts.join("\n");
}

// POST /chats — create
chatRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();
  const result = db.insert(chats).values({
    projectId: body.projectId ?? null,
    workspaceId: body.workspaceId ?? null,
    title: body.title ?? null,
    entityType: body.entityType ?? null,
    entityId: body.entityId ?? null,
  }).returning().get();
  return c.json(result, 201);
});

// GET /chats — list
chatRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);
  const projectId = c.req.query("project_id");
  const workspaceId = c.req.query("workspace_id");
  const entityType = c.req.query("entity_type");
  const entityId = c.req.query("entity_id");

  const conditions = [];
  if (projectId) conditions.push(eq(chats.projectId, parseInt(projectId)));
  if (workspaceId) conditions.push(eq(chats.workspaceId, parseInt(workspaceId)));
  if (entityType) conditions.push(eq(chats.entityType, entityType));
  if (entityId) conditions.push(eq(chats.entityId, entityId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = db.select().from(chats).where(where).orderBy(desc(chats.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(chats).where(where).get()?.count ?? 0;

  const itemsWithMetrics = items.map(chat => ({
    ...chat,
    ...resolveChatContext(db, chat),
    metrics: getChatMetrics(db, chat.id),
  }));

  return c.json({ items: itemsWithMetrics, total, page, perPage });
});

// GET /chats/pending-permissions — live map of {chat_id: count} for active
// permission requests across all in-memory chat sessions. Used by the chat
// list to seed pending-approval badges on mount (WS events keep them fresh).
// Must be declared before `/:id` so Hono matches the literal path first.
chatRoutes.get("/pending-permissions", (c) => {
  const counts = chatExecutor.pendingPermissionCounts();
  const running = chatExecutor.runningChatIds();
  return c.json({
    pending: Object.fromEntries(
      Object.entries(counts).map(([id, n]) => [String(id), n]),
    ),
    running: running.map(String),
  });
});

// GET /chats/:id — with messages and metrics
chatRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  const messages = db.select().from(chatMessages).where(eq(chatMessages.chatId, id)).orderBy(chatMessages.createdAt).all();
  const metrics = getChatMetrics(db, id);
  const context = resolveChatContext(db, chat);
  const isRunning = chatExecutor.isRunning(id);
  return c.json({ ...chat, ...context, messages, metrics, isRunning });
});

/**
 * Resolve chat's project + workspace records (for permission mode inheritance
 * and allowed-roots computation).
 */
function resolveChatScope(db: ReturnType<typeof getDb>, chat: typeof chats.$inferSelect) {
  const project = chat.projectId
    ? db.select().from(projects).where(eq(projects.id, chat.projectId)).get()
    : undefined;
  const workspace = chat.workspaceId
    ? db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).get()
    : project?.workspaceId
      ? db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get()
      : undefined;
  const projectConfig = project?.path ? loadProjectConfig(project.path) : {};
  const workspaceConfig = workspace?.path ? loadWorkspaceConfig(workspace.path) : {};
  return { project, workspace, projectConfig, workspaceConfig };
}

/** Load prior chat history and split the new user message from the context. */
function loadPriorMessages(db: ReturnType<typeof getDb>, chatId: number) {
  const history = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(chatMessages.createdAt)
    .all();

  let msgs = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content as unknown,
  }));

  if (msgs.length > MAX_CHAT_MESSAGES) {
    msgs = msgs.slice(-MAX_CHAT_MESSAGES);
    if (msgs[0] && msgs[0].role !== "user") {
      msgs = msgs.slice(1);
    }
  }
  return msgs;
}

// POST /chats/:id/messages — send user message, get AI response
chatRoutes.post("/:id/messages", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  const body = await c.req.json();
  if (!body.content) throw new ValidationError("content is required");
  const role = body.role ?? "user";
  const content = body.content;
  const model = body.model ?? getDefaultModel();
  const system = body.system ?? "You are a helpful AI assistant.";
  const keyId = resolveChatKeyId(db, body.keyId);
  const configDir = resolveKeyConfigDir(db, keyId);

  // Save the incoming message
  const userMsg = db.insert(chatMessages).values({
    chatId: id,
    role,
    content,
  }).returning().get();

  // If role is not "user", just save and return (no AI call)
  if (role !== "user") {
    return c.json(userMsg, 201);
  }

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

  // priorMessages = history WITHOUT the just-inserted user message (we pass it
  // as `prompt` instead, so AgentSession appends it as the final user turn).
  const priorWithNew = loadPriorMessages(db, id);
  const priorMessages = priorWithNew.slice(0, -1);

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
    prompt: content,
    model,
    codebaseContext: "",
    workingDir: cwd,
    configDir,
    permissionMode,
    allowedRoots,
    resumeSessionId: chat.claudeSessionId ?? undefined,
    systemPromptOverride: system,
    useResumeContinuationPrompt: false,
    priorMessages,
  });

  let sessionId: string | undefined;
  session.on("session_id", (sid) => { sessionId = sid; });
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

    // Record usage
    const inputTokens = finalMetrics?.inputTokens ?? 0;
    const outputTokens = finalMetrics?.outputTokens ?? 0;
    const cacheCreationInputTokens = finalMetrics?.cacheCreationInputTokens ?? 0;
    const cacheReadInputTokens = finalMetrics?.cacheReadInputTokens ?? 0;
    const sdkCost = finalMetrics?.totalCostUsd ?? 0;
    const cost = sdkCost > 0
      ? sdkCost
      : provider.estimateCost(model, {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
        }) ?? 0;

    if (inputTokens > 0 || outputTokens > 0) {
      db.insert(usageRecords).values({
        chatMessageId: assistantMsg.id,
        projectId: chat.projectId,
        aiProviderKeyId: keyId ?? null,
        provider: "claude_cli",
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        totalCostUsd: cost,
      }).run();
    }

    return c.json({
      userMessage: userMsg,
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
chatRoutes.post("/:id/messages/stream", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  const body = await c.req.json();
  if (!body.content) throw new ValidationError("content is required");
  const content = body.content;
  const keyId = resolveChatKeyId(db, body.keyId);
  const configDir = resolveKeyConfigDir(db, keyId);

  // Build system prompt: entity_context takes priority, then explicit system, then default
  let system: string;
  const entityContext = body.entity_context as { entity_type: string; entity_id: string; milestone_id?: string; slice_id?: string } | undefined;
  if (entityContext?.entity_type && entityContext?.entity_id) {
    system = buildEntitySystemPrompt(db, chat, entityContext) ?? body.system ?? "You are a helpful AI assistant.";
  } else {
    system = body.system ?? "You are a helpful AI assistant.";
  }

  // Save the user message
  db.insert(chatMessages).values({ chatId: id, role: "user", content }).returning().get();

  // Resolve scope + permission mode
  const { project: chatProject, workspace: chatWorkspace, projectConfig, workspaceConfig } = resolveChatScope(db, chat);
  const model = body.model ?? projectConfig.model ?? getDefaultModel();
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

  const priorWithNew = loadPriorMessages(db, id);
  const priorMessages = priorWithNew.slice(0, -1);

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
    prompt: content,
    model,
    codebaseContext: "",
    workingDir: cwd,
    configDir,
    permissionMode,
    allowedRoots,
    resumeSessionId: chat.claudeSessionId ?? undefined,
    systemPromptOverride: system,
    useResumeContinuationPrompt: false,
    priorMessages,
  });

  return streamSSE(c, async (stream) => {
    let fullText = "";
    let returnedSessionId: string | undefined;
    let finalMetrics: AgentSessionMetrics | undefined;
    let clientDisconnected = false;
    let errorMsg: string | null = null;

    // Buffer events from AgentSession and pump to SSE as they happen.
    const textQueue: string[] = [];
    let resolveWait: (() => void) | null = null;
    const wakeWaiter = () => {
      if (resolveWait) { resolveWait(); resolveWait = null; }
    };
    const waitForNext = () => new Promise<void>((resolve) => { resolveWait = resolve; });

    session.on("text", (chunk) => {
      fullText += chunk;
      textQueue.push(chunk);
      wakeWaiter();
    });
    session.on("usage", (m) => { finalMetrics = m; });
    session.on("session_id", (sid) => { returnedSessionId = sid; });
    session.on("error", (err) => { errorMsg = err.message; });

    chatExecutor.register(id, session);
    let runFinished = false;
    const runPromise = session.run().catch((err: unknown) => {
      errorMsg = err instanceof Error ? err.message : String(err);
    }).finally(() => {
      runFinished = true;
      wakeWaiter();
    });

    let done = false;
    try {
      while (!done) {
        while (textQueue.length > 0) {
          const chunk = textQueue.shift()!;
          try {
            await stream.writeSSE({ data: JSON.stringify({ content: chunk }) });
          } catch { clientDisconnected = true; break; }
        }
        if (clientDisconnected) break;
        if (runFinished && textQueue.length === 0) { done = true; break; }
        await waitForNext();
      }
      await runPromise; // ensure all "text" events flushed
      // Drain any remaining text events
      /* v8 ignore start — defensive drain after stream end; race-only */
      while (textQueue.length > 0 && !clientDisconnected) {
        const chunk = textQueue.shift()!;
        try {
          await stream.writeSSE({ data: JSON.stringify({ content: chunk }) });
        } catch { clientDisconnected = true; }
      }
      /* v8 ignore stop */
    } catch (err: unknown) {
      /* v8 ignore next — defensive: writeSSE rarely throws outside disconnect */
      errorMsg = err instanceof Error ? err.message : String(err);
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

      // Save assistant response — always persist whatever text we collected so
      // an aborted/shutdown run doesn't leave the chat with a dangling user msg.
      const assistantMsg = db.insert(chatMessages).values({
        chatId: id,
        role: "assistant",
        content: fullText,
      }).returning().get();

      const inputTokens = finalMetrics?.inputTokens ?? 0;
      const outputTokens = finalMetrics?.outputTokens ?? 0;
      const cacheCreationInputTokens = finalMetrics?.cacheCreationInputTokens ?? 0;
      const cacheReadInputTokens = finalMetrics?.cacheReadInputTokens ?? 0;
      const sdkCost = finalMetrics?.totalCostUsd ?? 0;
      const cost = sdkCost > 0
        ? sdkCost
        : provider.estimateCost(model, {
            inputTokens,
            outputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
          }) ?? 0;

      if (inputTokens > 0 || outputTokens > 0) {
        db.insert(usageRecords).values({
          chatMessageId: assistantMsg.id,
          projectId: chat.projectId,
          aiProviderKeyId: keyId ?? null,
          provider: "claude_cli",
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
        if (returnedSessionId || chat.claudeSessionId) {
          await provider.renameSession?.((returnedSessionId || chat.claudeSessionId)!, `[FLOCKCTL] ${title}`);
        }
      } else {
        db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, id)).run();
      }

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

// POST /chats/:id/permission/:requestId — respond to a tool permission request
chatRoutes.post("/:id/permission/:requestId", async (c) => {
  const id = parseInt(c.req.param("id"));
  const requestId = c.req.param("requestId");
  const body = await c.req.json().catch(() => ({}));
  const behavior = body.behavior;

  if (behavior !== "allow" && behavior !== "deny") {
    throw new ValidationError("behavior must be 'allow' or 'deny'");
  }

  if (!chatExecutor.isRunning(id)) {
    throw new ValidationError("Chat session is not running");
  }

  const result = behavior === "allow"
    ? { behavior: "allow" as const }
    : { behavior: "deny" as const, message: body.message ?? "Denied by user" };

  const resolved = chatExecutor.resolvePermission(id, requestId, result);
  if (!resolved) {
    throw new NotFoundError("Permission request");
  }

  return c.json({ ok: true });
});

// POST /chats/:id/cancel — abort the currently running chat turn
chatRoutes.post("/:id/cancel", async (c) => {
  const id = parseInt(c.req.param("id"));
  const ok = chatExecutor.cancel(id);
  return c.json({ ok });
});

// GET /chats/:id/metrics — full usage metrics for a single chat
chatRoutes.get("/:id/metrics", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  const base = getChatMetrics(db, id);

  // Full metrics: also include cache tokens and models used
  const cacheUsage = db.select({
    totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationInputTokens}), 0)`,
    totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadInputTokens}), 0)`,
  }).from(usageRecords)
    .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
    .where(eq(chatMessages.chatId, id))
    .get();

  const modelsUsed = db.selectDistinct({ model: usageRecords.model })
    .from(usageRecords)
    .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
    .where(eq(chatMessages.chatId, id))
    .all()
    .map(r => r.model);

  return c.json({
    chatId: id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    ...base,
    totalCacheCreationTokens: cacheUsage?.totalCacheCreationTokens ?? 0,
    totalCacheReadTokens: cacheUsage?.totalCacheReadTokens ?? 0,
    modelsUsed,
  });
});

// DELETE /chats/:id
chatRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  db.delete(chats).where(eq(chats.id, id)).run();
  return c.json({ deleted: true });
});

// PATCH /chats/:id — update chat (title, etc.)
chatRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new NotFoundError("Chat");

  const body = await c.req.json();
  const updates: Partial<{ title: string; permissionMode: string | null; updatedAt: string }> = {};

  if ("title" in body && typeof body.title === "string") {
    updates.title = body.title.trim().slice(0, 200);
  }
  const permissionMode = parsePermissionModeBody(body);
  if (permissionMode !== undefined) {
    updates.permissionMode = permissionMode;
  }

  if (Object.keys(updates).length === 0) {
    throw new ValidationError("No valid fields to update");
  }

  updates.updatedAt = new Date().toISOString();
  const updated = db.update(chats).set(updates).where(eq(chats.id, id)).returning().get();

  if (updates.title && chat.claudeSessionId) {
    const provider = getAgent();
    await provider.renameSession?.(chat.claudeSessionId, `[FLOCKCTL] ${updates.title}`);
  }

  return c.json(updated);
});
