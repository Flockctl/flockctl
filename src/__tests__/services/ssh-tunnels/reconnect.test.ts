/**
 * Reconnect loop tests for {@link SshTunnelManager}.
 *
 * The manager schedules a respawn with exponential backoff whenever a
 * tunnel lands in a non-terminal error state — either because the child
 * exited after a period of `ready`, or because the initial bootstrap
 * failed with a code that isn't `host_key_mismatch` / `remote_flockctl_missing`.
 *
 * These tests pin the ladder to the sequence the slice specifies
 * (1 → 2 → 4 → 8 → 30s, capped at 30s) and verify that
 * `manager.restart()` breaks out of a terminal bootstrap failure by
 * resetting the ladder and forcing an immediate respawn.
 *
 * Strategy:
 *
 *   - Mock `node:child_process.spawn` to return fake ChildProcess
 *     instances — same pattern as ready-gate.test.ts.
 *   - Inject a stub probe so no real HTTP is ever attempted. This also
 *     keeps the only scheduled setTimeout calls the ones *we* own
 *     (reconnect timers), which is essential for the ladder assertion.
 *   - Use `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`
 *     — narrower than the default so `net.createServer().listen()` and
 *     Node's internal nextTick/setImmediate machinery continue to work
 *     (allocateLocalPort uses a real socket to find a free port).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ESM-safe spawn spy — same pattern as the sibling test files in this dir.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import type * as child_process from "node:child_process";
import { SshTunnelManager } from "../../../services/ssh-tunnels/manager.js";
import type { ReadyProbe } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal ChildProcess stand-in. Has the event emitter surface
 * (`.on`/`.once`/`.emit`) plus `.stdout` / `.stderr` PassThroughs the
 * manager subscribes to. `kill()` flips `killed` so the manager's
 * "still alive?" check in restart()/shutdown() behaves correctly.
 */
function makeFakeChild(): child_process.ChildProcess {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (sig?: NodeJS.Signals) => boolean;
    killed: boolean;
    exitCode: number | null;
    pid?: number;
  };
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.kill = function kill() {
    this.killed = true;
    return true;
  };
  emitter.pid = 4242;
  return emitter as unknown as child_process.ChildProcess;
}

function mkServer(id = "srv-1"): RemoteServerConfig {
  return { id, name: id, ssh: { host: "example.com" } };
}

/**
 * Spin the microtask queue a few times so async work inside the manager
 * (awaited probes, `.catch` handlers on `start()` results) gets a chance
 * to settle. Needed because we can't use real timers here and
 * `await Promise.resolve()` alone only processes one microtask.
 */
async function pumpMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Yield to the event loop's check phase so Node's internal I/O
 * callbacks (e.g. the `net.Server.listen()` bind callback inside
 * `allocateLocalPort`) get a chance to fire. `setImmediate` is NOT in
 * our fake-timers `toFake` list, so this is a real tick — safe to use
 * under fake timers.
 */
async function yieldEventLoop(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pumpMicrotasks(5);
  }
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// reconnect_backoff_sequence_is_1_2_4_8_30
// ---------------------------------------------------------------------------

describe("reconnect backoff ladder", () => {
  it("reconnect_backoff_sequence_is_1_2_4_8_30: 6 consecutive non-terminal failures schedule 1s → 2s → 4s → 8s → 30s → 30s", async () => {
    // Only fake setTimeout/clearTimeout so the net.createServer listen
    // inside allocateLocalPort() still works against real I/O.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Fresh fake child per spawn so each reconnect gets its own handle.
    // The children never emit 'exit' (the probe drives status), so
    // multiple outstanding children is fine.
    spawnMock.mockImplementation(() => makeFakeChild());

    // Probe always returns 'timeout' — synchronous resolved promise,
    // contributes no setTimeout calls of its own. That keeps the
    // global setTimeout spy below clean: every call we observe is a
    // reconnect schedule.
    const probe: ReadyProbe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // First start — lands in 'error' with errorCode='unknown' (not in
    // TERMINAL_ERROR_CODES), so the manager schedules the first
    // reconnect at 1000ms.
    const h0 = await mgr.start(mkServer("srv-1"));
    expect(h0.status).toBe("error");
    expect(h0.errorCode).toBe("unknown");

    // Collect the scheduled delays. After each observed schedule,
    // advance time by exactly that delay — the timer fires, the
    // manager's reconnect callback re-enters start(), the probe
    // returns 'timeout' again, and the next reconnect is scheduled.
    const observedDelays: number[] = [];

    for (let step = 0; step < 6; step++) {
      // The most recent setTimeout call is the reconnect we're about
      // to fire. `.mock.calls` entries are [handler, delay, ...args].
      const calls = setTimeoutSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(step);
      const lastCall = calls[calls.length - 1];
      const delay = lastCall[1] as number;
      observedDelays.push(delay);

      // Advance to fire this reconnect. advanceTimersByTimeAsync
      // flushes microtasks spawned by the timer callback (await probe,
      // entry bookkeeping) before returning.
      await vi.advanceTimersByTimeAsync(delay);
      // Belt-and-suspenders: pump a few extra microtasks in case the
      // internal start() promise chain still has trailing work.
      await pumpMicrotasks();
    }

    expect(observedDelays).toEqual([1_000, 2_000, 4_000, 8_000, 30_000, 30_000]);

    // Tidy up — clear the pending timer so the test doesn't leak one.
    mgr.shutdown("srv-1");
  });

  it("reaching 'ready' resets the backoff index back to the 1s slot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // First spawn: becomes 'ready'. Subsequent spawns: fail fast so the
    // reconnect ladder kicks in.
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Alternate probe behaviour per invocation:
    //   call 1  → 'ready'   (start succeeds, index reset to 0)
    //   call 2+ → 'timeout' (errors, schedule reconnect)
    const probe = vi
      .fn<(lport: number, opts: Record<string, unknown>) => Promise<"ready" | "timeout">>()
      .mockResolvedValueOnce("ready")
      .mockResolvedValue("timeout");
    const mgr = new SshTunnelManager({ probe });

    const h1 = await mgr.start(mkServer("srv-1"));
    expect(h1.status).toBe("ready");

    // Emit 'exit' on the ready child — the manager's post-ready exit
    // listener will classify (empty stderr → 'unknown') and schedule
    // the first reconnect at 1000ms, proving the index was reset.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    (children[0] as unknown as EventEmitter).emit("exit", 1);
    await pumpMicrotasks();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]![1]).toBe(1_000);

    mgr.shutdown("srv-1");
  });
});

// ---------------------------------------------------------------------------
// Terminal bootstrap failures: no auto-reconnect, but `restart()` breaks out.
// ---------------------------------------------------------------------------

describe("restart() after terminal bootstrap failure", () => {
  it("restart_after_terminal_bootstrap_failure: 'remote_flockctl_missing' does not schedule, restart() spawns immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Probe that parks until its signal aborts. The manager's
    // child-exit-during-probe handler aborts the signal, so this lets
    // us drive the handle into an error state by emitting 'exit' on
    // the fake child.
    const probe: ReadyProbe = (_lport, { signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), {
          once: true,
        });
      });

    const mgr = new SshTunnelManager({ probe });

    // Kick off the first start. Don't await yet — we need to synthesise
    // stderr + exit before the handle resolves.
    const p1 = mgr.start(mkServer("srv-1"));

    // Let start() progress past allocateLocalPort + spawn + listener
    // registration. The port allocator binds a real socket, so we need
    // to yield to the event loop's check phase (not just microtasks).
    await yieldEventLoop();
    expect(children.length).toBe(1);
    const c1 = children[0]!;

    // Emit the canonical "remote binary missing" stderr then exit 127.
    // classifyStderr will match the regex and return
    // 'remote_flockctl_missing', which is in TERMINAL_ERROR_CODES →
    // manager must NOT schedule a reconnect.
    c1.stderr!.emit("data", "bash: flockctl: command not found\n");
    (c1 as unknown as EventEmitter).emit("exit", 127);

    const h1 = await p1;
    expect(h1.status).toBe("error");
    expect(h1.errorCode).toBe("remote_flockctl_missing");

    // Invariant: no reconnect timer pending. This is the whole point
    // of the terminal-code carve-out — a failed bootstrap to a host
    // that isn't running flockctl would otherwise loop forever.
    expect(vi.getTimerCount()).toBe(0);

    // Now the explicit user action — restart(). Before it returns we
    // should already have seen a second `spawn('ssh', …)` call.
    const spawnCountBefore = spawnMock.mock.calls.length;
    const p2 = mgr.restart("srv-1");

    // restart → start → (allocateLocalPort) → spawn. allocateLocalPort
    // uses a real socket, so yield to the event loop before asserting.
    await yieldEventLoop();
    expect(spawnMock.mock.calls.length).toBe(spawnCountBefore + 1);
    expect(children.length).toBe(2);

    // Clean shutdown of the still-pending probe on the second child.
    mgr.shutdown("srv-1");
    const h2 = await p2;
    expect(h2.status).toBe("stopped");
  });
});
