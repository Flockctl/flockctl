// ─── heartbeat_scheduler — unit tests ───
//
// Pins the slice 11/04 §"heartbeat scheduler" contract:
//
//   • registerHeartbeats() iterates the active-mission set and installs
//     ONE cron handle per mission, idempotently.
//   • unregisterHeartbeat() removes the handle on pause / abort / delete.
//   • a tick that fires AFTER unregister (rogue tick) does NOT invoke the
//     callback — the handler re-checks the in-memory map AND the live
//     mission status before dispatching.
//   • the callback's throw is logged + swallowed so the next tick still
//     runs (the timeline is the durable source of truth).
//
// Tests inject a SYNCHRONOUS fake scheduler so we can drive ticks
// deterministically. `tick(missionId)` invokes the registered cron
// callback for that mission's handle directly — no fake timers, no
// 15-minute waits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_CRON_EXPRESSION,
  registerHeartbeat,
  registerHeartbeats,
  unregisterAllHeartbeats,
  unregisterHeartbeat,
  __getHeartbeatMissionIds,
  __resetHeartbeats,
  type HeartbeatScheduler,
} from "../../services/missions/heartbeat.js";

// ─────────────────────────────────────────────────────────────────────
// Test fakes
// ─────────────────────────────────────────────────────────────────────

interface FakeScheduler extends HeartbeatScheduler {
  /** Map of cron-expression → array of (callback, stop-flag) entries
   *  installed against that expression. Drives the tick() helper. */
  jobs: Array<{ expression: string; fn: () => void; stopped: boolean }>;
  /** Run every CURRENTLY-INSTALLED job once. */
  tickAll(): void;
}

function makeFakeScheduler(): FakeScheduler {
  const jobs: FakeScheduler["jobs"] = [];
  return {
    jobs,
    schedule(expression, fn) {
      const entry = { expression, fn, stopped: false };
      jobs.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
        },
      };
    },
    tickAll() {
      // Snapshot the live (non-stopped) entries before invoking — a
      // tick may mutate the map (self-unregister) so iterating the live
      // set would either skip or double-fire entries.
      const live = jobs.filter((j) => !j.stopped);
      for (const j of live) j.fn();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetHeartbeats();
});

afterEach(() => {
  __resetHeartbeats();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// heartbeat_scheduler — registration / unregistration / cadence
// ─────────────────────────────────────────────────────────────────────

describe("heartbeat_scheduler", () => {
  it("uses the 15-minute cron expression", () => {
    expect(HEARTBEAT_CRON_EXPRESSION).toBe("*/15 * * * *");
  });

  it("registerHeartbeats installs one cron per active mission", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    const result = registerHeartbeats(
      (id) => {
        calls.push(id);
      },
      {
        scheduler: fake,
        readActiveMissionIds: () => ["m-1", "m-2", "m-3"],
        readMissionStatus: () => "active",
      },
    );

    expect(result.registered).toEqual(["m-1", "m-2", "m-3"]);
    expect(result.alreadyActive).toEqual([]);
    expect(fake.jobs).toHaveLength(3);
    for (const j of fake.jobs) {
      expect(j.expression).toBe("*/15 * * * *");
      expect(j.stopped).toBe(false);
    }
    expect(__getHeartbeatMissionIds().sort()).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("registerHeartbeat is idempotent — second register for the same id is a no-op", () => {
    const fake = makeFakeScheduler();
    registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1"],
      readMissionStatus: () => "active",
    });
    expect(fake.jobs).toHaveLength(1);

    // Second register attempt — must NOT install a second cron handle.
    registerHeartbeat("m-1");
    expect(fake.jobs).toHaveLength(1);
  });

  it("ticking the registered cron invokes the heartbeat callback for that mission", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    registerHeartbeats((id) => {
        calls.push(id);
      }, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1", "m-2"],
      readMissionStatus: () => "active",
    });

    fake.tickAll();

    expect(calls.sort()).toEqual(["m-1", "m-2"]);
  });

  it("unregisterHeartbeat removes the handle and prevents future ticks", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    registerHeartbeats((id) => {
        calls.push(id);
      }, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1", "m-2"],
      readMissionStatus: () => "active",
    });

    expect(unregisterHeartbeat("m-1")).toBe(true);
    expect(__getHeartbeatMissionIds()).toEqual(["m-2"]);
    // The fake's job for m-1 is marked stopped — tickAll() filters those.
    fake.tickAll();
    expect(calls).toEqual(["m-2"]);
  });

  it("unregisterHeartbeat returns false for an unknown mission id", () => {
    expect(unregisterHeartbeat("never-registered")).toBe(false);
  });

  it("rogue tick after unregister: tick fires from a stale handle but the callback is NOT invoked", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    registerHeartbeats((id) => {
        calls.push(id);
      }, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1"],
      readMissionStatus: () => "active",
    });

    // Capture the registered tick fn BEFORE unregister, simulating a
    // tick that was queued for execution before stop() landed.
    const installedFn = fake.jobs[0].fn;
    unregisterHeartbeat("m-1");
    expect(__getHeartbeatMissionIds()).toEqual([]);

    // Fire the stale tick — handler must NOT invoke the callback.
    installedFn();
    expect(calls).toEqual([]);
  });

  it("tick on a mission whose status flipped to paused self-unregisters and skips the callback", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    let liveStatus: string = "active";
    registerHeartbeats((id) => {
        calls.push(id);
      }, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1"],
      readMissionStatus: () => liveStatus,
    });

    // Mission gets paused between ticks — the next tick must self-clean.
    liveStatus = "paused";
    fake.tickAll();
    expect(calls).toEqual([]);
    expect(__getHeartbeatMissionIds()).toEqual([]);
  });

  it("tick on a mission whose row is gone (deleted) self-unregisters and skips the callback", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    let row: string | null = "active";
    registerHeartbeats((id) => {
        calls.push(id);
      }, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1"],
      readMissionStatus: () => row,
    });

    row = null; // mission deleted
    fake.tickAll();
    expect(calls).toEqual([]);
    expect(__getHeartbeatMissionIds()).toEqual([]);
  });

  it("a callback throw is logged + swallowed so the next mission's tick still runs", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerHeartbeats(
      (id) => {
        calls.push(id);
        if (id === "m-1") throw new Error("boom");
      },
      {
        scheduler: fake,
        readActiveMissionIds: () => ["m-1", "m-2"],
        readMissionStatus: () => "active",
      },
    );

    fake.tickAll();
    // Both ticks ran — the throw on m-1 did not abort the m-2 tick.
    expect(calls.sort()).toEqual(["m-1", "m-2"]);
    expect(warn).toHaveBeenCalled();
  });

  it("a callback that returns a rejected promise is logged + swallowed (async errors)", async () => {
    const fake = makeFakeScheduler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerHeartbeats(
      () => Promise.reject(new Error("async boom")),
      {
        scheduler: fake,
        readActiveMissionIds: () => ["m-1"],
        readMissionStatus: () => "active",
      },
    );

    fake.tickAll();
    // Drain the microtask the .catch hook lives on.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it("unregisterAllHeartbeats stops every handle and clears the map", () => {
    const fake = makeFakeScheduler();
    registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1", "m-2", "m-3"],
      readMissionStatus: () => "active",
    });
    unregisterAllHeartbeats();
    expect(__getHeartbeatMissionIds()).toEqual([]);
    for (const j of fake.jobs) expect(j.stopped).toBe(true);
  });

  it("registerHeartbeats with NO active missions installs nothing (boot on empty workspace)", () => {
    const fake = makeFakeScheduler();
    const result = registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => [],
      readMissionStatus: () => "active",
    });
    expect(result.registered).toEqual([]);
    expect(fake.jobs).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────
  // default scheduler / readMissionStatus throw / readActiveMissionIds throw
  //
  // The cases above all inject scheduler+reader deps. The branches below
  // exercise the defaults: a real `node-cron` install (line 75-83) plus
  // the catch paths around readMissionStatus (lines 173-177) and
  // readActiveMissionIds (line 280) so the supervisor isn't left without
  // any heartbeat dispatcher when SQLite blips on boot.
  // ───────────────────────────────────────────────────────────────────

  it("default node-cron scheduler installs and stops without throwing", () => {
    // Omit `scheduler` → defaults to the wrapped `node-cron` impl. The
    // 15-minute expression is valid, so schedule() must succeed; we then
    // immediately tear it down so the cron handle doesn't outlive the
    // test process.
    const result = registerHeartbeats(() => undefined, {
      readActiveMissionIds: () => ["m-default"],
      readMissionStatus: () => "active",
    });
    expect(result.registered).toEqual(["m-default"]);
    expect(__getHeartbeatMissionIds()).toEqual(["m-default"]);
    expect(unregisterHeartbeat("m-default")).toBe(true);
  });

  it("readMissionStatus throw is logged and the tick is dropped (does not invoke callback)", () => {
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerHeartbeats(
      (id) => {
        calls.push(id);
      },
      {
        scheduler: fake,
        readActiveMissionIds: () => ["m-1"],
        readMissionStatus: () => {
          throw new Error("transient sqlite failure");
        },
      },
    );

    fake.tickAll();
    expect(calls).toEqual([]); // callback NOT invoked
    expect(warn).toHaveBeenCalled();
    // Handle is still installed — a subsequent tick with a working
    // status reader could still fire. The current tick is a no-op only.
    expect(__getHeartbeatMissionIds()).toEqual(["m-1"]);
  });

  it("readActiveMissionIds throw on boot is logged and yields no registrations", () => {
    const fake = makeFakeScheduler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => {
        throw new Error("DB not ready yet");
      },
      readMissionStatus: () => "active",
    });

    expect(result.registered).toEqual([]);
    expect(result.alreadyActive).toEqual([]);
    expect(fake.jobs).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("registerHeartbeats called twice doesn't double-schedule already-active missions", () => {
    const fake = makeFakeScheduler();
    registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1", "m-2"],
      readMissionStatus: () => "active",
    });
    expect(fake.jobs).toHaveLength(2);

    // Second registerHeartbeats — same active set. Production wiring
    // would never call this twice in normal operation, but tsx watch
    // HMR does. Idempotency is the contract.
    const result = registerHeartbeats(() => undefined, {
      scheduler: fake,
      readActiveMissionIds: () => ["m-1", "m-2"],
      readMissionStatus: () => "active",
    });
    expect(result.registered).toEqual([]);
    expect(result.alreadyActive).toEqual(["m-1", "m-2"]);
    expect(fake.jobs).toHaveLength(2); // still 2, not 4
  });
});
