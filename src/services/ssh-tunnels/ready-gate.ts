/**
 * Ready-gate for an SSH port-forward tunnel.
 *
 * After `spawn('ssh', …)` returns successfully, the child is running but the
 * forwarded port isn't necessarily serving traffic yet — the remote side of
 * the `-L LOCAL:HOST:REMOTE` pair has to finish authenticating and opening
 * the channel before a connect to `127.0.0.1:LOCAL` actually reaches the
 * remote daemon. During that window, a premature HTTP request will either
 * hang (if ssh accepts the TCP connection and then times out the forward)
 * or fail with ECONNREFUSED (if ssh hasn't bound the local port yet).
 *
 * This module polls `http://127.0.0.1:${lport}/health` at a fixed interval
 * and resolves 'ready' on the first 2xx response. If the cap `timeoutMs`
 * is reached first, it resolves 'timeout'. An optional `AbortSignal` lets
 * callers cancel a pending probe (used by `SshTunnelManager.shutdown()` so
 * a tunnel being torn down doesn't keep the probe alive past its process).
 *
 * Design choices worth preserving:
 *
 *   - 1s per-request timeout via a dedicated `AbortController` per fetch —
 *     prevents one stuck request from burning the whole budget. The timer
 *     is always cleared in `finally` so fake-timer tests can assert zero
 *     pending timers after shutdown.
 *
 *   - Outer signal is linked to the per-request controller: if the caller
 *     aborts mid-fetch (shutdown), the in-flight request aborts too rather
 *     than blocking until its 1s per-request cap.
 *
 *   - The sleep between polls is abortable via the same signal, and the
 *     abort path clears the `setTimeout` — otherwise `vi.getTimerCount()`
 *     would stay nonzero after shutdown and the test would flake.
 */

export interface WaitForTunnelReadyOptions {
  /** Overall probe budget. Default 10s. */
  timeoutMs?: number;
  /** Sleep between attempts. Default 200ms. */
  pollMs?: number;
  /** If aborted, the function resolves with 'timeout' and stops polling. */
  signal?: AbortSignal;
  /** Test seam: swap in a fetch replacement (optional). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Wait until the forwarded port is serving `/health`.
 *
 * @param lport  Local port the ssh child forwards to the remote daemon.
 * @param opts   Probe options. See {@link WaitForTunnelReadyOptions}.
 * @returns      `'ready'` once any `/health` response is 2xx, or `'timeout'`
 *               if the cap is reached / the caller aborts.
 *
 * Pure async — no side effects beyond the network calls and timers it
 * schedules (all of which it cleans up before returning).
 */
export async function waitForTunnelReady(
  lport: number,
  opts: WaitForTunnelReadyOptions = {},
): Promise<"ready" | "timeout"> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 200;
  const signal = opts.signal;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Fast-fail: caller already aborted before we started.
  if (signal?.aborted) return "timeout";

  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${lport}/health`;

  while (Date.now() < deadline) {
    if (signal?.aborted) return "timeout";

    // Per-request timeout + outer-signal linkage. We create a fresh
    // AbortController for each fetch so the 1s cap is strictly per-attempt.
    const perReqController = new AbortController();
    const perReqTimer = setTimeout(() => perReqController.abort(), 1000);
    const onOuterAbort = () => perReqController.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await fetchImpl(url, { signal: perReqController.signal });
      // The task spec phrases this as "any response has ok: true" — that's
      // the fetch Response.ok property (true for status in [200, 299]).
      if (res.ok) return "ready";
    } catch {
      // ECONNREFUSED / timeout / abort / any other fetch error — fall
      // through to the between-polls sleep and try again.
    } finally {
      clearTimeout(perReqTimer);
      signal?.removeEventListener("abort", onOuterAbort);
    }

    if (signal?.aborted) return "timeout";

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // Abortable sleep. If the signal fires mid-sleep the timer is cleared
    // and we exit the loop immediately — this is the cleanup path the
    // shutdown_during_ready_gate test asserts (vi.getTimerCount() === 0).
    const aborted = await sleepOrAbort(Math.min(pollMs, remaining), signal);
    if (aborted) return "timeout";
  }

  return "timeout";
}

/**
 * Resolve after `ms` milliseconds, OR immediately if `signal` is aborted.
 * Returns `true` iff aborted. Always clears its timer on the abort path,
 * so callers holding fake timers can assert zero pending timers.
 */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
