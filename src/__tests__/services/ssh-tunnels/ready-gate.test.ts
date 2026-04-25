/**
 * Tests for the ready-gate used by `SshTunnelManager.start()`.
 *
 * Two surfaces under test:
 *
 *   1. `waitForTunnelReady(lport, opts)` in isolation — verifies the
 *      polling contract, the happy path (resolves 'ready' on first 2xx),
 *      the timeout cap (resolves 'timeout'), and AbortSignal handling.
 *
 *   2. The integration into `SshTunnelManager.start()` — verifies that
 *      `start()` now awaits the probe and flips the handle into a final
 *      status, and that `manager.shutdown()` can cancel an in-flight
 *      probe (the "shutdown_during_ready_gate" scenario in the task spec).
 *
 * We never bind a real listener on the forwarded port. For the manager
 * integration tests we mock `node:child_process.spawn` and inject a
 * fake probe so the only network touchpoint under test is whatever the
 * probe function's tests assert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

// Spy on child_process.spawn the same way build-args.test.ts does — ESM
// namespace spies must go through `vi.mock`, not `vi.spyOn`.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import type * as child_process from "node:child_process";
import { waitForTunnelReady } from "../../../services/ssh-tunnels/ready-gate.js";
import { SshTunnelManager } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Spin up a real HTTP server on a random localhost port that responds
 * to `/health` with the given handler. Returns the port and a teardown.
 * Uses a real listener instead of a fetch stub so we exercise the genuine
 * fetch → HTTP server round-trip.
 */
async function startHealthServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Find a TCP port that is almost certainly unbound right now by binding,
 * reading the kernel-assigned port, then releasing it. There's a tiny
 * race window but for ECONNREFUSED-style tests the occasional flake is
 * better than hard-coding a port.
 */
async function pickUnboundPort(): Promise<number> {
  const srv = await startHealthServer(() => {});
  await srv.close();
  return srv.port;
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// waitForTunnelReady — pure function
// ---------------------------------------------------------------------------

describe("waitForTunnelReady — happy path", () => {
  it("resolves 'ready' on the first 2xx /health response", async () => {
    let hits = 0;
    const srv = await startHealthServer((_, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    try {
      const got = await waitForTunnelReady(srv.port, {
        timeoutMs: 2_000,
        pollMs: 50,
      });
      expect(got).toBe("ready");
      expect(hits).toBeGreaterThanOrEqual(1);
    } finally {
      await srv.close();
    }
  });

  it("keeps polling while /health returns 5xx until it flips to 2xx", async () => {
    let hits = 0;
    const srv = await startHealthServer((_, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503);
        res.end("not ready");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    });
    try {
      const got = await waitForTunnelReady(srv.port, {
        timeoutMs: 2_000,
        pollMs: 20,
      });
      expect(got).toBe("ready");
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      await srv.close();
    }
  });
});

describe("waitForTunnelReady — timeout", () => {
  it("resolves 'timeout' once the cap is reached and nothing ever responds", async () => {
    const port = await pickUnboundPort();
    const t0 = Date.now();
    const got = await waitForTunnelReady(port, {
      timeoutMs: 300,
      pollMs: 50,
    });
    const elapsed = Date.now() - t0;
    expect(got).toBe("timeout");
    // The cap is a ceiling, not a floor, but we allow some slack so the
    // assertion isn't dependent on CI scheduler jitter.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("waitForTunnelReady — AbortSignal honoured", () => {
  it("resolves 'timeout' when caller aborts mid-poll", async () => {
    const port = await pickUnboundPort();
    const ac = new AbortController();
    const promise = waitForTunnelReady(port, {
      timeoutMs: 10_000,
      pollMs: 50,
      signal: ac.signal,
    });
    // Give the probe a moment to issue its first (failing) fetch and enter
    // the sleep path. 80ms > pollMs so we almost certainly land in the
    // setTimeout sleep.
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    const got = await promise;
    expect(got).toBe("timeout");
  });

  it("returns 'timeout' immediately if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const got = await waitForTunnelReady(55555, { signal: ac.signal });
    expect(got).toBe("timeout");
    // Effectively instant. Anything under 50ms is fine; CI gives us more
    // headroom than that.
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// SshTunnelManager.start — integration with the probe
// ---------------------------------------------------------------------------

describe("SshTunnelManager.start — ready path", () => {
  it("awaits the probe and flips the handle to 'ready' with readyAt set", async () => {
    spawnMock.mockReturnValue(makeFakeChild());

    const probe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    const handle = await mgr.start(mkServer());

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toBe(handle.localPort);
    expect(handle.status).toBe("ready");
    expect(typeof handle.readyAt).toBe("number");
    expect(handle.readyAt! >= handle.startedAt!).toBe(true);
  });
});

describe("SshTunnelManager.start — timeout path", () => {
  it("flips the handle to 'error' with errorCode='unknown' and rawStderr='ready-gate timeout'", async () => {
    spawnMock.mockReturnValue(makeFakeChild());

    const probe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    const handle = await mgr.start(mkServer());

    expect(handle.status).toBe("error");
    expect(handle.errorCode).toBe("unknown");
    expect(handle.rawStderr).toBe("ready-gate timeout");
  });
});

describe("SshTunnelManager.start — child exits during probe", () => {
  it("aborts the probe and surfaces an error with a placeholder rawStderr", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    // Probe that blocks until its signal aborts — simulates "port never
    // becomes reachable". The manager's 'exit' listener aborts the signal
    // when the child dies.
    const probe: import("../../../services/ssh-tunnels/manager.js").ReadyProbe = (
      _lport,
      { signal },
    ) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), {
          once: true,
        });
      });

    const mgr = new SshTunnelManager({ probe });

    const startPromise = mgr.start(mkServer());
    // Let start() register its exit listener before we fire 'exit'.
    await new Promise((r) => setImmediate(r));
    (child as unknown as EventEmitter).emit("exit", 255);

    const handle = await startPromise;
    expect(handle.status).toBe("error");
    expect(handle.errorCode).toBe("unknown");
    expect(handle.rawStderr).toMatch(/ssh exited with code 255/);
  });
});

describe("shutdown_during_ready_gate", () => {
  it("cancels an in-flight probe (pure waitForTunnelReady + fake timers, no dangling timers)", async () => {
    // Exercise the timer-cleanup invariant against the pure probe, with a
    // fetch stub that rejects synchronously. That isolates the only timers
    // in play to the ones ready-gate.ts itself schedules, so
    // `vi.getTimerCount()` gives us a clean assertion.
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const ac = new AbortController();

    const probePromise = waitForTunnelReady(55555, {
      timeoutMs: 60_000,
      pollMs: 500,
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Microtask pump so the first fetch attempt runs and rejects, landing
    // us in sleepOrAbort(pollMs). No real setTimeout is needed for the
    // reject — the fetch stub returns a pre-rejected promise.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // We are now parked in sleepOrAbort(500). Exactly one pending timer.
    expect(vi.getTimerCount()).toBe(1);

    // Abort mid-poll. The sleep's abort listener clears the timer and
    // resolves false → probe returns 'timeout'.
    ac.abort();

    const got = await probePromise;
    expect(got).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manager.shutdown() flips the handle to 'stopped' and releases a pending probe", async () => {
    spawnMock.mockReturnValue(makeFakeChild());

    // Probe that only resolves when its signal aborts — the manager is
    // responsible for wiring shutdown → abort → probe release.
    const probe: import("../../../services/ssh-tunnels/manager.js").ReadyProbe = (
      _lport,
      { signal },
    ) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), {
          once: true,
        });
      });

    const mgr = new SshTunnelManager({ probe });
    const startPromise = mgr.start(mkServer());

    // Let start() register the probe before we shut down.
    await new Promise((r) => setImmediate(r));

    mgr.shutdown();

    const handle = await startPromise;
    expect(handle.status).toBe("stopped");
    // After shutdown, the canonical entry is evicted.
    expect(mgr.getByServerId("srv-1")).toBeNull();
  });

  it("shutdown(serverId) only tears down the matching tunnel", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());

    // Probe that never resolves until signal aborts.
    const probe: import("../../../services/ssh-tunnels/manager.js").ReadyProbe = (
      _lport,
      { signal },
    ) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve("timeout"), {
          once: true,
        });
      });

    const mgr = new SshTunnelManager({ probe });

    const aPromise = mgr.start(mkServer("a"));
    const bPromise = mgr.start(mkServer("b"));

    // Let both starts register their probes.
    await new Promise((r) => setImmediate(r));

    mgr.shutdown("a");

    const a = await aPromise;
    expect(a.status).toBe("stopped");

    // b is still in the map and still mid-probe.
    expect(mgr.getByServerId("b")?.status).toBe("starting");

    // Clean up so the test doesn't leak a dangling promise.
    mgr.shutdown("b");
    await bPromise;
  });
});
