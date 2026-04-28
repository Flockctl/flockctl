// Mission event subscriber — wires `taskTerminalEvents` (auto-executor) to
// SupervisorService.evaluate. Covers the slice 11/03 contract:
//
//   • a terminal event for a task whose milestone has `mission_id` triggers
//     SupervisorService.evaluate(missionId, trigger)
//   • orphan tasks (no owning mission) are ignored — evaluate is NOT called
//   • paused / completed / aborted missions are ignored
//   • per-mission coalescing — multiple events arriving while one evaluate
//     is in flight collapse to a single pending slot (last-write-wins)
//   • 1000-event burst doesn't grow the queue map (bounded memory)
//
// Tests inject `resolveMissionForTask` + `readActiveMission` so we don't
// need to spin the full plan-store filesystem layer here — those resolvers
// are unit-tested independently in plan-store-mission-id.test.ts. This
// file pins the SUBSCRIBER's behavior, not the resolvers'.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import {
  taskTerminalEvents,
  type TaskTerminalEvent,
} from "../../services/auto-executor.js";
import {
  __getMissionQueueState,
  __resetSubscriber,
  subscribeMissionEvents,
} from "../../services/missions/event-subscriber.js";
import type { MissionTrigger } from "../../services/missions/max-depth-guard.js";
import type {
  GuardedEvaluateResult,
  SupervisorService,
} from "../../services/missions/supervisor.js";
import {
  createMilestone,
  createSlice,
  createPlanTask,
} from "../../services/plan-store/index.js";

// ─────────────────────────────────────────────────────────────────────
// Test fakes
// ─────────────────────────────────────────────────────────────────────

interface SupervisorCall {
  missionId: string;
  trigger: MissionTrigger;
}

/**
 * Drop-in stand-in for SupervisorService. Records every evaluate() call
 * and lets the test control how long evaluate() takes (via `gate`) so
 * we can assert coalescing while a previous call is still in flight.
 */
function makeFakeSupervisor(): {
  svc: SupervisorService;
  calls: SupervisorCall[];
  /** Promise the next evaluate() will await before resolving. Replace
   *  per-test to drive multi-step coalescing scenarios. */
  setGate: (gate: Promise<void>) => void;
  /** Force the next evaluate() to throw — used to verify the subscriber
   *  swallows the error and keeps processing the queue. */
  setError: (err: Error | null) => void;
} {
  const calls: SupervisorCall[] = [];
  let gate: Promise<void> = Promise.resolve();
  let error: Error | null = null;
  const fake = {
    setGate(g: Promise<void>) {
      gate = g;
    },
    setError(err: Error | null) {
      error = err;
    },
    calls,
    svc: {
      async evaluate(
        missionId: string,
        trigger: MissionTrigger,
      ): Promise<GuardedEvaluateResult> {
        calls.push({ missionId, trigger });
        await gate;
        if (error) {
          const e = error;
          error = null;
          throw e;
        }
        // Shape mirrors the `allowed: true` branch SupervisorService
        // returns on the success path; the subscriber discards the
        // payload but the type must satisfy the interface.
        return {
          allowed: true,
          depth: 0,
          proposal: undefined,
          cost: { tokens: 0, cents: 0 },
          budget: {
            allowed: true,
            remaining: { tokens: 0, cents: 0 },
            warn: false,
          } as never,
          eventKind: "task_observed",
          eventId: "evt-fake",
        } as GuardedEvaluateResult;
      },
    } as unknown as SupervisorService,
  };
  return fake;
}

/**
 * Lightweight controlled promise — flush() resolves the gate so the
 * fake supervisor's in-flight evaluate() can complete. Pattern lifted
 * from the agent-session tests.
 */
function makeGate(): { promise: Promise<void>; flush: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((res) => {
    resolveFn = res;
  });
  return { promise, flush: resolveFn };
}

/** Fire a terminal event and wait a microtask so the listener runs. */
async function fireEvent(event: TaskTerminalEvent): Promise<void> {
  taskTerminalEvents.emit(event);
  await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetSubscriber();
  taskTerminalEvents.removeAllListeners();
});

afterEach(() => {
  __resetSubscriber();
  taskTerminalEvents.removeAllListeners();
});

// ─────────────────────────────────────────────────────────────────────
// missions_event_subscriber — wiring + filtering + coalescing
// ─────────────────────────────────────────────────────────────────────

describe("missions_event_subscriber", () => {
  // ───────────────────────────────────────────────────────────────────
  // terminal_event_triggers_supervisor_evaluate
  // ───────────────────────────────────────────────────────────────────
  //
  // Happy path: an event for a task whose milestone has mission_id and
  // whose mission is `active` lands at SupervisorService.evaluate with
  // a `task_observed` trigger and the right payload.
  it("terminal_event_triggers_supervisor_evaluate", async () => {
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: (taskId) => (taskId === 42 ? "m-active" : null),
      readActiveMission: (id) =>
        id === "m-active" ? { id: "m-active", status: "active" } : null,
    });

    await fireEvent({
      taskId: 42,
      status: "done",
      error: undefined,
    });
    // Wait for the evaluate() microtask chain to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].missionId).toBe("m-active");
    expect(fake.calls[0].trigger.kind).toBe("task_observed");
    expect(fake.calls[0].trigger.payload?.task_id).toBe(42);
    expect(fake.calls[0].trigger.payload?.status).toBe("done");
  });

  // Orphan task: resolveMissionForTask returns null → evaluate is NOT
  // called. Common case for ad-hoc tasks unrelated to any plan.
  it("orphan_task_without_mission_is_ignored", async () => {
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => null, // every task is an orphan
      readActiveMission: () => null,
    });

    await fireEvent({ taskId: 99, status: "failed", error: "boom" });
    await Promise.resolve();

    expect(fake.calls).toHaveLength(0);
    expect(__getMissionQueueState("m-active").hasRunning).toBe(false);
  });

  // Mission resolves but is paused / completed / aborted → skip without
  // hitting the supervisor. The `readActiveMission` dependency returns
  // null for any non-active status (its production implementation
  // filters on `ACTIVE_MISSION_STATUSES`); the subscriber's branch is
  // "row null → drop the event".
  it("paused_mission_skips_supervisor_evaluate", async () => {
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-paused",
      // Production resolver would return null for `status='paused'`.
      readActiveMission: () => null,
    });

    await fireEvent({ taskId: 1, status: "failed", error: "boom" });
    await Promise.resolve();

    expect(fake.calls).toHaveLength(0);
  });

  // Coalescing: while one evaluate() is in flight, multiple events
  // arrive — the supervisor sees ONE running call, ONE pending replay
  // (last-write-wins), regardless of how many events were emitted.
  it("coalesces_events_while_evaluate_in_flight_one_pending_slot", async () => {
    const fake = makeFakeSupervisor();
    const gate = makeGate();
    fake.setGate(gate.promise);

    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-active",
      readActiveMission: () => ({ id: "m-active", status: "active" }),
    });

    // First event starts a run; the gate keeps it suspended.
    await fireEvent({ taskId: 1, status: "done" });
    expect(fake.calls).toHaveLength(1);
    expect(__getMissionQueueState("m-active")).toEqual({
      hasRunning: true,
      hasPending: false,
    });

    // Three more events arrive while the run is suspended. They MUST
    // collapse to a single pending slot — not three queued runs.
    await fireEvent({ taskId: 2, status: "done" });
    await fireEvent({ taskId: 3, status: "done" });
    await fireEvent({ taskId: 4, status: "failed", error: "x" });
    expect(fake.calls).toHaveLength(1); // still only the first run
    expect(__getMissionQueueState("m-active")).toEqual({
      hasRunning: true,
      hasPending: true,
    });

    // Release the gate; the pending slot must run exactly ONCE with the
    // freshest trigger (taskId 4 — last write wins).
    fake.setGate(Promise.resolve());
    gate.flush();
    // Drain microtasks: finally(), promote pending, run evaluate(),
    // then queue cleanup.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].trigger.payload?.task_id).toBe(4);
    expect(fake.calls[1].trigger.payload?.status).toBe("failed");
    // Queue map drained — no idle entries left.
    expect(__getMissionQueueState("m-active")).toEqual({
      hasRunning: false,
      hasPending: false,
    });
  });

  // 1000-event burst for the same mission: queue map stays bounded
  // (one running + one pending) — never grows linearly with the burst.
  it("burst_of_1000_events_does_not_grow_queue_map", async () => {
    const fake = makeFakeSupervisor();
    const gate = makeGate();
    fake.setGate(gate.promise);

    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-active",
      readActiveMission: () => ({ id: "m-active", status: "active" }),
    });

    for (let i = 0; i < 1000; i += 1) {
      taskTerminalEvents.emit({ taskId: i, status: "done" });
    }
    await Promise.resolve();

    // ONE in-flight call; the other 999 collapsed into the pending slot.
    expect(fake.calls).toHaveLength(1);
    expect(__getMissionQueueState("m-active")).toEqual({
      hasRunning: true,
      hasPending: true,
    });

    // Drain.
    fake.setGate(Promise.resolve());
    gate.flush();
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    // Exactly two evaluate() calls total — the original + the coalesced
    // pending. Not 1000.
    expect(fake.calls.length).toBeLessThanOrEqual(2);
  });

  // Subscriber is idempotent: a second subscribe() call doesn't double-
  // wire the listener (each event would otherwise produce two evaluates).
  it("subscribe_is_idempotent_no_double_listener", async () => {
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-active",
      readActiveMission: () => ({ id: "m-active", status: "active" }),
    });
    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-active",
      readActiveMission: () => ({ id: "m-active", status: "active" }),
    });

    await fireEvent({ taskId: 1, status: "done" });
    await Promise.resolve();
    expect(fake.calls).toHaveLength(1);
  });

  // Supervisor throw must not poison the queue. Next event for the same
  // mission still drives a fresh evaluate() — the subscriber logs and
  // recovers.
  it("supervisor_throw_is_swallowed_and_does_not_poison_queue", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFakeSupervisor();
    fake.setError(new Error("provider blip"));

    subscribeMissionEvents(fake.svc, {
      resolveMissionForTask: () => "m-active",
      readActiveMission: () => ({ id: "m-active", status: "active" }),
    });

    await fireEvent({ taskId: 1, status: "failed", error: "x" });
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(fake.calls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();

    // Subsequent event for the same mission still routes — the failure
    // didn't stick.
    await fireEvent({ taskId: 2, status: "done" });
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(fake.calls).toHaveLength(2);

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Default resolver coverage — exercises the production code paths that
// the dependency-injected tests above bypass:
//
//   • `readActiveMission`        (lines 101-109) — real `missions` row
//   • `resolveMissionForTask`    (lines 128-176) — real plan-store walk
//
// We spin up an in-memory SQLite handle, install it via `setDb`, and seed
// a project + plan-store milestone/slice/task chain on the filesystem.
// Then we call `subscribeMissionEvents(svc)` WITHOUT injected deps so the
// listener walks the real defaults.
// ─────────────────────────────────────────────────────────────────────

describe("missions_event_subscriber default resolvers", () => {
  let dbHandle: ReturnType<typeof createTestDb>;
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let projectDir: string;

  beforeAll(() => {
    dbHandle = createTestDb();
    sqlite = dbHandle.sqlite;
    setDb(dbHandle.db, sqlite);
    // missions table isn't in the shared helper DDL — add it inline.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    __resetSubscriber();
    taskTerminalEvents.removeAllListeners();
    sqlite.exec("DELETE FROM missions;");
    sqlite.exec("DELETE FROM projects;");
    sqlite.exec("DELETE FROM workspaces;");

    // Fresh project directory + plan store for each test.
    projectDir = mkdtempSync(join(tmpdir(), "missions-event-subscriber-"));
    sqlite
      .prepare("INSERT INTO workspaces (id, name, path) VALUES (1, 'ws', ?)")
      .run(projectDir);
    sqlite
      .prepare(
        "INSERT INTO projects (id, workspace_id, name, path) VALUES (1, 1, 'p', ?)",
      )
      .run(projectDir);
  });

  afterEach(() => {
    __resetSubscriber();
    taskTerminalEvents.removeAllListeners();
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Hits the happy path of BOTH default resolvers in one shot:
  //   - resolveMissionForTask walks project → milestone → slice → task,
  //     finds executionTaskId match, returns the milestone's missionId
  //     (lines 128-176)
  //   - readActiveMission selects status='active' from the real table
  //     (lines 101-109)
  it("default_resolvers_route_terminal_event_when_plan_task_matches", async () => {
    const missionId = "abcdef01";
    sqlite
      .prepare(
        "INSERT INTO missions (id, project_id, objective, status) VALUES (?, 1, 'obj', 'active')",
      )
      .run(missionId);

    const milestone = createMilestone(projectDir, {
      title: "M1",
      missionId,
    });
    const slice = createSlice(projectDir, milestone.slug, { title: "S1" });
    createPlanTask(projectDir, milestone.slug, slice.slug, {
      title: "T1",
      executionTaskId: 4242,
    });

    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc); // NO deps → real defaults

    await fireEvent({ taskId: 4242, status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].missionId).toBe(missionId);
    expect(fake.calls[0].trigger.payload?.task_id).toBe(4242);
  });

  // resolveMissionForTask returns null when no plan task matches the
  // execution task id — the for-loops exhaust without a return,
  // exercising the trailing `return null` (line 176).
  it("default_resolveMissionForTask_returns_null_for_orphan_task", async () => {
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc); // real defaults

    // No plan store seeded → orphan task. Must NOT call evaluate.
    await fireEvent({ taskId: 9999, status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.calls).toHaveLength(0);
  });

  // Skips the slice/task walk when a milestone has no missionId —
  // exercises the `if (!m.missionId) continue` cheap pre-filter
  // (line 154).
  it("default_resolveMissionForTask_skips_milestones_without_missionId", async () => {
    const milestone = createMilestone(projectDir, { title: "M-no-mission" });
    const slice = createSlice(projectDir, milestone.slug, { title: "S1" });
    createPlanTask(projectDir, milestone.slug, slice.slug, {
      title: "T1",
      executionTaskId: 1,
    });

    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc); // real defaults

    await fireEvent({ taskId: 1, status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.calls).toHaveLength(0);
  });

  // Project rows whose `path` is null are skipped — exercises the
  // `if (!project.path) continue` defense (line 143).
  it("default_resolveMissionForTask_skips_project_rows_without_path", async () => {
    sqlite.prepare("UPDATE projects SET path = NULL WHERE id = 1").run();
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc);

    await fireEvent({ taskId: 1, status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.calls).toHaveLength(0);
  });

  // Hits readActiveMission's `row not found` branch (line 106 — the
  // missions table has no row for the resolved id).
  it("default_readActiveMission_returns_null_for_missing_row", async () => {
    const missionId = "deadbeef";
    // Deliberately do NOT INSERT into missions — the row is missing.
    const milestone = createMilestone(projectDir, {
      title: "M1",
      missionId,
    });
    const slice = createSlice(projectDir, milestone.slug, { title: "S1" });
    createPlanTask(projectDir, milestone.slug, slice.slug, {
      title: "T1",
      executionTaskId: 7,
    });

    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc); // real defaults

    await fireEvent({ taskId: 7, status: "done" });
    await Promise.resolve();
    await Promise.resolve();

    // resolveMissionForTask returns the id, but readActiveMission's
    // SELECT finds no row → null → drop the event.
    expect(fake.calls).toHaveLength(0);
  });

  // Hits readActiveMission's "status not active" branch (line 107).
  it("default_readActiveMission_returns_null_for_paused_status", async () => {
    const missionId = "12345678";
    sqlite
      .prepare(
        "INSERT INTO missions (id, project_id, objective, status) VALUES (?, 1, 'obj', 'paused')",
      )
      .run(missionId);
    const milestone = createMilestone(projectDir, {
      title: "M1",
      missionId,
    });
    const slice = createSlice(projectDir, milestone.slug, { title: "S1" });
    createPlanTask(projectDir, milestone.slug, slice.slug, {
      title: "T1",
      executionTaskId: 8,
    });

    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc); // real defaults

    await fireEvent({ taskId: 8, status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.calls).toHaveLength(0);
  });

  // listMilestones throw is caught per-iteration (lines 147-148).
  // Easiest reachable case: project.path points to a nonexistent
  // directory — listMilestones throws ENOENT on the readdir, the
  // resolver moves to the next project (or exhausts to null).
  it("default_resolveMissionForTask_swallows_listMilestones_throw", async () => {
    sqlite
      .prepare("UPDATE projects SET path = ? WHERE id = 1")
      .run("/this/path/does/not/exist/at/all");
    const fake = makeFakeSupervisor();
    subscribeMissionEvents(fake.svc);

    await fireEvent({ taskId: 1, status: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.calls).toHaveLength(0);
  });
});
