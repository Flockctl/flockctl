import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamMessage, cancelChatRun } from "../api";
import type {
  ChatDetailResponse,
  ChatMessageCreate,
  ChatMessageResponse,
  LiveChatBlock,
} from "../types";
import { queryKeys } from "./core";

/**
 * Drives the `POST /chats/:id/messages/stream` SSE endpoint and exposes the
 * live response as an ordered array of `LiveChatBlock`s. Each SSE event
 * (content / thinking / tool_call / tool_result) maps to one block; text and
 * thinking chunks coalesce into the last open text/thinking block until a
 * boundary (another kind of event, or stream end) closes it out. This is
 * what lets the UI render a Claude-Code-style transcript where tool calls
 * appear interleaved with intermediate text, rather than three separate
 * buckets merged post-hoc on `done`.
 *
 * The hook keeps `liveBlocks` populated across the `done` boundary; we no
 * longer invalidate the chat query on every stream end because that caused
 * a visible re-render flash where the live transcript disappeared and then
 * reloaded from the DB. The chat query is invalidated ONLY for lists
 * (`chats`, `entityChat`, `projectTree`) that need fresh metadata — the main
 * `chat(chatId)` query is left alone, and the Live blocks remain on screen
 * until the user next refetches manually (e.g. page navigation).
 *
 * Queue (Claude-Code-style): if the caller sends a new message while a turn
 * is already running, `enqueueMessage` appends it to `queuedMessages`. The
 * drain effect below picks the next queued item up the moment `isStreaming`
 * flips back to false and kicks off its stream automatically. `cancelStream`
 * only aborts the currently-running turn — the queue is left intact so
 * pressing Esc mid-turn behaves exactly like Claude Code: the current
 * response stops, the next queued prompt takes over.
 */
export interface QueuedChatMessage {
  id: string;
  chatId: string;
  data: ChatMessageCreate;
  opts?: { projectId?: string };
}

export function useChatStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveBlocks, setLiveBlocks] = useState<LiveChatBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks the chatId of the currently-streaming turn so cancelStream can
  // tell the server which session to abort. Set at the top of startStream,
  // cleared in its `finally` — outside of an active stream it's null and
  // cancelStream becomes a no-op for the backend side.
  const streamingChatIdRef = useRef<string | null>(null);
  const blockCounterRef = useRef(0);
  const queueCounterRef = useRef(0);
  const lastInvalidationRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const appendChunk = useCallback(
    (kind: "text" | "thinking", chunk: string) => {
      setLiveBlocks((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === kind && last.streaming) {
          const updated: LiveChatBlock = {
            ...last,
            content: last.content + chunk,
          };
          return [...prev.slice(0, -1), updated];
        }
        // Close any previously streaming text/thinking block so only one is
        // "live" at a time — mirrors Claude Code where thinking collapses the
        // moment the model starts emitting text.
        const closed = prev.map<LiveChatBlock>((b) =>
          (b.kind === "text" || b.kind === "thinking") && b.streaming
            ? { ...b, streaming: false }
            : b,
        );
        return [
          ...closed,
          { id: `live-${++blockCounterRef.current}`, kind, content: chunk, streaming: true },
        ];
      });
    },
    [],
  );

  const closeStreamingBlocks = useCallback(() => {
    setLiveBlocks((prev) =>
      prev.map<LiveChatBlock>((b) =>
        (b.kind === "text" || b.kind === "thinking") && b.streaming
          ? { ...b, streaming: false }
          : b,
      ),
    );
  }, []);

  const appendToolCall = useCallback(
    (name: string, input: unknown, summary: string) => {
      setLiveBlocks((prev) => {
        const closed = prev.map<LiveChatBlock>((b) =>
          (b.kind === "text" || b.kind === "thinking") && b.streaming
            ? { ...b, streaming: false }
            : b,
        );
        return [
          ...closed,
          { id: `live-${++blockCounterRef.current}`, kind: "tool_call", name, input, summary },
        ];
      });
    },
    [],
  );

  const appendToolResult = useCallback(
    (name: string, output: string, summary: string) => {
      setLiveBlocks((prev) => [
        ...prev,
        { id: `live-${++blockCounterRef.current}`, kind: "tool_result", name, output, summary },
      ]);
    },
    [],
  );

  const startStream = useCallback(async (chatId: string, data: ChatMessageCreate, opts?: { projectId?: string }) => {
    // Defensive guard: if a previous stream is somehow still active (e.g. the
    // caller raced the drain effect, or a test double didn't finish), abort
    // the old fetch before replacing the ref. Without this the old reader
    // loop would keep mutating shared state (setLiveBlocks, setIsStreaming)
    // after the new stream starts, producing ghost blocks and flipping flags
    // out from under the new turn.
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setIsStreaming(true);
    setLiveBlocks([]);
    setError(null);
    blockCounterRef.current = 0;
    abortRef.current = new AbortController();
    streamingChatIdRef.current = chatId;
    const signal = abortRef.current.signal;

    // Optimistic update: show the user message immediately and flag the chat
    // as running. `is_running` must survive chat switches — if the user
    // navigates away mid-response and comes back, the WS `session_ended`
    // frame for this chat was missed (we were subscribed to a different
    // chat) so the post-session invalidation alone leaves a visible window
    // where `sessionRunning=null` and the stale cached `is_running=false`
    // both resolve to `serverRunning=false`, which incorrectly fires the
    // "Response was not received" fallback under the user message.
    //
    // Note: the field is `is_running` (snake_case) because apiFetch deep-
    // converts every response body camel→snake, so the real cache shape
    // uses the snake-case key even though the backend emits `isRunning`.
    // Writing `isRunning` here would silently leave the real field
    // untouched and the Stop button would not appear optimistically.
    queryClient.setQueryData(queryKeys.chat(chatId), (old: ChatDetailResponse | undefined) => {
      if (!old) return old;
      const optimisticMsg: ChatMessageResponse = {
        id: `optimistic-${Date.now()}`,
        chat_id: chatId,
        role: 'user' as const,
        content: data.content,
        created_at: new Date().toISOString(),
      };
      return { ...old, is_running: true, messages: [...old.messages, optimisticMsg] };
    });

    try {
      const res = await streamMessage(chatId, data, signal);
      if (!res.ok) throw new Error(`Stream failed: ${res.status}`);
      if (!res.body) throw new Error("Response body is null");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let json;
          try {
            json = JSON.parse(line.slice(6));
          } catch {
            console.warn("Failed to parse SSE data:", line);
            continue;
          }
          if ('error' in json) { setError(json.error); break; }
          if ('done' in json) {
            closeStreamingBlocks();
            // Invalidate list/tree queries so sidebars pick up the new
            // updated_at, but intentionally LEAVE the main chat query alone
            // — refetching it here would swap the liveBlocks transcript for
            // a re-rendered persisted one, causing a visible flash. The
            // persisted rows get picked up on the next natural refetch
            // (page switch / focus / manual reload).
            queryClient.invalidateQueries({ queryKey: queryKeys.chats });
            queryClient.invalidateQueries({ queryKey: ["entityChat"] });
            if (opts?.projectId) {
              queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
            }
            break;
          }
          if ('content' in json) appendChunk("text", String(json.content));
          if ('thinking' in json) appendChunk("thinking", String(json.thinking));
          if ('tool_call' in json && json.tool_call) {
            const tc = json.tool_call;
            appendToolCall(
              String(tc.name ?? "unknown"),
              tc.input,
              String(tc.summary ?? tc.name ?? ""),
            );
          }
          if ('tool_result' in json && json.tool_result) {
            const tr = json.tool_result;
            appendToolResult(
              String(tr.name ?? "unknown"),
              String(tr.output ?? ""),
              String(tr.summary ?? tr.name ?? ""),
            );
            const now = Date.now();
            if (now - lastInvalidationRef.current >= 1000) {
              lastInvalidationRef.current = now;
              if (opts?.projectId) {
                queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
              }
            }
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError' && mountedRef.current) setError(e.message);
    } finally {
      if (mountedRef.current) {
        setIsStreaming(false);
        closeStreamingBlocks();
      }
      abortRef.current = null;
      streamingChatIdRef.current = null;
      if (opts?.projectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
      }
    }
  }, [queryClient, appendChunk, appendToolCall, appendToolResult, closeStreamingBlocks]);

  // Stopping a turn is a two-part operation:
  //   1. Tell the daemon to abort the AgentSession (POST /chats/:id/cancel)
  //      so it stops consuming tokens and stops persisting further
  //      assistant/tool rows. Fire-and-forget — we don't await the response
  //      because the UI should feel instant, and the abort is idempotent.
  //   2. Abort the local fetch so the SSE reader loop exits and the
  //      composer flips back to the send button.
  // Doing only (2) — the previous behavior — left the server session
  // running to completion, which wasted tokens and kept writing DB rows
  // after the user thought they had stopped.
  //
  // The `fallbackChatId` argument exists so the caller can still stop a
  // server-side session after a page reload, when the user refreshed while
  // the chat was mid-turn: this hook is fresh, `streamingChatIdRef` is null,
  // and only the WS `sessionRunning` flag / `chatDetail.is_running` know the
  // backend is still running. Passing the chatId in from the caller lets
  // `POST /chats/:id/cancel` fire in that scenario too.
  const cancelStream = useCallback((fallbackChatId?: string) => {
    const chatId = streamingChatIdRef.current ?? fallbackChatId ?? null;
    if (chatId) {
      cancelChatRun(chatId).catch(() => {
        // Silent: the server may have already finished the turn between the
        // user's click and this request. The client-side abort below will
        // still close the stream.
      });
    }
    abortRef.current?.abort();
  }, []);

  const clearChat = useCallback(() => {
    setLiveBlocks([]);
    setError(null);
    blockCounterRef.current = 0;
  }, []);

  /**
   * Append a message to the queue for `chatId`. The drain effect below starts
   * it as soon as the current turn finishes. Returns the queue entry id so
   * callers can target it for `removeFromQueue` (e.g. the ✕ button on a
   * queued-message chip).
   */
  const enqueueMessage = useCallback(
    (chatId: string, data: ChatMessageCreate, opts?: { projectId?: string }) => {
      const id = `queued-${++queueCounterRef.current}-${Date.now()}`;
      setQueuedMessages((prev) => [...prev, { id, chatId, data, opts }]);
      return id;
    },
    [],
  );

  const removeFromQueue = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const clearQueue = useCallback(() => {
    setQueuedMessages([]);
  }, []);

  // Auto-drain: the moment a turn finishes (isStreaming flips false) and the
  // queue has something for any chat, pop the head and start its stream.
  // React re-renders serially, so `setIsStreaming(true)` inside the triggered
  // `startStream` prevents this effect from firing a second time for the same
  // turn — exactly one drain per finished stream.
  //
  // We intentionally do NOT filter by chatId here. The queue is keyed per
  // `useChatStream` instance, which is scoped to one ChatConversation mount
  // (which is itself keyed on `selectedChatId`) — so every queued entry
  // already belongs to this chat. Filtering here would just introduce a
  // silent drop if a future caller ever routes cross-chat messages.
  useEffect(() => {
    if (isStreaming) return;
    if (queuedMessages.length === 0) return;
    if (!mountedRef.current) return;
    const [next, ...rest] = queuedMessages;
    if (!next) return;
    setQueuedMessages(rest);
    void startStream(next.chatId, next.data, next.opts);
  }, [isStreaming, queuedMessages, startStream]);

  // Derived scalars kept for scroll-trigger sizing. Returning them here avoids
  // callers having to re-derive total text length from liveBlocks themselves.
  const streamedContent = liveBlocks
    .filter((b): b is Extract<LiveChatBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.content)
    .join("");
  const streamedThinking = liveBlocks
    .filter((b): b is Extract<LiveChatBlock, { kind: "thinking" }> => b.kind === "thinking")
    .map((b) => b.content)
    .join("");

  return {
    startStream,
    cancelStream,
    clearChat,
    enqueueMessage,
    removeFromQueue,
    clearQueue,
    isStreaming,
    liveBlocks,
    queuedMessages,
    streamedContent,
    streamedThinking,
    error,
  };
}
