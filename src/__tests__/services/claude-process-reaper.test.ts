import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process BEFORE importing the module under test so the dynamic
// `execFileSync` lookup binds to the mock.
const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  _resetTrackingForTests,
  _trackedPidsSnapshot,
  killClaudePid,
  listClaudeChildren,
  markAbort,
  parseEtime,
  pidAlive,
  reapNow,
  startReaper,
  stopReaper,
  trackPid,
  untrack,
} from "../../services/claude/process-reaper.js";

describe("parseEtime", () => {
  it("parses MM:SS", () => {
    expect(parseEtime("01:23")).toBe(83);
    expect(parseEtime("00:42")).toBe(42);
  });

  it("parses HH:MM:SS", () => {
    expect(parseEtime("01:02:03")).toBe(3_723);
    expect(parseEtime("10:00:00")).toBe(36_000);
  });

  it("parses DD-HH:MM:SS", () => {
    expect(parseEtime("2-03:04:05")).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
    expect(parseEtime("1-00:00:00")).toBe(86_400);
  });

  it("clamps NaN components to zero", () => {
    expect(parseEtime("xx:yy")).toBe(0);
  });

  it("parses single-component etime (sub-minute)", () => {
    expect(parseEtime("42")).toBe(42);
    expect(parseEtime("0")).toBe(0);
  });
});

describe("listClaudeChildren", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("returns only children of the given parent PID running the SDK binary", () => {
    // pid ppid etime command
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from(
        [
          // matching: ppid=999, command matches SDK binary
          "  100   999 53:28 /Users/foo/Desktop/Flockctl/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json --resume ec8b51d6-3361-4e8a-9564-b759cd2304e2",
          // matching: different etime, no resume
          "  101   999 02:05 /Users/foo/Desktop/Flockctl/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json --verbose",
          // wrong parent
          "  200    50 10:00 /Users/foo/Desktop/Flockctl/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json",
          // not the SDK binary
          "  300   999 10:00 /usr/local/bin/claude --version",
          // garbage line
          "garbage",
          "",
        ].join("\n"),
      ),
    );

    const out = listClaudeChildren(999);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      pid: 100,
      etimeSec: 53 * 60 + 28,
      resumeId: "ec8b51d6-3361-4e8a-9564-b759cd2304e2",
    });
    expect(out[1]).toEqual({ pid: 101, etimeSec: 2 * 60 + 5, resumeId: null });
  });

  it("returns empty array when ps fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("ps not found");
    });
    expect(listClaudeChildren(999)).toEqual([]);
  });

  it("returns empty array when no claude SDK procs exist", () => {
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("  100   999 01:00 /usr/bin/some-other-process"),
    );
    expect(listClaudeChildren(999)).toEqual([]);
  });
});

describe("PID registry (trackPid / markAbort / untrack)", () => {
  beforeEach(() => {
    _resetTrackingForTests();
  });

  it("trackPid is idempotent and starts with abortAt=null", () => {
    trackPid(42);
    trackPid(42);
    const snap = _trackedPidsSnapshot();
    expect(snap.size).toBe(1);
    expect(snap.get(42)).toEqual({ abortAt: null });
  });

  it("markAbort stamps the time on first call and is idempotent", () => {
    trackPid(42);
    markAbort(42);
    const first = _trackedPidsSnapshot().get(42)!.abortAt;
    expect(first).not.toBeNull();
    // second call must not move the timestamp — preserves the original abort moment
    markAbort(42);
    expect(_trackedPidsSnapshot().get(42)!.abortAt).toBe(first);
  });

  it("markAbort is a no-op for unknown PIDs", () => {
    markAbort(99_999);
    expect(_trackedPidsSnapshot().has(99_999)).toBe(false);
  });

  it("untrack removes the entry", () => {
    trackPid(42);
    untrack(42);
    expect(_trackedPidsSnapshot().has(42)).toBe(false);
  });
});

describe("pidAlive / killClaudePid", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("pidAlive returns true when kill(0) succeeds", () => {
    killSpy.mockImplementation(() => true);
    expect(pidAlive(42)).toBe(true);
  });

  it("pidAlive returns false when kill(0) throws", () => {
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(pidAlive(42)).toBe(false);
  });

  it("killClaudePid is a no-op when the PID is already gone", async () => {
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const ok = await killClaudePid(42, 100);
    expect(ok).toBe(true);
    // Only the kill(0) probe — no SIGTERM/SIGKILL escalation
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(42, 0);
  });

  it("killClaudePid sends SIGTERM and resolves true when the PID dies during grace", async () => {
    let calls = 0;
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      calls++;
      if (signal === 0) {
        // Pid alive on the first probe; dies after the SIGTERM was issued.
        if (calls <= 2) return true;
        throw new Error("ESRCH");
      }
      return true;
    });
    const ok = await killClaudePid(42, 500);
    expect(ok).toBe(true);
    // At minimum: probe(0), TERM, probe(0)+
    const signals = killSpy.mock.calls.map((c: unknown[]) => c[1]);
    expect(signals).toContain("SIGTERM");
  });

  it("killClaudePid waits across the polling sleep when PID survives the first probe", async () => {
    // Sequence: entry probe (alive) → SIGTERM → loop probe 1 (alive) → sleep
    // 100ms → loop probe 2 (dead) → return true. Exercises the `await new
    // Promise(setTimeout)` branch inside the grace loop.
    let aliveProbes = 0;
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        aliveProbes++;
        if (aliveProbes <= 2) return true;
        throw new Error("ESRCH");
      }
      return true;
    });
    const start = Date.now();
    const ok = await killClaudePid(42, 500);
    const elapsedMs = Date.now() - start;
    expect(ok).toBe(true);
    // The sleep is 100ms; at least one full sleep cycle should have run.
    expect(elapsedMs).toBeGreaterThanOrEqual(80);
    expect(aliveProbes).toBeGreaterThanOrEqual(2);
  });
});

describe("reapNow", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTrackingForTests();
    killSpy = vi.spyOn(process, "kill");
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("ignores tracked PIDs without an abort stamp", async () => {
    killSpy.mockImplementation(() => true); // alive
    trackPid(42);
    const killed = await reapNow(0);
    expect(killed).toEqual([]);
    // PID stays tracked because it's still alive and not marked
    expect(_trackedPidsSnapshot().has(42)).toBe(true);
  });

  it("untracks tracked PIDs that died on their own (no signal sent)", async () => {
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH"); // PID gone
    });
    trackPid(42);
    markAbort(42);
    const killed = await reapNow(0);
    // Dead PID was untracked, but killClaudePid wasn't even invoked because
    // the dead-pid check fires first. We assert by snapshot.
    expect(_trackedPidsSnapshot().has(42)).toBe(false);
    expect(killed).toEqual([]);
  });

  it("kills tracked PIDs whose abort window has elapsed", async () => {
    let probeCalls = 0;
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        // alive on the reap-probe + the in-killClaudePid probe; dies after SIGTERM.
        probeCalls++;
        if (probeCalls <= 2) return true;
        throw new Error("ESRCH");
      }
      return true; // SIGTERM accepted
    });
    trackPid(42);
    markAbort(42);
    // graceMs=0 → eligible immediately
    const killed = await reapNow(0);
    expect(killed).toEqual([42]);
    expect(_trackedPidsSnapshot().has(42)).toBe(false);
    expect(killSpy.mock.calls.some((c: unknown[]) => c[1] === "SIGTERM")).toBe(true);
  });

  it("respects the grace window — does not kill before it elapses", async () => {
    killSpy.mockImplementation(() => true); // PID stays alive
    trackPid(42);
    markAbort(42);
    const killed = await reapNow(60_000); // 1 minute grace
    expect(killed).toEqual([]);
    expect(_trackedPidsSnapshot().has(42)).toBe(true);
  });
});

describe("startReaper / stopReaper", () => {
  beforeEach(() => {
    _resetTrackingForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopReaper();
    vi.useRealTimers();
  });

  it("startReaper schedules a recurring sweep and stopReaper clears it", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const stop = startReaper({ intervalMs: 1_000, graceMs: 100 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(1_000);

    stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("startReaper is idempotent — second call replaces the first interval", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    startReaper({ intervalMs: 1_000 });
    startReaper({ intervalMs: 2_000 });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    stopReaper();
  });

  it("stopReaper is a no-op when no interval is active", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    stopReaper();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  it("the scheduled callback invokes reapNow when the interval elapses", () => {
    // Tracked PID with an abort timestamp in the past — reapNow should pick
    // it up when the interval fires. We don't need to assert kill behavior
    // here (covered above); the assertion is that the setInterval callback
    // body executes (line coverage for the `void reapNow(...)` body).
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH"); // pretend PID is dead so reaper untracks it
    });
    trackPid(7777);
    markAbort(7777);

    startReaper({ intervalMs: 500, graceMs: 0 });
    expect(_trackedPidsSnapshot().has(7777)).toBe(true);

    // Advance fake time past one interval — the callback runs synchronously
    // under fake timers and reapNow's first action is the dead-pid untrack.
    vi.advanceTimersByTime(500);

    // The interval body fired → reapNow was invoked → the dead-PID branch
    // untracked our entry.
    // The reapNow promise resolves on the next microtask; under fake timers
    // we flush via runAllTicks.
    return Promise.resolve().then(() => {
      expect(_trackedPidsSnapshot().has(7777)).toBe(false);
      killSpy.mockRestore();
    });
  });
});
