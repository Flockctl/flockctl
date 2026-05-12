import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamMessage, cancelChatRun } from "../api";
import type {
  ChatDetailResponse,
  ChatMessageCreate,
  ChatMessageResponse,
  LiveChatBlock,
} from "../types";
import {
  enqueueMessage as storeEnqueue,
  peekHead as storePeekHead,
  removeFromQueue as storeRemove,
  markDrainInFlight as storeMarkDrainInFlight,
  registerActiveChat,
  useChatQueue,
  useRemoveFromQueue,
  useClearQueue,
  useReorderQueue,
} from "../chat-queue-store";
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
 * is already running, `enqueueMessage` appends it to the per-chat queue
 * (backed by `chat-queue-store` so it survives the parent's
 * `key={selectedChatId}` remount). The drain effect below picks the next
 * queued item up the moment BOTH `isStreaming` flips to false AND the
 * caller-supplied `serverBusy` flag clears — kicking off the next stream
 * automatically. Earlier versions only checked `isStreaming`, which let a
 * queued prompt fire in the brief window between SSE `done` and the WS
 * `session_ended` frame, opening a second concurrent server turn for the
 * same chat. `cancelStream` only aborts the currently-running turn — the
 * queue is left intact so pressing Esc mid-turn behaves exactly like
 * Claude Code: the current response stops, the next queued prompt takes
 * over (use `clearQueue` to drop the rest if that's not what you want).
 */
export type { QueuedChatMessage } from "../chat-queue-store";

export interface UseChatStreamOptions {
  /**
   * Current chat id this hook is scoped to. The queue is read from
   * `chat-queue-store` keyed by this id, so the same hook mounted in
   * different chats sees independent queues. Optional for tests / legacy
   * callers; when omitted, the queue collapses to the shared "no chat"
   * slot and behaves like a single-chat store.
   */
  chatId?: string | null;
  /**
   * True when the daemon still reports the session for `chatId` is in
   * flight — i.e. WS `sessionRunning === true` OR the persisted
   * `is_running === true` on the chat row. Drain blocks while this is
   * true so a queued prompt doesn't open a parallel server-side turn
   * next to one that's still finalising (the local SSE stream usually
   * closes a few hundred ms before the WS `session_ended` frame).
   */
  serverBusy?: boolean;
}

export function useChatStream(opts: UseChatStreamOptions = {}) {
  const { chatId = null, serverBusy = false } = opts;
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveBlocks, setLiveBlocks] = useState<LiveChatBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Queue is no longer per-hook state — it lives in the module-level
  // `chat-queue-store` so messages survive `ChatConversation`'s remount on
  // every chat switch. `useChatQueue` subscribes via `useSyncExternalStore`
  // so any push/pop into the store re-renders this hook automatically.
  const queuedMessages = useChatQueue(chatId);
  const removeFromQueue = useRemoveFromQueue();
  const clearQueue = useClearQueue(chatId);
  const reorderQueue = useReorderQueue(chatId);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks the chatId of the currently-streaming turn so cancelStream can
  // tell the server which session to abort. Set at the top of startStream,
  // cleared in its `finally` — outside of an active stream it's null and
  // cancelStream becomes a no-op for the backend side.
  const streamingChatIdRef = useRef<string | null>(null);
  // Synchronous reentrancy guard. `setIsStreaming(true)` is async (React
  // batches it), so two clicks in the same tick can both pass the
  // `!isStreaming` gate in `handleComposerSend` and both call `startStream`,
  // causing the second to abort the first via `abortRef.current.abort()` —
  // the user's first prompt vanishes silently. Flipping a ref synchronously
  // at the top of `startStream` lets the second call detect the in-flight
  // start and route the message to the queue instead.
  const startingRef = useRef(false);
  const blockCounterRef = useRef(0);
  const lastInvalidationRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Tell the background queue-runner that this hook is now responsible
  // for `chatId` — the runner will skip drain attempts for chats with at
  // least one mounted hook so the two don't race for `dequeueHead`. The
  // marker is refcounted so React StrictMode's mount → unmount → mount
  // cycle in dev doesn't briefly hand the runner a window to launch a
  // duplicate drain.
  useEffect(() => {
    if (!chatId) return;
    const release = registerActiveChat(chatId);
    return release;
  }, [chatId]);

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
          {
            id: `live-${++blockCounterRef.current}`,
            kind: "tool_call",
            name,
            input,
            summary,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    },
    [],
  );

  const appendToolResult = useCallback(
    (name: string, output: string, summary: string) => {
      setLiveBlocks((prev) => [
        ...prev,
        {
          id: `live-${++blockCounterRef.current}`,
          kind: "tool_result",
          name,
          output,
          summary,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [],
  );

  /**
   * Append a message to the queue for `chatId`. The drain effect below starts
   * it as soon as the current turn finishes AND the server reports idle.
   * Returns the queue entry id so callers can target it for `removeFromQueue`
   * (e.g. the ✕ button on a queued-message chip).
   *
   * Stable identity (no chatId / serverBusy in deps) — the store call is a
   * pure module-level write, so a re-render shouldn't churn the callback
   * reference and force every consumer of `enqueueMessage` to re-bind.
   */
  const enqueueMessage = useCallback(
    (entryChatId: string, data: ChatMessageCreate, opts?: { projectId?: string }) =>
      storeEnqueue(entryChatId, data, opts),
    [],
  );

  const startStream = useCallback(async (
    entryChatId: string,
    data: ChatMessageCreate,
    opts?: { projectId?: string },
    /**
     * Hook-internal options. The drain effect passes `queueEntryId` so
     * `startStream` can remove the entry from the queue ONLY after the
     * server returns 2xx — preserving the prompt for retry on a network
     * blip. Direct callers (e.g. `handleComposerSend`) leave this
     * undefined: their entry isn't in the queue to begin with.
     */
    internal?: { queueEntryId?: string },
  ): Promise<boolean> => {
    // Synchronous reentrancy guard (BUG #3 fix). If a start is already in
    // flight in this tick — typical case: the user double-clicked Send, or
    // the drain effect raced `handleComposerSend` — we route the message
    // to the queue instead of aborting the in-flight start. Without this
    // the second call would hit the `abortRef.current.abort()` branch
    // below and silently drop the first prompt before its SSE body had
    // even returned.
    if (startingRef.current) {
      enqueueMessage(entryChatId, data, opts);
      // Returning false here would mark the head failed even though it
      // was successfully enqueued — return true so the drain effect's
      // `failedHeadRef` doesn't trip over a perfectly fine outcome.
      return true;
    }
    startingRef.current = true;
    // Coordinate with the background runner against a SINGLE source of
    // truth — both paths block while a drain is in flight for this chat.
    // Released in `finally` so a thrown exception still clears the
    // marker. The disposer is captured into a local variable so the
    // `finally` block can call it without re-walking the store.
    const releaseInFlight = storeMarkDrainInFlight(entryChatId);
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
    streamingChatIdRef.current = entryChatId;
    const signal = abortRef.current.signal;
    /**
     * Whether the server accepted the request (HTTP 2xx). The drain
     * effect uses this to decide if the queue entry needs to be marked
     * as "failed" so it doesn't re-fire on the very next render. A
     * non-accepted entry stays in the queue but blocks subsequent
     * drains for this head — the user can retry via the ✕→re-add cycle
     * or via "Clear all".
     */
    let accepted = false;

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
    queryClient.setQueryData(queryKeys.chat(entryChatId), (old: ChatDetailResponse | undefined) => {
      if (!old) return old;
      const optimisticMsg: ChatMessageResponse = {
        id: `optimistic-${Date.now()}`,
        chat_id: entryChatId,
        role: 'user' as const,
        content: data.content,
        created_at: new Date().toISOString(),
      };
      return { ...old, is_running: true, messages: [...old.messages, optimisticMsg] };
    });

    try {
      const res = await streamMessage(entryChatId, data, signal);
      if (!res.ok) throw new Error(`Stream failed: ${res.status}`);
      if (!res.body) throw new Error("Response body is null");
      // Server accepted the request. ONLY now is it safe to remove the
      // entry from the queue: a network blip before this point should
      // leave the prompt queued so the next drain (hook or runner)
      // retries it instead of silently dropping it.
      accepted = true;
      if (internal?.queueEntryId) {
        storeRemove(internal.queueEntryId);
      }
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
      // Release the shared in-flight marker so the runner can pick up
      // the next entry once the user navigates away (or so the hook's
      // own drain effect can re-evaluate cleanly).
      releaseInFlight();
      // Release the reentrancy guard last so any drain that fires on the
      // `setIsStreaming(false)` flush above still sees `startingRef === true`
      // and routes the next item through the queue path. The drain effect's
      // own check on `startingRef` keeps things consistent — releasing here
      // lets the NEXT drain (after the dependency array refires) proceed.
      startingRef.current = false;
      if (opts?.projectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(opts.projectId) });
      }
    }
    return accepted;
  }, [queryClient, appendChunk, appendToolCall, appendToolResult, closeStreamingBlocks, enqueueMessage]);

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
    const targetChatId = streamingChatIdRef.current ?? fallbackChatId ?? null;
    if (targetChatId) {
      cancelChatRun(targetChatId).catch(() => {
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

  // Tracks the most recent queue entry whose drain attempt failed. The
  // drain effect peeks at the head WITHOUT removing it (so a network
  // blip leaves the prompt queued for retry), but that opens an
  // infinite-loop trap: if `startStream` returns `accepted=false` and
  // the entry stays at the head, the next render would peek the same
  // head and fire `startStream` again, ad infinitum. This ref pins
  // the failed id so subsequent drain ticks for the same head are no-ops.
  //
  // Reset paths:
  //   - User clicks ✕ → removeFromQueue → queue array changes → next
  //     peek either returns a different head (drain fires) or null
  //     (drain bails). Either way the ref is stale; we clear it
  //     opportunistically when peek.id !== ref so a fresh head always
  //     gets a fresh attempt.
  //   - User adds another entry (Send while busy) → enqueue appends to
  //     tail → head unchanged → ref still gates → still no-op. The
  //     user can manually retry by clicking ✕ on the failed head.
  const failedHeadRef = useRef<string | null>(null);

  // Auto-drain. The moment the local stream finishes (`isStreaming` flips
  // false) AND the daemon reports the session has finalised
  // (`serverBusy === false`), pop the head of THIS chat's queue and start
  // its stream.
  //
  // The `serverBusy` gate is the BUG #1 fix: the local SSE `done` event
  // typically arrives a few hundred ms before the WS `session_ended` frame
  // because the daemon flushes assistant rows + diff entries after closing
  // the SSE writer. Without this gate, a queued prompt drained in that
  // window would call `streamMessage` while the previous turn was still
  // writing to the chat — opening a parallel server-side session whose
  // tool calls and assistant rows interleave with the previous one in the
  // DB. The fallback indicator and "ghost responses" the user sees are
  // both downstream of that race.
  //
  // We also bail when `startingRef` is set — drain may fire from a state
  // flush triggered inside `startStream` itself (see comment in `finally`),
  // and we don't want a second drain pass to dequeue a fresh head while
  // the previous one is still mid-setup.
  //
  // The queue is keyed on `chatId` via `chat-queue-store`, so this effect
  // only ever drains entries that belong to the chat this hook instance
  // is scoped to. Entries enqueued for a different chat sit untouched in
  // the store until that chat's hook mounts.
  useEffect(() => {
    if (isStreaming) return;
    if (serverBusy) return;
    if (startingRef.current) return;
    if (!chatId) return;
    if (queuedMessages.length === 0) return;
    if (!mountedRef.current) return;
    const head = storePeekHead(chatId);
    if (!head) return;
    // Different head than the last failure → fresh attempt; clear the
    // sticky-failure marker so we can re-evaluate.
    if (failedHeadRef.current && failedHeadRef.current !== head.id) {
      failedHeadRef.current = null;
    }
    if (failedHeadRef.current === head.id) return;
    void (async () => {
      const accepted = await startStream(head.chatId, head.data, head.opts, {
        queueEntryId: head.id,
      });
      if (!accepted && mountedRef.current) {
        // Pin this head as failed so the next render doesn't re-fire it.
        // The user surfaces the failure via the existing `setError` UI;
        // recovery is "click ✕ on the chip and retry from the composer".
        failedHeadRef.current = head.id;
      }
    })();
  }, [isStreaming, serverBusy, queuedMessages, chatId, startStream]);

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
    reorderQueue,
    isStreaming,
    liveBlocks,
    queuedMessages,
    streamedContent,
    streamedThinking,
    error,
  };
}
