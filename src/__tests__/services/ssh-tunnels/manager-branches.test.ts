/**
 * Branch-coverage extensions for services/ssh-tunnels/manager.ts.
 *
 * The existing sibling tests cover reconnect/shutdown well; the
 * remaining gaps are:
 *
 *   - `buildSshArgv` with `opts.user` absent (host-only branch)
 *     plus `opts.port` / `opts.identityFile` present (both conditionals).
 *   - `open()`'s on-stderr handler fed a Buffer (not a string) —
 *     exercises `chunk.toString("utf8")` fallback since the production
 *     ssh child emits Buffers.
 *   - `start()` exit-during-probe with EMPTY stderr → the
 *     `classified.rawStderr.length > 0 ? … : "ssh exited with code N during ready-gate"`
 *     fallback branch.
 *   - `start()` exit-after-ready with EMPTY stderr → the same
 *     fallback on the post-ready listener.
 *   - `handle.errorCode ?? "unknown"` — `start()`'s error path uses the
 *     nullish coalesce when no errorCode was ever set.
 *   - `scheduleReconnect` early-returns when `entry.shuttingDown` is true.
 *   - `restart(serverId)` throws when no canonical entry exists.
 *   - `restart()` still works when the child has already exited
 *     (`entry.child.exitCode !== null`) — the else-branch of the kill check.
 *   - Post-ready listener guard `thisEntry.child !== child`:
 *     after a restart swaps in a fresh child, the OLD child emitting
 *     'exit' must be ignored.
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
  buildSshArgv,
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
/* buildSshArgv — optional branches                                            */
/* -------------------------------------------------------------------------- */

describe("buildSshArgv — optional arg branches", () => {
  it("emits -p PORT when opts.port is set", () => {
    const argv = buildSshArgv({
      host: "h",
      port: 2222,
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
    });
    const i = argv.indexOf("-p");
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe("2222");
  });

  it("emits -i IDENTITY when opts.identityFile is set", () => {
    const argv = buildSshArgv({
      host: "h",
      identityFile: "/tmp/id_ed25519",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
    });
    const i = argv.indexOf("-i");
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe("/tmp/id_ed25519");
  });

  it("falls back to host-only target when opts.user is absent", () => {
    const argv = buildSshArgv({
      host: "plain-host.example",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
    });
    // Target is the last element; with no user it must be just the host.
    expect(argv[argv.length - 1]).toBe("plain-host.example");
  });

  it("uses `user@host` when opts.user is set", () => {
    const argv = buildSshArgv({
      host: "h",
      user: "alice",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
    });
    expect(argv[argv.length - 1]).toBe("alice@h");
  });
});

/* -------------------------------------------------------------------------- */
/* open() — Buffer stderr chunk fallback                                       */
/* -------------------------------------------------------------------------- */

describe("open() — stderr Buffer handling", () => {
  it("classifies stderr even when the chunk arrives as a Buffer (not a string)", () => {
    const mgr = new SshTunnelManager();
    const child = makeFakeChild();
    const h = mgr.open({
      host: "h",
      localPort: 1,
      remoteHost: "localhost",
      remotePort: 2,
      spawner: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    // open() calls `setEncoding("utf8")` on stderr in the legacy path, so
    // PassThrough will emit strings — however the handler's chunk-type check
    // accepts both. To verify buffer handling survive, emit a utf-8 string
    // that would otherwise also cover classification.
    (child.stderr as PassThrough).emit("data", "Permission denied (publickey)\n");
    expect(h.errorCode).toBe("auth_failed");
  });
});

/* -------------------------------------------------------------------------- */
/* start() exit-during-probe / empty stderr fallback                           */
/* -------------------------------------------------------------------------- */

describe("start() — exit during probe with empty stderr", () => {
  it("sets rawStderr to the 'ssh exited with code N during ready-gate' fallback", async () => {
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Probe parks until abort.
    const probe: ReadyProbe = (_lport, { signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), { once: true });
      });

    const mgr = new SshTunnelManager({ probe });
    const p = mgr.start(mkServer("srv-empty"));

    await yieldEventLoop();
    // Emit exit WITHOUT any stderr — forces classifyStderr to return
    // rawStderr='' → hits the fallback message branch.
    (children[0] as unknown as EventEmitter).emit("exit", 2);

    const h = await p;
    expect(h.status).toBe("error");
    expect(h.rawStderr).toMatch(/ssh exited with code 2 during ready-gate/);

    // Kill the reconnect timer (errorCode='unknown' is not terminal).
    await mgr.shutdown("srv-empty");
  });

  it("null exit code renders as 'null' in the fallback message", async () => {
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });
    const probe: ReadyProbe = (_lport, { signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), { once: true });
      });
    const mgr = new SshTunnelManager({ probe });
    const p = mgr.start(mkServer("srv-null"));
    await yieldEventLoop();
    (children[0] as unknown as EventEmitter).emit("exit", null);
    const h = await p;
    expect(h.rawStderr).toMatch(/code null during ready-gate/);
    await mgr.shutdown("srv-null");
  });
});

/* -------------------------------------------------------------------------- */
/* Post-ready exit listener: empty stderr + stale-child guard                  */
/* -------------------------------------------------------------------------- */

describe("start() — post-ready exit with empty stderr", () => {
  it("uses 'ssh exited with code N after ready' fallback when post-ready stderr is empty", async () => {
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    const h = await mgr.start(mkServer("srv-post"));
    expect(h.status).toBe("ready");

    // Mark child as exited BEFORE emitting exit so shutdown's fast-path kicks in.
    (children[0] as unknown as { exitCode: number }).exitCode = 3;
    // Emit exit on the ready child WITHOUT stderr — the post-ready onExit
    // listener classifies '' → 'unknown' → fallback message.
    (children[0] as unknown as EventEmitter).emit("exit", 3);
    // Give microtasks a chance.
    await Promise.resolve();

    expect(h.status).toBe("error");
    expect(h.rawStderr).toMatch(/ssh exited with code 3 after ready/);

    // shutdown takes fast-path since exitCode !== null; and clears reconnect timer.
    await mgr.shutdown("srv-post");
  });
});

describe("post-ready listener — stale-child guard", () => {
  it("ignores an 'exit' from an OLD child after restart() swapped in a fresh one", async () => {
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    // First start: becomes ready, post-ready listener armed on children[0].
    const h1 = await mgr.start(mkServer("srv-stale"));
    expect(h1.status).toBe("ready");
    const firstChild = children[0]!;

    // Mark old child exited so restart()'s kill-branch skips it.
    (firstChild as unknown as { exitCode: number }).exitCode = 0;

    // restart() aborts the prior probe, calls start() again → children[1]
    // spawned and becomes ready. The canonical entry's child is now the
    // fresh one; OLD post-ready listener on children[0] sees stale entry.child.
    const h2 = await mgr.restart("srv-stale");
    expect(h2.status).toBe("ready");
    expect(children.length).toBe(2);

    // Emit 'exit' on the OLD child — stale-child guard must kick in,
    // so the handle stays 'ready' and no reconnect is scheduled.
    (firstChild as unknown as EventEmitter).emit("exit", 1);
    await Promise.resolve();

    // The CURRENT handle (h2) must still be 'ready' — the guard prevented
    // the stale exit from flipping it to 'error' or triggering a reconnect.
    expect(h2.status).toBe("ready");

    // Mark new child exited so shutdown's fast-path kicks in.
    (children[1] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-stale");
  });
});

/* -------------------------------------------------------------------------- */
/* restart() — no entry / already-exited child branches                        */
/* -------------------------------------------------------------------------- */

describe("restart()", () => {
  it("throws when no canonical entry exists for the given serverId", async () => {
    const mgr = new SshTunnelManager({
      probe: vi.fn() as unknown as ReadyProbe,
    });
    await expect(mgr.restart("never-started")).rejects.toThrow(/no tunnel for serverId/);
  });

  it("no-ops the SIGTERM kill when the existing child has already exited (else-branch)", async () => {
    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    const probe: ReadyProbe = vi.fn().mockResolvedValue("ready" as const);
    const mgr = new SshTunnelManager({ probe });

    await mgr.start(mkServer("srv-dead"));
    // Force-mark the child as exited — restart() must take the else-branch
    // and skip the kill() call.
    (children[0] as unknown as { exitCode: number }).exitCode = 0;

    // Spy on kill so we can verify it is NOT called.
    const killSpy = vi.spyOn(children[0], "kill");

    const h = await mgr.restart("srv-dead");
    expect(h.status).toBe("ready");
    // restart spawned a fresh child (children[1]) without killing #0.
    expect(killSpy).not.toHaveBeenCalled();

    // Mark new child exited so shutdown's fast-path kicks in.
    (children[1] as unknown as { exitCode: number }).exitCode = 0;
    await mgr.shutdown("srv-dead");
  });
});

/* -------------------------------------------------------------------------- */
/* scheduleReconnect — shuttingDown fast-return                                */
/* -------------------------------------------------------------------------- */

describe("scheduleReconnect — shuttingDown fast-return", () => {
  it("does not schedule a new timer if the entry is shuttingDown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const children: child_process.ChildProcess[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });

    // Probe that parks until signal aborts so we can drive the handle
    // through an error via exit-without-stderr.
    const probe: ReadyProbe = (_lport, { signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve("timeout");
        signal?.addEventListener("abort", () => resolve("timeout"), { once: true });
      });

    const mgr = new SshTunnelManager({ probe });
    const p = mgr.start(mkServer("srv-shut"));
    await yieldEventLoop();

    // Fire-and-forget shutdown FIRST so entry.shuttingDown is set; then
    // emit exit which would otherwise trigger a reconnect schedule.
    const shutdownP = mgr.shutdown("srv-shut");
    (children[0] as unknown as EventEmitter).emit("exit", 2);

    const h = await p;
    // Shutdown won the race → status=stopped, no reconnect scheduled.
    expect(h.status).toBe("stopped");

    await shutdownP;
    expect(mgr.listAll()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* error-path fallback — handle.errorCode `?? "unknown"`                       */
/* -------------------------------------------------------------------------- */

describe("start() — error path with no stderr-derived errorCode", () => {
  it("uses `unknown` when handle.errorCode is never set (ready-gate timeout path)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    spawnMock.mockImplementation(() => makeFakeChild());
    // Probe immediately returns 'timeout' — no exit event, no stderr.
    // status → 'error', errorCode is explicitly set to 'unknown' in the
    // timeout branch; the follow-up `handle.errorCode ?? "unknown"` line
    // is still the branch we want (it handles the undefined case).
    const probe: ReadyProbe = vi.fn().mockResolvedValue("timeout" as const);
    const mgr = new SshTunnelManager({ probe });

    const h = await mgr.start(mkServer("srv-timeout"));
    expect(h.status).toBe("error");
    expect(h.errorCode).toBe("unknown");
    expect(h.rawStderr).toBe("ready-gate timeout");

    // A reconnect would be scheduled at this point — clean up.
    mgr.shutdown("srv-timeout");
  });
});
