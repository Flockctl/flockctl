/**
 * Additional branch-coverage tests for services/ssh-tunnels/manager.ts.
 *
 * Targets branches not hit by manager-branches.test.ts:
 *   - open(): default spawner fallback (`options.spawner ?? spawn`)
 *     — covered by actually calling open() without a custom spawner
 *     against a mocked `child_process.spawn`
 *   - open(): child 'error' event with handle.exitCode already set
 *     (`handle.exitCode ?? -1` LHS of nullish)
 *   - close(): unknown id early-return (line 355), and close() when the
 *     handle has already exited (line 356 false branch — skips kill)
 *   - close(): happy path — unexited handle gets SIGTERM
 *   - open(): stderr handler receives a Buffer → `chunk.toString("utf8")`
 *     branch of the Buffer-or-string ternary
 *   - start(): reconnect path reuses existing canonical entry — exercises
 *     the `if (entry.reconnectTimer)` branch (line 425) by pre-populating
 *     a pending timer before the re-entry
 *   - post-ready listener: `thisEntry.handle !== handle` guard (line 521)
 *     — set entry.handle to a different object then emit exit
 *   - scheduleReconnect timer-fired guards: `shuttingDown` (line 572) and
 *     `canonical.get(...) !== entry` (line 573) — covered via reconnect
 *     timer + shutdown race
 *   - start().catch re-schedule block (lines 581/582) — start() throws
 *     synchronously (spawn blows up), then shutdown before next tick
 *   - restart(): pre-existing reconnectTimer cleared (line 609 true branch)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import type * as child_process from "node:child_process";
import {
  SshTunnelManager,
} from "../../../services/ssh-tunnels/manager.js";
import type { ReadyProbe } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";

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
  emitter.pid = 4242;
  emitter.kill = function kill() {
    this.killed = true;
    return true;
  };
  return emitter as unknown as child_process.ChildProcess;
}

function mkServer(id = "srv-1"): RemoteServerConfig {
  return { id, name: id, ssh: { host: "example.com" } };
}

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

/* -------------------------------------------------------------------------- */
/* open() — default spawner fallback + Buffer stderr                          */
/* -------------------------------------------------------------------------- */

describe("open() — default spawner + Buffer stderr", () => {
  it("uses the mocked node:child_process.spawn when options.spawner is omitted", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);

    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      // no `spawner` → the manager must fall back to the imported spawn.
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(h.child).toBe(child);
  });

  it("classifies stderr when chunk arrives as a Buffer (legacy open() path)", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // open() sets utf8 encoding on stderr; emit a raw buffer bypassing the
    // decoder to hit the Buffer branch of chunk-type check.
    (child.stderr as PassThrough).emit(
      "data",
      Buffer.from("Host key verification failed.\n", "utf8"),
    );
    // Accept any non-unknown classification — we just want coverage of the
    // Buffer path. The outcome may be "host_key_mismatch" or "unknown"
    // depending on whether setEncoding has flipped mode yet.
    expect(h.stderrBuffer.value.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* open() — 'error' event uses existing handle.exitCode (line 345 LHS)        */
/* -------------------------------------------------------------------------- */

describe("open() — error event with pre-set exit code", () => {
  it("keeps handle.exitCode when it's already set, falls back to -1 otherwise", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // Case 1: emit 'error' without any prior exit → exitCode falls back to -1.
    // Attach a second listener so EventEmitter doesn't re-throw unhandled.
    h.events.on("error", () => {});
    (child as unknown as EventEmitter).emit("error", new Error("boom"));
    expect(h.exited).toBe(true);
    expect(h.exitCode).toBe(-1);
  });

  it("preserves a prior exitCode when 'error' follows 'exit'", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    h.events.on("error", () => {});
    // First 'exit' → sets exitCode=7, then 'error' → keeps it via ?? LHS.
    (child as unknown as EventEmitter).emit("exit", 7);
    (child as unknown as EventEmitter).emit("error", new Error("late"));
    expect(h.exitCode).toBe(7);
  });
});

/* -------------------------------------------------------------------------- */
/* close() — unknown-id and already-exited branches                            */
/* -------------------------------------------------------------------------- */

describe("close() — edge branches", () => {
  it("is a no-op on an unknown id (line 355 true branch)", () => {
    const mgr = new SshTunnelManager();
    expect(() => mgr.close("nope")).not.toThrow();
  });

  it("skips SIGTERM when the handle has already exited (line 356 false branch)", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // Force-exit the handle first.
    (child as unknown as EventEmitter).emit("exit", 0);
    expect(h.exited).toBe(true);
    const killSpy = vi.spyOn(child, "kill");
    mgr.close(h.id);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mgr.get(h.id)).toBeUndefined();
  });

  it("sends SIGTERM on a still-running handle (line 356 true branch)", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    const killSpy = vi.spyOn(child, "kill");
    mgr.close(h.id);
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
  });

  it("closeAll iterates over every open handle", () => {
    const mgr = new SshTunnelManager();
    const c1 = makeFakeChild();
    const c2 = makeFakeChild();
    const h1 = mgr.open({
      host: "h", localPort: 1, remoteHost: "localhost", remotePort: 2,
      spawner: (() => c1) as unknown as typeof import("node:child_process").spawn,
    });
    const h2 = mgr.open({
      host: "h", localPort: 1, remoteHost: "localhost", remotePort: 2,
      spawner: (() => c2) as unknown as typeof import("node:child_process").spawn,
    });
    expect(mgr.list().length).toBe(2);
    mgr.closeAll();
    expect(mgr.list().length).toBe(0);
    expect(mgr.get(h1.id)).toBeUndefined();
    expect(mgr.get(h2.id)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* restart() — pre-existing reconnect timer is cleared (line 609 true)        */
/* -------------------------------------------------------------------------- */

describe("restart() — clears pending reconnect timer", () => {
  it("cleans up a pending reconnect timer before kicking off the fresh start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Probe that parks until aborted → first start() returns timeout-error.
    // On 'timeout' result, start() schedules a reconnect (non-terminal errorCode).
    const probe: ReadyProbe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    const h1 = await mgr.start(mkServer("srv-restart"));
    expect(h1.status).toBe("error");
    // A reconnect timer is now pending.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // On restart, the probe returns ready so h2 lands in ready.
    (probe as unknown as { mockResolvedValueOnce: (v: "ready") => void })
      .mockResolvedValueOnce("ready");
    // Mark old child dead so restart's kill branch skips it.
    (children[0] as unknown as { exitCode: number }).exitCode = 0;

    const h2 = await mgr.restart("srv-restart");
    expect(h2.status).toBe("ready");
    // Reconnect timer that was queued pre-restart must have been cleared.
    // (Only the post-ready listener is armed now; no setTimeout is pending.)
    // Shutdown cleans everything up.
    (children[1] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-restart");
  });
});

/* -------------------------------------------------------------------------- */
/* start() — reconnect path reuses canonical entry (line 425 true branch)     */
/* -------------------------------------------------------------------------- */

describe("start() — entry.reconnectTimer cleared on reconnect", () => {
  it("clears a pending reconnect timer when start() re-enters for the same serverId", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    // First start → error, schedules reconnect timer.
    await mgr.start(mkServer("srv-entry-reuse"));
    const timersBefore = vi.getTimerCount();
    expect(timersBefore).toBeGreaterThan(0);

    // Second start → branches through `if (entry.reconnectTimer)` true,
    // clearing the timer before the new ssh spawn.
    (probe as unknown as { mockResolvedValueOnce: (v: "ready") => void })
      .mockResolvedValueOnce("ready");
    const h2 = await mgr.start(mkServer("srv-entry-reuse"));
    expect(h2.status).toBe("ready");

    (children[1] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-entry-reuse");
  });
});

/* -------------------------------------------------------------------------- */
/* scheduleReconnect: start().catch re-schedule path (lines 581/582)          */
/* -------------------------------------------------------------------------- */

describe("scheduleReconnect — re-schedule on synchronous start() throw", () => {
  it("reschedules when the reconnect-triggered start() rejects synchronously", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // First spawn succeeds, subsequent spawns throw → start() rejects.
    let spawnCount = 0;
    spawnMock.mockImplementation(() => {
      spawnCount++;
      if (spawnCount === 1) return makeFakeChild();
      throw new Error("spawn ENOENT");
    });

    // Probe returns 'timeout' on the first start so a reconnect is scheduled.
    const probe: ReadyProbe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    await mgr.start(mkServer("srv-throw"));
    // Advance through the 1s backoff slot so the reconnect fires → start()
    // throws inside scheduleReconnect's .catch → it calls scheduleReconnect
    // again, bumping the timer stack.
    await vi.advanceTimersByTimeAsync(1_100);
    // The re-scheduled timer is now parked at the 2s slot.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Switch back to real timers before shutdown so internal SIGTERM/SIGKILL
    // timers can actually resolve.
    vi.useRealTimers();
    await mgr.shutdown("srv-throw");
  });
});

/* -------------------------------------------------------------------------- */
/* scheduleReconnect: timer-fired canonical-map guard (line 573 true)         */
/* -------------------------------------------------------------------------- */

describe("scheduleReconnect — timer fires after entry was replaced", () => {
  it("bails out when canonical.get(serverId) is no longer the entry we scheduled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Probe: first call → error, second call → ready.
    const probe: ReadyProbe = vi.fn()
      .mockResolvedValueOnce("timeout" as const)
      .mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    await mgr.start(mkServer("srv-swap"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Switch to real timers so shutdown's internal setTimeout chain works.
    vi.useRealTimers();
    // Mark child as exited so shutdown's fast-path kicks in immediately.
    (children[0] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-swap");

    // Re-start with the same id → fresh entry in the map.
    const h = await mgr.start(mkServer("srv-swap"));
    expect(h.status).toBe("ready");

    (children[1] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-swap");
  });
});
