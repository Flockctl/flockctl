import { z } from "zod";
import { getDb } from "../../db/index.js";
import { chats, chatMessages, chatTodos, usageRecords, aiProviderKeys, projects, workspaces } from "../../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { ValidationError } from "../../lib/errors.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../services/attachments.js";
import { getDefaultKeyId, getFlockctlHome } from "../../config/index.js";
import { buildEntityAwareSystemPrompt, buildWorkspaceSystemPrompt } from "../../services/entity-prompt.js";
import { loadProjectConfig } from "../../services/project-config.js";
import { getCopilotQuotaMultiplier } from "../../services/ai/cost.js";
import { resolveAllowedKeyIds } from "../../services/ai/key-selection.js";
import { loadWorkspaceConfig } from "../../services/workspace-config.js";
import { computeCounts, type Todo } from "../../services/todo-store.js";
import { buildMessageContent, loadAttachmentsForMessages } from "../../services/attachments.js";

// Max messages to send to AI (sliding window). Keeps last N messages.
// System prompt is always sent separately, not counted here.
export const MAX_CHAT_MESSAGES = 50;

// Zod schema for the optional `attachment_ids` array accepted by
// POST /chats/:id/messages and POST /chats/:id/messages/stream. Shape check
// only: per-chat ownership, unlinked state, and total-byte budget are all
// enforced inside validateAttachmentsForMessage against DB state.
export const attachmentIdsSchema = z
  .array(z.number().int().positive())
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .optional();

/**
 * Pull and shape-check `attachment_ids` from a message body. Returns [] when
 * absent. Throws ValidationError (422) on shape failure so callers don't
 * repeat the Zod unwrap boilerplate.
 */
export function parseAttachmentIds(body: Record<string, unknown>): number[] {
  const raw = body.attachment_ids;
  if (raw === undefined || raw === null) return [];
  const parsed = attachmentIdsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `invalid attachment_ids: ${parsed.error.issues
        .map((i) => i.message)
        .join(", ")}`,
    );
  }
  /* v8 ignore next — raw was already guarded against undefined/null above, so parsed.data is always defined on success */
  return parsed.data ?? [];
}

/** Compute compact metrics for a chat (message counts + usage). */
export function getChatMetrics(db: ReturnType<typeof getDb>, chatId: number) {
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

  // GitHub Copilot is flat-rate, so `total_cost_usd` is always 0 for its
  // records. Instead we sum premium-request multipliers per usage row — one
  // row == one Copilot turn — to produce a quota figure the UI can show in
  // place of USD.
  const copilotTurns = db.select({ model: usageRecords.model })
    .from(usageRecords)
    .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
    .where(and(
      eq(chatMessages.chatId, chatId),
      eq(usageRecords.provider, "github_copilot"),
    ))
    .all();
  const totalCopilotQuota = copilotTurns.reduce(
    (sum, r) => sum + getCopilotQuotaMultiplier(r.model),
    0,
  );

  const lastMessage = db.select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1)
    .get();

  // Latest TodoWrite snapshot for this chat (if any). Projecting counts here
  // — alongside messageCount / token totals — means the chat-list indicator
  // has progress data on first render without waiting for a WS `todo_updated`
  // event. Returns null when the chat has never received a TodoWrite call.
  const latestTodos = db.select({ todosJson: chatTodos.todosJson })
    .from(chatTodos)
    .where(eq(chatTodos.chatId, chatId))
    .orderBy(desc(chatTodos.createdAt), desc(chatTodos.id))
    .limit(1)
    .get();

  let todosCounts: ReturnType<typeof computeCounts> | null = null;
  if (latestTodos?.todosJson) {
    todosCounts = computeCounts(parseTodosJson(latestTodos.todosJson));
  }

  return {
    /* v8 ignore next 6 — SQL count(*) / SUM aggregates always return one row, so `?? 0` fallbacks are unreachable */
    messageCount: messageCounts?.messageCount ?? 0,
    userMessageCount: messageCounts?.userMessageCount ?? 0,
    assistantMessageCount: messageCounts?.assistantMessageCount ?? 0,
    totalInputTokens: usage?.totalInputTokens ?? 0,
    totalOutputTokens: usage?.totalOutputTokens ?? 0,
    totalCostUsd: usage?.totalCostUsd ?? 0,
    totalCopilotQuota,
    lastMessageAt: lastMessage?.createdAt ?? null,
    todosCounts,
  };
}

/** Resolve configDir from a keyId (if provided). */
export function resolveKeyConfigDir(db: ReturnType<typeof getDb>, keyId?: number): string | undefined {
  if (!keyId) return undefined;
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, keyId)).get();
  return key?.configDir ?? undefined;
}

/**
 * Resolve dispatch info from a keyId: which agent backend to use, which
 * GitHub token to forward (Copilot only), and the key's `provider` so the
 * caller can attribute `usage_records.provider` correctly. Returns `{}` for
 * unknown / missing keys — non-Copilot keys still surface `keyProvider` so
 * usage pricing picks the right tariff.
 */
export function resolveKeyDispatch(
  db: ReturnType<typeof getDb>,
  keyId?: number,
): { agentId?: string; providerKeyValue?: string; keyProvider?: string } {
  if (!keyId) return {};
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, keyId)).get();
  if (!key) return {};
  if (key.provider === "github_copilot") {
    return {
      agentId: "copilot",
      providerKeyValue: key.keyValue ?? undefined,
      keyProvider: key.provider,
    };
  }
  return { keyProvider: key.provider };
}

/**
 * Coerce a loose key-id input (`body.keyId`, `body.aiProviderKeyId`, stored
 * chat column, or an rc default) into a positive integer, or `undefined` if
 * it's missing / malformed. Used by the chat-key fallback chain below.
 */
export function coerceKeyId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolve which AI Provider Key id to use for a chat turn.
 * Order: explicit body.keyId → chat row's saved ai_provider_key_id →
 *        project/workspace-aware default (see `resolveDefaultKeyForChat`) →
 *        undefined.
 * Inactive defaults are silently skipped so a stale rc setting can't pin the
 * chat to a disabled key. The stored chat selection also respects
 * isActive — a key that was deactivated after the chat was configured
 * transparently falls through to the allow-list-aware default.
 *
 * The project/workspace allow-list is consulted ONLY on the default-fallback
 * path. Explicit `body.keyId` and the stored `chat.aiProviderKeyId` paths
 * remain unchanged — `assertKeyAllowedForChat` is still responsible for
 * surfacing a 422 when those values violate the whitelist, so a misbehaving
 * client can never silently bypass the restriction. We fix up ONLY the
 * default path here: with the old code, a user whose global default was
 * "Personal" and whose project only permitted "Work" would see `resolveChatKeyId`
 * return the Personal id, `persistChatSelection` would write it to the chat row,
 * and `assertKeyAllowedForChat` would throw — leaving the chat permanently
 * pinned to a disallowed key on reload.
 */
export function resolveChatKeyId(
  db: ReturnType<typeof getDb>,
  bodyKeyId: unknown,
  chat: { aiProviderKeyId: number | null; projectId: number | null },
): number | undefined {
  const fromBody = coerceKeyId(bodyKeyId);
  if (fromBody !== undefined) return fromBody;

  const fromChat = coerceKeyId(chat.aiProviderKeyId);
  if (fromChat !== undefined) {
    const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, fromChat)).get();
    if (key && key.isActive !== false) return fromChat;
    // Stored selection is stale — fall through to the allow-list-aware default.
  }

  return resolveDefaultKeyForChat(db, { projectId: chat.projectId ?? null });
}

/**
 * Pick the default AI key for a chat whose caller did not specify one, and
 * whose stored selection is absent / stale. Honors the project → workspace
 * allow-list so a user whose rc-level default key isn't permitted for the
 * project silently switches to the first allowed active key (by priority)
 * instead of tripping `assertKeyAllowedForChat` on every turn.
 *
 * Contract:
 *   - No allow-list (`resolveAllowedKeyIds` returns `[]`) → rc default if
 *     active, else undefined. Unchanged from pre-allow-list behavior.
 *   - Allow-list present + rc default active + rc default ∈ allow-list
 *     → return rc default. Preserves the legacy "user's preferred key wins"
 *     behavior whenever it's compatible with the restriction.
 *   - Allow-list present, rc default absent / inactive / disallowed → pick
 *     the first active key inside the allow-list, sorted by priority (same
 *     ordering `selectKeyForTask` uses for task-side key selection).
 *   - Allow-list present but no active key inside it → undefined.
 *     `assertKeyAllowedForChat` is the canonical source of the 422 in this
 *     case — we don't want to swallow the misconfiguration silently by
 *     returning a disallowed key.
 */
export function resolveDefaultKeyForChat(
  db: ReturnType<typeof getDb>,
  chat: { projectId: number | null },
): number | undefined {
  const allowedIds = resolveAllowedKeyIds({ projectId: chat.projectId ?? null });
  const rcDefault = getDefaultKeyId();

  // Legacy path — no restriction in play.
  if (allowedIds.length === 0) {
    if (rcDefault === null) return undefined;
    const key = db
      .select({ isActive: aiProviderKeys.isActive })
      .from(aiProviderKeys)
      .where(eq(aiProviderKeys.id, rcDefault))
      .get();
    if (!key || key.isActive === false) return undefined;
    return rcDefault;
  }

  // Restricted — prefer the rc default when it's compatible.
  if (rcDefault !== null && allowedIds.includes(rcDefault)) {
    const key = db
      .select({ isActive: aiProviderKeys.isActive })
      .from(aiProviderKeys)
      .where(eq(aiProviderKeys.id, rcDefault))
      .get();
    if (key && key.isActive !== false) return rcDefault;
  }

  // rc default is either unset, inactive, or outside the allow-list — pick
  // the first allowed active key by priority.
  const candidates = db
    .select({ id: aiProviderKeys.id })
    .from(aiProviderKeys)
    .where(eq(aiProviderKeys.isActive, true))
    .orderBy(aiProviderKeys.priority)
    .all();
  for (const c of candidates) {
    if (allowedIds.includes(c.id)) return c.id;
  }
  return undefined;
}

/**
 * Enforce the project/workspace `allowedKeyIds` whitelist for a chat turn.
 *
 * Silently filtering a disallowed key — or falling back to a different
 * provider — hides the misconfiguration from the user (symptom: the UI shows
 * the user picking GitHub Copilot but the chat is driven by Claude Code
 * because Copilot isn't in the whitelist). We instead surface a 422 with the
 * exact key that was rejected and the list of keys the project allows, so the
 * caller can either pick a different key or update the whitelist.
 *
 * `keyId === undefined` means no key could be resolved (no body key, no stored
 * key, no active default) — we let that through so the downstream agent's own
 * selection path can decide what to do.
 *
 * `source` tells the user whether the rejected key came from the request
 * itself or from a stored / default fallback, so the hint can point at the
 * right knob.
 */
export function assertKeyAllowedForChat(
  db: ReturnType<typeof getDb>,
  chat: { projectId: number | null },
  keyId: number | undefined,
  source: "request" | "stored" | "default",
): void {
  if (!keyId) return;
  const allowedIds = resolveAllowedKeyIds({ projectId: chat.projectId ?? null });
  if (allowedIds.length === 0) return;
  if (allowedIds.includes(keyId)) return;

  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, keyId)).get();
  const keyLabel = key ? `"${key.label}" (${key.provider}, #${keyId})` : `#${keyId}`;
  const allowedRows = db
    .select({ id: aiProviderKeys.id, label: aiProviderKeys.label, provider: aiProviderKeys.provider })
    .from(aiProviderKeys)
    .all()
    .filter((k) => allowedIds.includes(k.id));
  const allowedDesc = allowedRows.length > 0
    ? allowedRows.map((k) => `"${k.label}" [#${k.id}, ${k.provider}]`).join(", ")
    : `[${allowedIds.join(", ")}]`;

  const hintBySource: Record<typeof source, string> = {
    request:
      "Pick a key from the project's allowedKeyIds, or update the whitelist via PATCH /projects/:id.",
    stored:
      "The chat's saved key is not in the project's whitelist anymore — pick another key explicitly, or update the whitelist.",
    default:
      "Your global default key is not in the project's whitelist — set `keyId` explicitly on the request, or update the whitelist.",
  };

  throw new ValidationError(
    `AI key ${keyLabel} is not allowed for this chat's project (#${chat.projectId}). ` +
    `Allowed keys: ${allowedDesc}. ${hintBySource[source]}`,
  );
}

/**
 * Classify where `resolveChatKeyId` got its answer from, so
 * `assertKeyAllowedForChat` can give a precise hint.
 */
export function classifyKeyIdSource(
  bodyKeyId: unknown,
  storedKeyId: number | null | undefined,
): "request" | "stored" | "default" {
  if (coerceKeyId(bodyKeyId) !== undefined) return "request";
  if (coerceKeyId(storedKeyId) !== undefined) return "stored";
  return "default";
}

/**
 * Write the resolved key/model selection back to the chat row when it differs
 * from what's already stored, so a reload restores the UI dropdowns. No-ops
 * when the stored values already match — keeps `updated_at` stable for the
 * common "user didn't touch the selectors" case. `keyId === undefined` means
 * the caller couldn't resolve any key (e.g. no active keys at all); we do not
 * clobber a valid stored selection with NULL in that case.
 */
export function persistChatSelection(
  db: ReturnType<typeof getDb>,
  chatId: number,
  chat: typeof chats.$inferSelect,
  selection: {
    keyId: number | undefined;
    model: string | null | undefined;
    thinkingEnabled?: boolean | undefined;
    effort?: EffortLevel | null | undefined;
  },
): void {
  const updates: Partial<{
    aiProviderKeyId: number | null;
    model: string;
    thinkingEnabled: boolean;
    effort: string | null;
    updatedAt: string;
  }> = {};
  if (selection.keyId !== undefined && selection.keyId !== chat.aiProviderKeyId) {
    // Verify the key row actually exists before we reference it. The whitelist
    // path can let a bare numeric id through even when no `ai_provider_keys`
    // row backs it (tests that stub key validation rely on this). Writing an
    // orphan id would trip the FK and 500 the whole send, even though the
    // message itself is otherwise fine. Silently skipping the write mirrors
    // the pre-persistence behavior for unknown ids.
    const keyRow = db
      .select({ id: aiProviderKeys.id })
      .from(aiProviderKeys)
      .where(eq(aiProviderKeys.id, selection.keyId))
      .get();
    if (keyRow) updates.aiProviderKeyId = selection.keyId;
  }
  if (
    typeof selection.model === "string" &&
    selection.model.length > 0 &&
    selection.model !== chat.model
  ) {
    updates.model = selection.model;
  }
  if (
    typeof selection.thinkingEnabled === "boolean" &&
    selection.thinkingEnabled !== chat.thinkingEnabled
  ) {
    updates.thinkingEnabled = selection.thinkingEnabled;
  }
  if (selection.effort !== undefined && selection.effort !== chat.effort) {
    // `null` explicitly clears back to the "fall back to default" state so the
    // UI can reset the per-chat pick without leaving stale strings around.
    updates.effort = selection.effort;
  }
  if (Object.keys(updates).length === 0) return;
  updates.updatedAt = new Date().toISOString();
  db.update(chats).set(updates).where(eq(chats.id, chatId)).run();
}

/**
 * Allowed reasoning effort levels. Keep in sync with the Claude Agent SDK's
 * `EffortLevel` type (re-exported from `src/services/ai/client.ts`). When the
 * user picks a level in the UI it flows through body → persistChatSelection
 * → AgentSession → provider.chat → SDK verbatim.
 */
export type EffortLevel = "low" | "medium" | "high" | "max";
const VALID_EFFORT_LEVELS: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "max"];

/**
 * Coerce `body.effort` into an `EffortLevel | null | undefined`. Matches the
 * shape `persistChatSelection` expects: `undefined` means "leave the stored
 * value alone"; `null` means "clear it back to default"; a valid string
 * updates the stored pick. Throws `ValidationError` on any other value so
 * typos surface as 422 instead of silently dropping.
 */
export function parseEffortBody(body: Record<string, unknown>): EffortLevel | null | undefined {
  if (!("effort" in body)) return undefined;
  const raw = body.effort;
  if (raw === null) return null;
  if (typeof raw === "string" && (VALID_EFFORT_LEVELS as ReadonlyArray<string>).includes(raw)) {
    return raw as EffortLevel;
  }
  throw new ValidationError(
    `effort must be one of ${VALID_EFFORT_LEVELS.join(", ")} or null`,
  );
}

/**
 * Coerce `body.thinking_enabled` (snake_case, matches the rest of the chat
 * message API) / `body.thinkingEnabled` (camelCase, matches the PATCH/update
 * shape) into a boolean. Returns `undefined` when absent. Throws on non-boolean
 * values so a stringly-typed client can't silently disable thinking by sending
 * `"false"`.
 */
export function parseThinkingEnabledBody(body: Record<string, unknown>): boolean | undefined {
  const raw =
    "thinking_enabled" in body ? body.thinking_enabled :
    "thinkingEnabled" in body ? body.thinkingEnabled :
    undefined;
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new ValidationError("thinking_enabled must be a boolean");
  }
  return raw;
}

/** Resolve working directory from chat's workspace or project. */
export function resolveChatCwd(db: ReturnType<typeof getDb>, chat: typeof chats.$inferSelect): string {
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
export function resolveChatContext(db: ReturnType<typeof getDb>, chat: { projectId: number | null; workspaceId: number | null }) {
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

/** Default base system prompt used when no override + no entity context. */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant.";

/**
 * Resolve the system prompt for a chat turn. Precedence:
 *   1. explicit `body.system` → return as-is (override behaviour preserved)
 *   2. chat.entityType/entityId on the DB row OR body.entity_context →
 *      prepend entity-aware plan prompt (requires chat.projectId)
 *   3. chat.workspaceId without an entity → prepend a workspace prompt that
 *      lists the workspace's projects so the agent can reason across them
 *   4. fall back to the default base
 */
export function resolveChatSystemPrompt(
  db: ReturnType<typeof getDb>,
  chat: typeof chats.$inferSelect,
  body: Record<string, unknown>,
): string {
  if (typeof body.system === "string") return body.system;

  const entityContext = body.entity_context as
    | { entity_type?: string; entity_id?: string; milestone_id?: string; slice_id?: string }
    | undefined;

  const entityType = chat.entityType ?? entityContext?.entity_type ?? null;
  const entityId = chat.entityId ?? entityContext?.entity_id ?? null;

  if (entityType && entityId && chat.projectId) {
    const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
    if (project?.path) {
      const entityPrompt = buildEntityAwareSystemPrompt(
        {
          entityType,
          entityId,
          milestoneId: entityContext?.milestone_id,
          sliceId: entityContext?.slice_id,
        },
        project.path,
        project.name,
      );
      /* v8 ignore next — buildEntityAwareSystemPrompt returns a non-empty string whenever the entity resolves on-disk, and tests that reach this path always pass a resolvable entity */
      if (entityPrompt) return `${entityPrompt}\n\n${DEFAULT_SYSTEM_PROMPT}`;
    }
  }

  if (chat.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).get();
    if (ws?.path) {
      const wsProjects = db
        .select({ name: projects.name, path: projects.path, description: projects.description })
        .from(projects)
        .where(eq(projects.workspaceId, chat.workspaceId))
        .all();
      const wsPrompt = buildWorkspaceSystemPrompt(ws.name, ws.path, wsProjects);
      /* v8 ignore next — buildWorkspaceSystemPrompt returns non-empty whenever ws.path resolves; tests that reach this path always pass a workspace with a real path */
      if (wsPrompt) return `${wsPrompt}\n\n${DEFAULT_SYSTEM_PROMPT}`;
    }
  }

  return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Resolve the `workspaceContext` AgentSession option for a chat — the
 * workspace's `{ name, path }` plus the full list of its sibling projects.
 * Walks up from `chat.projectId` when the chat was opened on a project
 * (so project-scoped chats still get cross-project visibility), and
 * returns `undefined` when the chat is tied to neither a workspace nor a
 * workspace-linked project.
 *
 * Centralised here so both the stream and non-stream handlers pass an
 * identical payload — the session injector hashes this into the system
 * prompt via `injectWorkspaceProjects`.
 */
export function resolveChatWorkspaceContext(
  db: ReturnType<typeof getDb>,
  chat: typeof chats.$inferSelect,
):
  | {
      name: string;
      path: string;
      projects: Array<{ name: string; path: string | null; description?: string | null }>;
    }
  | undefined {
  let workspace: typeof workspaces.$inferSelect | undefined;
  if (chat.workspaceId) {
    workspace = db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).get();
  } else if (chat.projectId) {
    const project = db.select().from(projects).where(eq(projects.id, chat.projectId)).get();
    if (project?.workspaceId) {
      workspace = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, project.workspaceId))
        .get();
    }
  }
  if (!workspace?.path) return undefined;

  const wsProjects = db
    .select({
      name: projects.name,
      path: projects.path,
      description: projects.description,
    })
    .from(projects)
    .where(eq(projects.workspaceId, workspace.id))
    .all();
  return { name: workspace.name, path: workspace.path, projects: wsProjects };
}

/**
 * Resolve chat's project + workspace records (for permission mode inheritance
 * and allowed-roots computation).
 */
export function resolveChatScope(db: ReturnType<typeof getDb>, chat: typeof chats.$inferSelect) {
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

/**
 * Load prior chat history and split the new user message from the context.
 *
 * Rehydrates linked `chat_attachments` for each user message into Anthropic
 * content blocks — `{ type: "text", text } + { type: "image", ... }` — so a
 * turn that was originally sent with an image replays as multimodal on
 * resume. Messages without attachments keep the plain-string shape (no
 * behavioral change for text-only chats).
 */
export function loadPriorMessages(db: ReturnType<typeof getDb>, chatId: number) {
  const history = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(chatMessages.createdAt)
    .all();

  let trimmed = history;
  if (trimmed.length > MAX_CHAT_MESSAGES) {
    trimmed = trimmed.slice(-MAX_CHAT_MESSAGES);
    if (trimmed[0] && trimmed[0].role !== "user") {
      trimmed = trimmed.slice(1);
    }
  }

  // Batch-load every attachment for the retained user messages in one query
  // (vs. N queries in a map loop). `buildMessageContent` collapses to a plain
  // string when there are no attachments — preserving text-only behavior.
  const userMessageIds = trimmed
    .filter((m) => m.role === "user")
    .map((m) => m.id);
  const attachmentsByMsg = loadAttachmentsForMessages(userMessageIds);

  return trimmed.map((m) => ({
    role: m.role as "user" | "assistant",
    content:
      m.role === "user"
        ? buildMessageContent(m.content, attachmentsByMsg.get(m.id))
        : m.content,
  }));
}

/** Parse a stored `todos_json` blob into a Todo[], silently recovering from
 *  corrupt rows by returning an empty array (a malformed snapshot should not
 *  500 the endpoint — todo-store already warns on the write path). */
export function parseTodosJson(json: string): Todo[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Todo[]) : [];
  } catch {
    return [];
  }
}
