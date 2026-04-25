import type {
  PaginatedResponse,
  ChatCreate,
  ChatResponse,
  ChatDetailResponse,
  ChatMessageCreate,
  ChatMessageResponse,
  ChatFullMetrics,
  ChatUpdate,
} from "../types";
import { apiFetch, getApiBaseUrl, getAuthHeaders } from "./core";
import type { PendingPermissionItem } from "./tasks";

export function createChat(data: ChatCreate): Promise<ChatResponse> {
  return apiFetch<ChatResponse>("/chats", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Fetch the synthesized per-chat diff — covers every Edit/Write/MultiEdit
 * tool call made over the chat's lifetime. Payload shape matches
 * `fetchTaskDiff` so the UI can reuse the same `<InlineDiff>` renderer.
 */
export function fetchChatDiff(chatId: string): Promise<{
  summary: string | null;
  diff: string;
  truncated: boolean;
  total_lines: number;
  total_files: number;
  total_entries: number;
}> {
  return apiFetch(`/chats/${chatId}/diff`);
}

export function fetchChats(params?: {
  projectId?: string;
  workspaceId?: string;
  entityType?: string;
  entityId?: string;
  q?: string;
}): Promise<ChatResponse[]> {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set("project_id", params.projectId);
  if (params?.workspaceId) qs.set("workspace_id", params.workspaceId);
  if (params?.entityType) qs.set("entity_type", params.entityType);
  if (params?.entityId) qs.set("entity_id", params.entityId);
  if (params?.q && params.q.trim().length > 0) qs.set("q", params.q.trim());
  const query = qs.toString();
  return apiFetch<PaginatedResponse<ChatResponse>>(`/chats${query ? `?${query}` : ""}`).then((r) => r.items);
}

export function fetchEntityChat(projectId: string, entityType: string, entityId: string): Promise<ChatDetailResponse | null> {
  const qs = new URLSearchParams({ project_id: projectId, entity_type: entityType, entity_id: entityId });
  return apiFetch<PaginatedResponse<ChatResponse>>(`/chats?${qs.toString()}`).then((r) => {
    const first = r.items[0];
    if (!first) return null;
    return apiFetch<ChatDetailResponse>(`/chats/${first.id}`);
  });
}

/**
 * Fetch the entity-scoped chat for (project, entityType, entityId) or create
 * one if it doesn't exist yet. The backend `POST /chats` is itself idempotent
 * on this triple (see src/routes/chats.ts), so the create call also acts as
 * a safety net in case two browser tabs race on the same entity — both end up
 * pointing at the same chat row.
 *
 * Returns the chatId as a string (matching the rest of the UI's stringified-id
 * convention) so callers can feed it straight into `useChat` or the streaming
 * hook without further conversion.
 */
export async function getOrCreateEntityChat(
  projectId: string,
  entityType: string,
  entityId: string,
): Promise<{ id: string }> {
  const existing = await fetchEntityChat(projectId, entityType, entityId);
  if (existing) return { id: existing.id };
  // `projectId` comes in stringified (UI convention); backend expects numeric.
  const created = await createChat({
    projectId: parseInt(projectId),
    entityType,
    entityId,
  });
  return { id: created.id };
}

export function fetchChat(chatId: string): Promise<ChatDetailResponse> {
  return apiFetch<ChatDetailResponse>(`/chats/${chatId}`);
}

export function sendMessage(
  chatId: string,
  data: ChatMessageCreate,
): Promise<ChatMessageResponse> {
  return apiFetch<ChatMessageResponse>(`/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function streamMessage(
  chatId: string,
  data: ChatMessageCreate,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${getApiBaseUrl()}/chats/${chatId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(data),
    signal,
  });
}

export function deleteChat(chatId: string): Promise<void> {
  return apiFetch<void>(`/chats/${chatId}`, { method: "DELETE" });
}

export function updateChat(chatId: string, data: ChatUpdate): Promise<ChatResponse> {
  return apiFetch<ChatResponse>(`/chats/${chatId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function fetchChatMetrics(chatId: string): Promise<ChatFullMetrics> {
  return apiFetch<ChatFullMetrics>(`/chats/${chatId}/metrics`);
}

/**
 * Backend row shape for a persisted chat attachment. The `id` is numeric
 * because it's the SQLite primary key — callers forward it through the
 * `attachment_ids[]` field on the next send.
 */
export interface ChatAttachmentResponse {
  id: number;
  chat_id: number;
  message_id: number | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  path: string;
  created_at: string;
}

/**
 * Upload one image blob to `POST /chats/:id/attachments`. Uses `FormData` so
 * the request hits the same multipart handler that the drag-drop uploader
 * relies on. Bypasses `apiFetch` entirely — that helper forces a JSON
 * content-type and runs outgoing keys through camelCase conversion, neither
 * of which is correct here.
 *
 * Client-side validation (image MIME, ≤10MB, ≤10 chips per message) lives in
 * the composer; this helper only does the network round-trip. The server
 * re-checks everything — magic bytes, declared MIME, and the size gate — so
 * the UI can't bypass the hard limits by patching the check.
 */
export async function uploadChatAttachment(
  chatId: string,
  file: File,
): Promise<ChatAttachmentResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${getApiBaseUrl()}/chats/${chatId}/attachments`, {
    method: "POST",
    headers: { ...getAuthHeaders() },
    body: fd,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errBody.error ?? errBody.detail ?? `Upload failed (${res.status})`);
  }
  // Raw camelCase JSON straight from Drizzle — don't run it through
  // `toSnakeKeys` because that helper stringifies every `*id` field, and the
  // server's `parseAttachmentIds` validator requires numeric ids. Map the
  // handful of keys the UI consumes manually so the shape still matches the
  // declared interface.
  const json = (await res.json()) as {
    id: number;
    chatId: number;
    messageId: number | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    path: string;
    createdAt: string;
  };
  return {
    id: json.id,
    chat_id: json.chatId,
    message_id: json.messageId,
    filename: json.filename,
    mime_type: json.mimeType,
    size_bytes: json.sizeBytes,
    path: json.path,
    created_at: json.createdAt,
  };
}

export interface ChatTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  active_form?: string;
  priority?: string;
}

export interface ChatTodoCounts {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
}

export interface ChatTodosSnapshot {
  id: number;
  created_at: string;
  todos: ChatTodoItem[];
}

export interface ChatTodosResponse {
  snapshot: ChatTodosSnapshot;
  counts: ChatTodoCounts;
}

/**
 * Latest TodoWrite snapshot + pre-computed counts for a chat. Resolves to
 * `null` when the chat exists but has never received a TodoWrite call (the
 * server responds 204, which `apiFetch` surfaces as `undefined`). Errors
 * (404 / network) propagate so the query layer can react to them.
 *
 * Mirrors the naming of sibling helpers (`fetchChat`, `fetchChatMetrics`).
 */
export async function fetchChatTodos(
  chatId: string,
): Promise<ChatTodosResponse | null> {
  const res = await apiFetch<ChatTodosResponse | undefined>(
    `/chats/${chatId}/todos`,
  );
  return res ?? null;
}

/**
 * One TodoWrite snapshot in the paginated history — the full todos array plus
 * pre-computed counts so the drawer can render the timeline entry (timestamp +
 * counts) without re-parsing the body on every render.
 */
export interface ChatTodoHistoryItem {
  id: number;
  created_at: string;
  /**
   * SDK `parent_tool_use_id` carried with the snapshot. NULL = main agent;
   * a `toolu_…` id identifies a sub-agent spawned via the Task tool. Lets
   * the drawer attribute live-loaded snapshots to the right tab without
   * cross-referencing the agents endpoint.
   */
  parent_tool_use_id: string | null;
  todos: ChatTodoItem[];
  counts: ChatTodoCounts;
}

/**
 * Server envelope for `GET /chats/:id/todos/history`. Field casing after
 * `apiFetch`'s camelCase → snake_case conversion: `per_page` (not `perPage`).
 */
export interface ChatTodoHistoryPage {
  items: ChatTodoHistoryItem[];
  total: number;
  page: number;
  per_page: number;
}

/**
 * Paginated list of TodoWrite snapshots for a chat, newest first. The UI uses
 * offset/limit ("cursor" = current offset) to power a `load more` button in
 * `<TodoHistoryDrawer>`. The server mirrors this on the `paginationParams`
 * helper — see `GET /chats/:id/todos/history`.
 */
export function fetchChatTodoHistory(
  chatId: string,
  offset = 0,
  limit = 20,
  /** Optional agent filter — `MAIN_AGENT_KEY` (`"main"`) for the main agent,
   *  a `toolu_…` id for a specific sub-agent, or `undefined` to keep the
   *  legacy mixed-agent feed (used by callers that pre-date the tabs UI). */
  agent?: string,
): Promise<ChatTodoHistoryPage> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  if (agent) params.set("agent", agent);
  return apiFetch<ChatTodoHistoryPage>(
    `/chats/${chatId}/todos/history?${params.toString()}`,
  );
}

/**
 * Sentinel agent key for the main agent (matches `MAIN_AGENT_KEY` on the
 * backend). NULL on the wire would be ambiguous — `?agent=` could mean
 * "main" or "missing" — so the API uses this reserved literal instead.
 */
export const MAIN_AGENT_KEY = "main";

/**
 * One todo enriched with the timestamp at which it first transitioned to
 * "completed" within the agent's snapshot timeline. NULL when the todo
 * isn't completed yet.
 */
export interface ChatTodoWithCompletedAt extends ChatTodoItem {
  completed_at: string | null;
}

/**
 * One agent's row in `GET /chats/:id/todos/agents`. The drawer renders one
 * tab per item; the `latest` snapshot is shown expanded and `snapshot_count`
 * controls whether the "older snapshots" collapsible appears underneath.
 */
export interface ChatTodoAgent {
  /** `MAIN_AGENT_KEY` for the main agent, otherwise the SDK `toolu_…` id.
   *  Used as the `?agent=` value when the drawer fetches paginated history
   *  for this tab. */
  key: string;
  parent_tool_use_id: string | null;
  /** Tab label — "Main agent" for the top-level timeline, the spawning
   *  Task call's `description` for sub-agents, or a synthesised
   *  `Sub-agent <id-prefix>` when the spawning call can't be resolved. */
  label: string;
  /** Optional sub-agent classification (e.g. "general-purpose") plumbed
   *  from the Task input — the drawer renders it as a chip next to the
   *  label. */
  subagent_type: string | null;
  snapshot_count: number;
  latest: {
    id: number;
    created_at: string;
    todos: ChatTodoWithCompletedAt[];
    counts: ChatTodoCounts;
  } | null;
}

export interface ChatTodoAgentsResponse {
  items: ChatTodoAgent[];
}

/**
 * Fetch the per-agent grouping that powers the tabs in the Todo history
 * drawer. Returns one item per distinct `parent_tool_use_id` (NULL =
 * main agent, anything else = a sub-agent spawned via Task) with the
 * latest snapshot's todos pre-annotated with `completed_at`.
 */
export function fetchChatTodoAgents(
  chatId: string,
): Promise<ChatTodoAgentsResponse> {
  return apiFetch<ChatTodoAgentsResponse>(`/chats/${chatId}/todos/agents`);
}

export function respondToChatPermission(
  chatId: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/permission/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ behavior, message }),
  });
}

export function cancelChatRun(chatId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/cancel`, { method: "POST" });
}

// Chat approval — symmetric with `approveTask`/`rejectTask`. A chat created
// with `requiresApproval=true` flips to `approvalStatus='pending'` after each
// successful assistant turn and surfaces in `/attention` as a `chat_approval`
// blocker. These helpers clear that blocker (the server fires
// `attention_changed` on success).
export function approveChat(chatId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function rejectChat(chatId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/chats/${chatId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export interface ChatsLiveState {
  pending: Record<string, number>;
  running: string[];
}

/** Snapshot of in-memory chat sessions: pending permission counts + running chat ids. */
export function fetchPendingChatPermissions(): Promise<ChatsLiveState> {
  return apiFetch<ChatsLiveState>(`/chats/pending-permissions`);
}

export function fetchChatPendingPermissions(
  chatId: string,
): Promise<{ items: PendingPermissionItem[] }> {
  return apiFetch(`/chats/${chatId}/pending-permissions`);
}
