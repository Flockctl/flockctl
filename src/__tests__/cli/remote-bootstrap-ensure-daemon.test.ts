/**
 * `ensureDaemonRunning` — the "make sure the daemon is up before we mint a
 * token" gate that `flockctl remote-bootstrap` sits on top of.
 *
 * The production function has two side-effectful defaults (fork a detached
 * server-entry, call `fetch` against /health) that we don't want to exercise
 * in a unit test. Every case here swaps both out via the public `deps`
 * parameter, so the test suite never touches real pidfiles, real sockets,
 * or real child processes.
 *
 * Coverage map:
 *  - Fast path: a live pid + a 200 from /health within 500 ms returns
 *    immediately without invoking `startDaemon`.
 *  - Slow start: no pid → `startDaemon` is invoked, we poll /health every
 *    100 ms, and return as soon as the daemon answers.
 *  - Stale pidfile: `readPid` returning `null` (the production
 *    `getRunningPid` cleans up stale pids and returns null) routes through
 *    the spawn path.
 *  - Fast-probe timeout: pid is live but /health doesn't answer within
 *    500 ms → we fall through to spawn + poll instead of trusting the pid
 *    alone.
 *  - Timeout: /health never answers → throw `DaemonStartTimeoutError` with
 *    `errorCode === 'daemon_start_timeout'` and a message that names the
 *    port and the 5000 ms deadline.
 *  - Concurrency: two parallel `ensureDaemonRunning` calls share a single
 *    `startDaemon` invocation (in-process mutex) and both see the daemon
 *    become healthy via the same fake pidfile write. This mirrors the
 *    "bootstrap_while_daemon_starting" scenario called out in the spec —
 *    two SSH bootstrap sessions hitting the same machine must never
 *    double-fork a daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  ensureDaemonRunning,
  DaemonStartTimeoutError,
  ENSURE_DAEMON_FAST_HEALTH_TIMEOUT_MS,
  ENSURE_DAEMON_STARTUP_DEADLINE_MS,
  __resetEnsureDaemonRunningForTests,
} from "../../cli-commands/remote-bootstrap.js";

/* -------------------------------------------------------------------------- */
/* Fake infrastructure                                                         */
/* -------------------------------------------------------------------------- */

/** A controllable fake for the pidfile — writes and reads go through a single
 * in-memory box so the fake `startDaemon` and `readPid` can cooperate. */
class FakePidStore {
  private pid: number | null = null;

  read(): number | null {
    return this.pid;
  }

  /** Mimic the O_EXCL claim: first writer wins, subsequent callers observe
   * the existing pid. We return whether the write took. */
  claim(pid: number): boolean {
    if (this.pid !== null) return false;
    this.pid = pid;
    return true;
  }

  clear(): void {
    this.pid = null;
  }
}

/** Pair a fake /health probe with a switch the test can flip from
 * "unreachable" to "200" at an exact moment. */
function makeHealthProbe() {
  let healthy = false;
  const calls: Array<{ port: number; timeoutMs: number; at: number }> = [];
  const probe = async (port: number, timeoutMs: number): Promise<boolean> => {
    calls.push({ port, timeoutMs, at: Date.now() });
    return healthy;
  };
  return {
    probe,
    calls,
    become(alive: boolean) {
      healthy = alive;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared lifecycle                                                           */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  __resetEnsureDaemonRunningForTests();
});

afterEach(() => {
  __resetEnsureDaemonRunningForTests();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Fast path                                                                  */
/* -------------------------------------------------------------------------- */

describe("ensureDaemonRunning — fast path", () => {
  it("returns immediately when pid is live and /health is 200", async () => {
    const pids = new FakePidStore();
    pids.claim(42);
    const health = makeHealthProbe();
    health.become(true);

    const startDaemon = vi.fn();

    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon,
    });

    expect(startDaemon).not.toHaveBeenCalled();
    expect(health.calls.length).toBe(1);
    expect(health.calls[0].port).toBe(52077);
    expect(health.calls[0].timeoutMs).toBe(ENSURE_DAEMON_FAST_HEALTH_TIMEOUT_MS);
  });

  it("passes the exact 500 ms fast-probe timeout", async () => {
    const pids = new FakePidStore();
    pids.claim(1);
    const health = makeHealthProbe();
    health.become(true);

    await ensureDaemonRunning(1234, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon: () => {
        throw new Error("must not spawn on fast path");
      },
    });

    expect(health.calls[0].timeoutMs).toBe(500);
  });
});

/* -------------------------------------------------------------------------- */
/* Spawn + poll path                                                          */
/* -------------------------------------------------------------------------- */

describe("ensureDaemonRunning — spawn path", () => {
  it("calls startDaemon when no pidfile is present", async () => {
    const pids = new FakePidStore();
    const health = makeHealthProbe();
    const startDaemon = vi.fn((port: number) => {
      // Simulate a successful fork: the daemon becomes healthy synchronously
      // as soon as it's asked to start. Real code is async; the deps interface
      // handles both.
      pids.claim(9999);
      health.become(true);
      void port;
    });

    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon,
    });

    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith(52077);
    expect(pids.read()).toBe(9999);
  });

  it("polls /health until it answers 200", async () => {
    const pids = new FakePidStore();
    const health = makeHealthProbe();
    let calls = 0;
    const probe = async (port: number, timeoutMs: number): Promise<boolean> => {
      calls++;
      // Fail the first 2 polls, then answer.
      if (calls >= 3) {
        health.become(true);
        return health.probe(port, timeoutMs);
      }
      return health.probe(port, timeoutMs);
    };

    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: probe,
      startDaemon: () => {
        // Don't mark healthy yet — force the polling loop to run.
      },
      sleep: async () => {}, // collapse the 100 ms gap in the test clock
    });

    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("falls through to spawn when pid is live but /health is unreachable", async () => {
    // Covers the "daemon crashed and the pidfile was never cleaned" case: we
    // don't want to trust a live pid without confirming /health.
    const pids = new FakePidStore();
    pids.claim(77);
    const health = makeHealthProbe();
    const startDaemon = vi.fn(() => {
      // Now the real daemon is up.
      health.become(true);
    });

    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon,
      sleep: async () => {},
    });

    expect(startDaemon).toHaveBeenCalledTimes(1);
  });

  it("routes through spawn when readPid returns null (stale pidfile swept)", async () => {
    const pids = new FakePidStore();
    // Never claim: readPid returns null.
    const health = makeHealthProbe();
    const startDaemon = vi.fn(() => {
      pids.claim(321);
      health.become(true);
    });

    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon,
      sleep: async () => {},
    });

    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(health.calls.some((c) => c.port === 52077)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Timeout                                                                    */
/* -------------------------------------------------------------------------- */

describe("ensureDaemonRunning — timeout", () => {
  it("throws DaemonStartTimeoutError when /health never answers", async () => {
    const pids = new FakePidStore();
    const health = makeHealthProbe();
    // Never flip healthy → all probes return false.

    // Fake `sleep` collapses the 100 ms delay between polls so the test
    // finishes fast. The real deadline is 5 s, but `Date.now()` still
    // advances naturally, so we also advance it manually via vi.setSystemTime.
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = 1_000_000;
    let now = start;
    vi.setSystemTime(now);

    const err = await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon: () => {
        /* simulate a spawn that never comes up */
      },
      sleep: async (ms: number) => {
        now += ms;
        vi.setSystemTime(now);
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DaemonStartTimeoutError);
    expect(err.errorCode).toBe("daemon_start_timeout");
    expect(err.port).toBe(52077);
    expect(err.deadlineMs).toBe(ENSURE_DAEMON_STARTUP_DEADLINE_MS);
    expect(err.message).toContain("52077");
    expect(err.message).toContain("5000");
  });

  it("carries the DaemonStartTimeoutError name so callers can match on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = 0;
    vi.setSystemTime(now);

    const err = await ensureDaemonRunning(6000, {
      readPid: () => null,
      checkHealth: async () => false,
      startDaemon: () => {},
      sleep: async (ms: number) => {
        now += ms;
        vi.setSystemTime(now);
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonStartTimeoutError");
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency: bootstrap_while_daemon_starting                               */
/* -------------------------------------------------------------------------- */

describe("ensureDaemonRunning — concurrent callers", () => {
  it("two parallel calls share one startDaemon and observe the same pid", async () => {
    // This is the "bootstrap_while_daemon_starting" scenario from the spec:
    // two SSH sessions trigger `remote-bootstrap` at the same moment. The
    // fake startDaemon waits 300 ms (simulating fork + `ready` message)
    // before claiming the pidfile, and only the first caller gets through
    // it — the second rides the shared in-process promise.
    const pids = new FakePidStore();
    const health = makeHealthProbe();
    const spawnedPids: number[] = [];

    let startDaemonCalls = 0;
    const slowStartDaemon = vi.fn(async (port: number) => {
      startDaemonCalls++;
      // Mimic real fork latency.
      await new Promise((r) => setTimeout(r, 50));
      // Claim the pidfile (O_EXCL-style: first writer wins).
      if (pids.claim(12345)) {
        spawnedPids.push(12345);
        health.become(true);
      }
      void port;
    });

    const a = ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon: slowStartDaemon,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });
    const b = ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon: slowStartDaemon,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });

    await Promise.all([a, b]);

    // Exactly one startDaemon call across both bootstraps. The in-process
    // mutex is what guarantees this — without it we'd fork twice and let
    // the pidfile race sort it out, which is slower and leaks a server.
    expect(startDaemonCalls).toBe(1);
    // Exactly one pid claim succeeded.
    expect(spawnedPids).toEqual([12345]);
    // Both callers now see the same pid in the pidfile.
    expect(pids.read()).toBe(12345);
  });

  it("a third call after the first pair completes uses the fast path", async () => {
    const pids = new FakePidStore();
    const health = makeHealthProbe();
    let starts = 0;
    const startDaemon = vi.fn(async () => {
      starts++;
      await new Promise((r) => setTimeout(r, 10));
      pids.claim(999);
      health.become(true);
    });

    await Promise.all([
      ensureDaemonRunning(52077, {
        readPid: () => pids.read(),
        checkHealth: health.probe,
        startDaemon,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      }),
      ensureDaemonRunning(52077, {
        readPid: () => pids.read(),
        checkHealth: health.probe,
        startDaemon,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      }),
    ]);

    // A later call: pid is live, health is up → fast path, zero new spawns.
    await ensureDaemonRunning(52077, {
      readPid: () => pids.read(),
      checkHealth: health.probe,
      startDaemon,
    });
    expect(starts).toBe(1);
  });
});
