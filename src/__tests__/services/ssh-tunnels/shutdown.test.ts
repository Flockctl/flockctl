/**
 * Shutdown + parallel-start tests for {@link SshTunnelManager}.
 *
 * Two surfaces under test:
 *
 *   1. `rapid_start_stop_cycle_no_leak` — 100 iterations of `start → stop`
 *      leave the canonical map empty, no dangling reconnect timers, and
 *      every spawned child has observed an `'exit'` event.
 *
 *   2. `parallel_tunnels_10` — firing 10 concurrent `start()` calls gives
 *      10 handles with *distinct* local ports and status `'ready'`, and
 *      the port allocator lock prevents duplicate ports even when the
 *      underlying kernel allocator is asked for ports concurrently.
 *
 * Both tests mock `node:child_process.spawn` and inject a ready-probe so
 * no real ssh child or HTTP call happens. The fake-child factory here
 * differs from the one shared across the other suites: its `kill()`
 * implementation emits `'exit'` on the next microtask so the manager's
 * SIGTERM path resolves promptly. Without that, each `stop()` would park
 * for 3 s waiting on a fake child that never exits and the 100-iteration
 * loop would take >5 minutes.
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
// Fake ChildProcess — emits 'exit' on kill() so stop() resolves quickly.
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (sig?: NodeJS.Signals) => boolean;
  killed: boolean;
  exitCode: number | null;
  pid?: number;
};

/**
 * Auto-exiting fake child.
 *
 * Unlike the `makeFakeChild` helper used in ready-gate / reconnect tests,
 * this variant wires `kill()` to schedule an `'exit'` event on the next
 * microtask. That models a well-behaved ssh process that honours SIGTERM
 * without needing the manager's SIGKILL fallback to fire, and keeps the
 * 100-iteration loop fast. The manager's SIGKILL escalation is covered
 * separately by the `sigkill_escalates_when_sigterm_ignored` test below,
 * which uses a child that ignores SIGTERM.
 */
function makeAutoExitChild(): child_process.ChildProcess {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.pid = 4242;
  emitter.kill = function kill(_sig?: NodeJS.Signals) {
    if (this.killed) return true;
    this.killed = true;
    // Next microtask so start()'s own `'exit'` listener has already been
    // wired up by the time we emit. Using queueMicrotask (not setTimeout)
    // keeps the test free of real timers.
    queueMicrotask(() => {
      if (this.exitCode === null) this.exitCode = 0;
      this.emit("exit", 0);
    });
    return true;
  };
  return emitter as unknown as child_process.ChildProcess;
}

/**
 * Fake child that ignores SIGTERM and only exits when SIGKILL is sent.
 * Used to exercise the manager's SIGKILL escalation path under fake
 * timers — we advance past the 3 s SIGTERM window and observe the
 * SIGKILL signal landing.
 */
function makeStubbornChild(): {
  child: child_process.ChildProcess;
  killSignals: NodeJS.Signals[];
} {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.pid = 4242;
  const killSignals: NodeJS.Signals[] = [];
  emitter.kill = function kill(sig?: NodeJS.Signals) {
    const s = sig ?? "SIGTERM";
    killSignals.push(s);
    if (s === "SIGKILL") {
      this.killed = true;
      queueMicrotask(() => {
        if (this.exitCode === null) this.exitCode = -9;
        this.emit("exit", -9);
      });
    }
    return true;
  };
  return { child: emitter as unknown as child_process.ChildProcess, killSignals };
}

function mkServer(id: string): RemoteServerConfig {
  return { id, name: id, ssh: { host: "example.com" } };
}

/**
 * Yield to the event loop so `allocateLocalPort`'s real socket bind
 * callback (and any setImmediate-scheduled work) can run. Microtask
 * draining alone is not enough — `net.createServer().listen()` fires
 * its callback on the I/O check phase.
 */
async function yieldEventLoop(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => setImmediate(r));
    for (let j = 0; j < 5; j++) await Promise.resolve();
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
// rapid_start_stop_cycle_no_leak
// ---------------------------------------------------------------------------

describe("rapid_start_stop_cycle_no_leak", () => {
  it("100 iterations of start→stop leave the canonical map empty and reap every child", async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeAutoExitChild() as unknown as FakeChild;
      children.push(c);
      return c as unknown as child_process.ChildProcess;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    for (let i = 0; i < 100; i++) {
      const cfg = mkServer(`srv-${i}`);
      const h = await mgr.start(cfg);
      expect(h.status).toBe("ready");
      await mgr.stop(cfg.id);
    }

    // No residual canonical entries — every stop() evicted its entry.
    expect(mgr.listAll()).toHaveLength(0);

    // Every child we spawned saw an 'exit' — i.e. kill() fired and the
    // event propagated. Our auto-exit fake sets exitCode=0 in the emit
    // path, so checking exitCode!==null is a proxy for "reaped".
    expect(children).toHaveLength(100);
    for (const c of children) {
      expect(c.killed).toBe(true);
      expect(c.exitCode).not.toBeNull();
    }
  });

  it("stop() on an unknown serverId is a no-op (does not throw, does not touch the map)", async () => {
    const mgr = new SshTunnelManager({ probe: vi.fn() as unknown as ReadyProbe });
    await expect(mgr.stop("never-started")).resolves.toBeUndefined();
    expect(mgr.listAll()).toHaveLength(0);
  });

  it("stop() is idempotent — calling twice on the same id is safe", async () => {
    spawnMock.mockImplementation(() => makeAutoExitChild());
    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    await mgr.start(mkServer("srv-1"));
    await mgr.stop("srv-1");
    // Second stop should be a no-op; map already evicted.
    await expect(mgr.stop("srv-1")).resolves.toBeUndefined();
    expect(mgr.listAll()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parallel_tunnels_10
// ---------------------------------------------------------------------------

describe("parallel_tunnels_10", () => {
  it("10 concurrent start() calls produce 10 handles with distinct localPorts and status 'ready'", async () => {
    spawnMock.mockImplementation(() => makeAutoExitChild());
    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    const configs = Array.from({ length: 10 }, (_, i) => mkServer(`srv-${i}`));
    const handles = await Promise.all(configs.map((c) => mgr.start(c)));

    expect(handles).toHaveLength(10);
    for (const h of handles) {
      expect(h.status).toBe("ready");
      expect(h.localPort).toBeGreaterThan(0);
      expect(h.localPort).toBeLessThanOrEqual(65535);
    }

    // Distinct ports — the port-allocator lock serialises bind/close so
    // no two starts receive the same kernel-assigned port.
    const ports = new Set(handles.map((h) => h.localPort));
    expect(ports.size).toBe(10);

    // Clean up so the test doesn't leak children into later cases.
    await mgr.shutdown();
    expect(mgr.listAll()).toHaveLength(0);
  });

  it("shutdown() tears down every tunnel in parallel and resolves once they are all reaped", async () => {
    spawnMock.mockImplementation(() => makeAutoExitChild());
    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    // Spin up five tunnels serially (we don't need concurrency for this
    // assertion; we only care that shutdown fans out correctly).
    for (let i = 0; i < 5; i++) {
      await mgr.start(mkServer(`srv-${i}`));
    }
    expect(mgr.listAll()).toHaveLength(5);

    await mgr.shutdown();

    expect(mgr.listAll()).toHaveLength(0);
    // getByServerId returns null for every id after full shutdown.
    for (let i = 0; i < 5; i++) {
      expect(mgr.getByServerId(`srv-${i}`)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// SIGKILL escalation + reconnect suppression
// ---------------------------------------------------------------------------

describe("stop() signal escalation and reconnect suppression", () => {
  it("sigkill_escalates_when_sigterm_ignored: SIGTERM → 3 s wait → SIGKILL", async () => {
    // Only fake the timers we control — allocateLocalPort still needs
    // real setImmediate/process.nextTick to bind+close its socket.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { child, killSignals } = makeStubbornChild();
    spawnMock.mockReturnValue(child);

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    await mgr.start(mkServer("srv-1"));

    // Fire-and-forget stop — we'll drive the fake timers to completion.
    const stopPromise = mgr.stop("srv-1");

    // After stop() has awaited microtasks, it should have sent SIGTERM
    // and be parked in the 3 s setTimeout waiting for exit.
    await yieldEventLoop();
    expect(killSignals).toEqual(["SIGTERM"]);

    // Advance past the SIGTERM grace window → manager escalates to
    // SIGKILL. Our stubborn child honours SIGKILL and emits 'exit' on
    // the next microtask, which lets stop() resolve.
    await vi.advanceTimersByTimeAsync(3_000);
    await yieldEventLoop();
    expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    await stopPromise;
    expect(mgr.listAll()).toHaveLength(0);
  });

  it("stop() prevents the post-ready child-exit listener from scheduling a reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Track every child we hand out so we can emit 'exit' by hand.
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      // Use a passive child (no auto-exit-on-kill) so we can choreograph
      // the sequence: start → ready → stop → child-exit-after-stop.
      const c = new EventEmitter() as FakeChild;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.killed = false;
      c.exitCode = null;
      c.pid = 4242;
      c.kill = function kill() {
        // Mark killed but do NOT emit 'exit'. The test will either emit
        // exit manually (simulating reap) or let the SIGKILL grace
        // timer fire.
        this.killed = true;
        return true;
      };
      children.push(c as unknown as child_process.ChildProcess);
      return c as unknown as child_process.ChildProcess;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    const h = await mgr.start(mkServer("srv-1"));
    expect(h.status).toBe("ready");

    // Kick off stop(); don't await yet — we want to emit 'exit' while
    // stop() is parked in the SIGTERM-wait timer so we can observe that
    // no reconnect gets scheduled after the entry is evicted.
    const stopPromise = mgr.stop("srv-1");

    // Snapshot setTimeout calls *after* stop() installs its 3 s timer
    // so we can tell reconnect scheduling apart from shutdown timers.
    await yieldEventLoop();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Now emit 'exit' on the child — this unblocks stop() via its
    // 'exit' listener AND would normally fire the post-ready exit
    // listener which, on an unmarked entry, schedules a reconnect.
    // With `shuttingDown` set that listener must bail out.
    (children[0] as unknown as EventEmitter).emit("exit", 1);

    await stopPromise;

    // No reconnect was scheduled after we started watching.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(mgr.listAll()).toHaveLength(0);
  });
});
