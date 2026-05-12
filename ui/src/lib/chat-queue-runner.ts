import type { QueryClient } from "@tanstack/react-query";
import { fetchChat, streamMessage } from "./api";
import type { ChatDetailResponse } from "./types";
import {
  getAllChatsWithQueue,
  peekHead,
  removeFromQueue,
  clearQueue,
  isChatActive,
  isDrainInFlight,
  markDrainInFlight,
  subscribeChatQueueStore,
} from "./chat-queue-store";
import { queryKeys } from "./hooks/core";

/**
 * Background queue runner — drains queued chat messages for chats the user
 * is NOT currently viewing.
 *
 * Why this exists. `useChatStream`'s drain effect only fires for the chat
 * its hook instance is scoped to. So before this runner, a queued message
 * in chat A would sit untouched the moment the user switched to chat B —
 * the chat A hook unmounted, taking its drain effect with it. The fix in
 * the previous slice made the queue itself survive the remount (it lives
 * in `chat-queue-store`), but the messages still only flushed once the
 * user came back to chat A. That's not "queued", that's "deferred until
 * the user remembers to return".
 *
 * What it does. The runner subscribes to:
 *   1. The queue store (any push/pop/clear, plus active-chat marker
 *      transitions),
 *   2. The React Query cache (so we re-evaluate when a `chat(id)` row
 *      flips its `is_running` flag — the most common signal that a chat
 *      is now idle and ready for the next queued turn),
 *   3. A periodic 5s tick — a safety net for chats whose `is_running`
 *      transitions came in via a WS frame we never wired into the cache
 *      (e.g. the user has never opened the chat in this tab, so its
 *      `useChatEventStream` was never mounted).
 *
 * On each signal it walks every chatId with a non-empty queue, skipping:
 *   - chats with an active `useChatStream` (the hook drains itself),
 *   - chats already mid-drain by the runner (`inFlight` guard),
 *   - chats whose `chatDetail.is_running === true` (a turn is still
 *     finalising on the daemon — sending now would race the previous
 *     turn's writes).
 *
 * For every remaining chatId it peeks at the head, POSTs through
 * `streamMessage`, and only after the server returns 2xx removes the
 * entry from the queue. The SSE response body is drained silently —
 * any UI that's subscribed to this chat's WS frames sees the live
 * progress as usual; any UI that isn't subscribed picks the persisted
 * rows up on the next natural refetch (chat switch, focus, manual
 * reload). After the body closes the runner invalidates the chat list
 * + chat detail caches so the sidebar updated_at and the row's
 * `is_running` flag both get fresh values from the server.
 *
 * Singleton. There must be exactly one runner per browser tab. The
 * `start` helper is idempotent under React StrictMode's double-mount —
 * a second `start(qc)` call swaps the QueryClient reference but does
 * not register duplicate subscriptions or timers.
 */

interface RunnerState {
  qc: QueryClient;
  unsubscribers: (() => void)[];
  ticking: boolean;
}

let state: RunnerState | null = null;

/**
 * Drain the SSE body the runner just opened. The runner is not subscribed
 * to the SSE event stream — UI updates ride on WS frames whose subscribers
 * (any open `useChatEventStream` for this chat) handle them — so we just
 * pump the reader to EOF to free the connection and let the daemon
 * finalise the turn cleanly. Errors are swallowed; if the network drops
 * mid-stream the daemon's own teardown writes the failure to the chat row,
 * which the next refetch will surface.
 */
async function drainBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Ignore — see comment above.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released — no-op.
    }
  }
}

/**
 * Outcome of `isChatRunning`. `notFound` is its own state because the
 * runner reacts differently — a 404 means the chat has been deleted, so
 * we drop its entire queue rather than retrying forever.
 */
type RunningStatus = "running" | "idle" | "notFound";

/**
 * Resolve `is_running` for `chatId`.
 *
 * - **`is_running=false` in cache** → trust the cache. Single-tenant means
 *   no other client could have started a turn we don't know about.
 * - **`is_running=true` in cache** → re-verify via `GET /chats/:id`. The
 *   most common cause of a cached `true` is `useChatStream`'s optimistic
 *   update at the start of `startStream`, which is NEVER flipped back to
 *   `false` by the hook itself (the WS `session_ended` handler in
 *   `useChatEventStream` does that — but that hook unmounts the moment
 *   the user navigates away from the chat). Without this re-verify the
 *   runner sees a stuck `true` indefinitely and never drains.
 * - **No cache** → freshly `GET /chats/:id` and seed the cache so
 *   subsequent ticks have a recent baseline.
 * - **`GET` returns 404** → report `notFound` so the runner can clear
 *   the dead queue.
 * - **Network error** → report `running` so the runner skips this tick;
 *   the next tick (every 5s, or on the next store/cache event) will
 *   retry the fetch.
 */
async function isChatRunning(qc: QueryClient, chatId: string): Promise<RunningStatus> {
  const cached = qc.getQueryData<ChatDetailResponse>(queryKeys.chat(chatId));
  if (cached && cached.is_running === false) return "idle";
  // Either no cache, or cache says "running" — re-fetch to confirm.
  try {
    const fresh = await fetchChat(chatId);
    qc.setQueryData<ChatDetailResponse>(queryKeys.chat(chatId), fresh);
    return fresh.is_running === true ? "running" : "idle";
  } catch (err) {
    // `apiFetch` rejects with `Error(`HTTP <status> …`)` shaped messages.
    // Treat any 404 specifically — the chat was deleted, so its queue
    // has no destination and should be wiped to stop the runner from
    // burning ticks on it forever.
    const message = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(message)) return "notFound";
    return "running";
  }
}

/**
 * Classify an HTTP status as transient or permanent.
 *
 * - **Transient** (5xx, 429): retry on the next tick. Daemon is up but
 *   momentarily unhappy; our queue is the right buffer for that.
 * - **Permanent** (400, 401, 403, 404, 422): the request will never
 *   succeed unmodified. Retrying forever burns HTTP and clutters logs;
 *   drop the head so the queue moves on. The user surfaces the failure
 *   via the rest of the UI (the chat row's `is_running=false` + missing
 *   assistant message) — adding a retry button without dropping risks
 *   a stuck queue when the cause is, say, a deleted AI provider key.
 */
function isPermanentClientError(status: number): boolean {
  if (status === 429) return false; // rate-limit — explicit retry
  return status >= 400 && status < 500;
}

async function drainOne(chatId: string): Promise<void> {
  if (!state) return;
  const { qc } = state;
  // Hook OR runner is already mid-drain for this chat. Bail.
  if (isDrainInFlight(chatId)) return;
  if (isChatActive(chatId)) return;
  const head = peekHead(chatId);
  if (!head) return;

  const status = await isChatRunning(qc, chatId);
  if (status === "running") return;
  if (status === "notFound") {
    // Chat was deleted — drop the entire queue so the runner stops
    // burning ticks (and re-fetches) on a dead destination.
    clearQueue(chatId);
    return;
  }
  // Re-check after the await — anything could have moved in between
  // (the user opened the chat → activeChats; another tick already
  // snapped this entry → inFlight; ✕ button removed it → peek changes).
  // Without these guards we'd happily start a parallel drain or send a
  // prompt the user just retracted.
  if (isDrainInFlight(chatId)) return;
  if (isChatActive(chatId)) return;
  const stillHead = peekHead(chatId);
  if (!stillHead || stillHead.id !== head.id) return;

  // Claim the chat in the SHARED in-flight ledger so any mounted hook
  // also sees us as the active drainer (and stays out of the way) until
  // we release in `finally`.
  const releaseInFlight = markDrainInFlight(chatId);
  // `acceptedRemoved` distinguishes "server took the request, queue
  // entry already gone, only the body drain failed" from "server
  // rejected, entry must stay queued for retry". The finally block
  // uses it to decide whether to invalidate cache.
  let acceptedRemoved = false;
  try {
    const response = await streamMessage(chatId, head.data);
    if (!response.ok) {
      if (isPermanentClientError(response.status)) {
        // 4xx is a permanent failure for THIS prompt — the request
        // will never succeed without intervention (auth expired, key
        // disabled, payload rejected, etc.). Drop the head so the
        // queue can move on; subsequent entries for the same chat
        // get a fresh shot via the normal scheduleTick → drainOne
        // chain in `finally`.
        console.warn(
          `[chat-queue-runner] permanent ${response.status} for ${chatId}, dropping head`,
        );
        removeFromQueue(head.id);
      } else {
        // 5xx / 429 — transient. Leave the entry; next tick retries.
        console.warn(
          `[chat-queue-runner] transient ${response.status} for ${chatId}, will retry`,
        );
      }
      return;
    }
    // Server accepted — only NOW remove from the queue. A crash between
    // POST and dequeue would resurrect the prompt on the next tick and
    // double-send.
    removeFromQueue(head.id);
    acceptedRemoved = true;
    await drainBody(response.body);
  } catch (err) {
    // Network error / timeout / etc. Leave the entry; next tick retries.
    console.warn(`[chat-queue-runner] drain threw for ${chatId}:`, err);
  } finally {
    releaseInFlight();
    // Always invalidate the chat caches when the server accepted the
    // request, even if `drainBody` errored. The daemon may have already
    // persisted assistant + tool rows before the connection dropped,
    // and the sidebar / chat detail need to reflect them on the next
    // refetch. Skipping invalidation on body-error left the UI stuck
    // on the pre-turn snapshot until the user manually reloaded.
    if (acceptedRemoved) {
      qc.invalidateQueries({ queryKey: queryKeys.chats });
      qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      qc.invalidateQueries({ queryKey: ["entityChat"] });
    }
    // A fresh tick gives us a chance to drain the next item in this
    // chat's queue (or in another chat that became eligible while we
    // were busy here).
    scheduleTick();
  }
}

let pending = false;

/**
 * Schedule a tick on the next microtask. Coalesces bursts of store /
 * cache events into a single sweep — without this guard, a chat with
 * 10 queued messages would fire 10 store-emit events back-to-back and
 * each one would launch a duplicate `tick`.
 */
function scheduleTick(): void {
  if (!state || pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    void tick();
  });
}

async function tick(): Promise<void> {
  if (!state || state.ticking) return;
  state.ticking = true;
  try {
    const chatIds = getAllChatsWithQueue();
    // Fan out — different chats drain in parallel because they don't
    // share a key on the daemon side. `drainOne` keeps its own inFlight
    // guard against duplicates within the same chat.
    await Promise.all(chatIds.map((id) => drainOne(id)));
  } finally {
    state.ticking = false;
  }
}

/**
 * Start the singleton runner. Idempotent under StrictMode: a second call
 * updates the QueryClient reference but does not register duplicate
 * subscriptions / timers. Safe to call from a `useEffect` in the app
 * shell.
 */
export function startChatQueueRunner(qc: QueryClient): () => void {
  if (state) {
    state.qc = qc;
    // Always return a no-op disposer — once started, the runner lives
    // for the tab lifetime. Stopping it on a single subscriber unmount
    // would orphan the queue while StrictMode briefly transitions
    // through unmount→remount.
    return () => {};
  }

  state = {
    qc,
    unsubscribers: [],
    ticking: false,
  };

  // 1. Queue-store changes — covers every enqueue / removeFromQueue /
  // dequeueHead / clearQueue / register/unregisterActiveChat.
  state.unsubscribers.push(subscribeChatQueueStore(scheduleTick));

  // 2. React Query cache changes — picks up `chat(id)` invalidations,
  // i.e. the moment `is_running` flips on the row.
  const qcUnsub = qc.getQueryCache().subscribe(scheduleTick);
  state.unsubscribers.push(qcUnsub);

  // 3. Periodic safety net — chats whose `is_running` transitions came
  // in over WS for a chat without a mounted hook never hit (1) or (2),
  // so without this their queue would idle forever.
  //
  // Pause the safety-net interval when the tab is hidden: the user can't
  // see the queue, the WS-driven path will catch up on visibilitychange,
  // and a tight 5 s timer on a background tab wakes CPU + churns React
  // Query cache traffic for no benefit.
  let safetyNetInterval: ReturnType<typeof setInterval> | null = null;
  const startSafetyNet = () => {
    if (safetyNetInterval !== null) return;
    safetyNetInterval = setInterval(scheduleTick, 5_000);
  };
  const stopSafetyNet = () => {
    if (safetyNetInterval === null) return;
    clearInterval(safetyNetInterval);
    safetyNetInterval = null;
  };
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    // Tab is currently hidden — defer the safety net.
  } else {
    startSafetyNet();
  }
  const onVisibilityChange = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      stopSafetyNet();
    } else {
      // Returning visible: catch up immediately, then resume the interval.
      scheduleTick();
      startSafetyNet();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  state.unsubscribers.push(() => {
    stopSafetyNet();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  });

  // Kick the first tick.
  scheduleTick();

  return () => {};
}

/**
 * Test helper — tear down the singleton so the next `startChatQueueRunner`
 * call in the next test sets up a clean state. Not part of the production
 * API; the runner has no real "stop" lifecycle in production.
 */
export function __resetChatQueueRunnerForTests(): void {
  if (!state) return;
  for (const u of state.unsubscribers) {
    try {
      u();
    } catch {
      // Ignore.
    }
  }
  state = null;
  pending = false;
}

/** Test helper — manually trigger a tick, awaiting its completion. */
export async function __tickChatQueueRunnerForTests(): Promise<void> {
  await tick();
}
