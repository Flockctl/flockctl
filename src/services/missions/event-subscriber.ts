// ─── Mission event subscriber ───
//
// At boot, the daemon calls `subscribeMissionEvents(svc)` ONCE to wire the
// auto-executor's task-terminal channel to the SupervisorService:
//
//     auto-executor                event-subscriber              SupervisorService
//     -------------                ---------------               -----------------
//     taskTerminalEvents.emit ──▶  on(event)                ──▶  evaluate(missionId, trigger)
//                                  │  resolve task → mission
//                                  │  coalesce per-mission
//
// Why a dedicated subscriber instead of calling SupervisorService.evaluate()
// from the auto-executor directly?
//
//   1. Decoupling. The auto-executor is the "make tasks run" engine; the
//      missions tier is the "decide what to do next" engine. Wiring them via
//      an EventEmitter keeps the auto-executor mission-agnostic — it doesn't
//      import anything from src/services/missions/ — so the executor remains
//      buildable without the supervisor stack and tests can run either side
//      in isolation.
//
//   2. Coalescing. Multiple terminal events may fire for the same mission
//      back-to-back (a slice of N tasks all completing). Funneling them
//      through a per-mission queue here lets us serialize the supervisor
//      calls — the LLM round-trip is expensive and parallel calls would
//      double-charge the budget AND race on `mission_events` writes — and
//      collapse a backlog to ONE pending evaluation, so a 1000-event burst
//      can't grow this queue without bound (parent slice 03 corner case:
//      "1000-event burst no OOM").
//
//   3. Orphan filtering. Most workspaces will have tasks that don't belong
//      to any mission. Resolving task → milestone → mission_id here means
//      the SupervisorService never sees a "non-mission task" event — a
//      defensive boundary that keeps the supervisor's surface narrow.
//
// Coalescing semantics (slice 03 §"heartbeat fires while previous evaluate
// still running: coalesced (one at a time per mission)"):
//
//   For each mission we keep at most TWO trigger references:
//     - `running`  — the trigger currently being evaluated (in-flight)
//     - `pending`  — the SINGLE next trigger to evaluate when `running`
//                    resolves. New triggers arriving while `running` is
//                    in-flight REPLACE the pending slot (last-write-wins),
//                    so a 1000-event burst for one mission collapses to
//                    {running, pending} — bounded memory regardless of
//                    burst size.
//
//   The latest event wins — that's intentional: the supervisor's job is to
//   look at the current state of the mission, not replay history. Older
//   events are subsumed (the mission_events timeline has the full record;
//   the supervisor just doesn't need to fan-call evaluate() for each one).
//
// What this file does NOT do:
//   - It does NOT mutate `mission_events`. SupervisorService + guardedEvaluate
//     own that table; the subscriber is a thin router.
//   - It does NOT broadcast over WebSocket. SupervisorService.evaluate
//     handles the `mission_event` WS envelope on the success branch.
//   - It does NOT throw. A throw on the EventEmitter callback path becomes
//     an `unhandledRejection` and crashes the daemon (server-entry installs
//     a hard exit on unhandled rejections). All errors are logged + swallowed.

import { getDb, getRawDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import {
  taskTerminalEvents,
  type TaskTerminalEvent,
} from "../auto-executor.js";
import {
  listMilestones,
  listSlices,
  listPlanTasks,
} from "../plan-store/index.js";
import type { MissionTrigger } from "./max-depth-guard.js";
import type { SupervisorService } from "./supervisor.js";

// ─── Internals ───

/** Per-mission coalescing state. */
interface MissionQueueState {
  /** Promise tracking the in-flight evaluate(); resolves when it finishes. */
  running: Promise<void>;
  /** Latest trigger queued behind `running`. `null` when nothing is pending. */
  pending: MissionTrigger | null;
}

/** Active-mission status set — anything else is ignored by the subscriber. */
const ACTIVE_MISSION_STATUSES = new Set(["active"]);

interface MissionRow {
  id: string;
  status: string;
}

/**
 * Look up a mission by id. Returns the row or null if the mission is
 * missing OR not in an active status. The subscriber treats both "not
 * found" and "paused/completed/aborted" the same way — drop the event —
 * so a paused mission stops attracting supervisor work without a
 * separate reachability check.
 */
function readActiveMission(missionId: string): MissionRow | null {
  const sqlite = getRawDb();
  const row = sqlite
    .prepare("SELECT id, status FROM missions WHERE id = ?")
    .get(missionId) as MissionRow | undefined;
  if (!row) return null;
  if (!ACTIVE_MISSION_STATUSES.has(row.status)) return null;
  return row;
}

/**
 * Resolve an execution-task id to its owning mission_id by walking the
 * filesystem-backed plan store: for every project that has a plan
 * directory, scan milestones → slices → tasks until a plan task whose
 * `executionTaskId` matches `taskId` is found. Then read `missionId`
 * from that task's milestone frontmatter.
 *
 * Returns `null` for "no owning mission" — either the task isn't tracked
 * by a plan (orphan task; the common case for ad-hoc work) or its
 * milestone has no `mission_id` frontmatter.
 *
 * Why we walk the plan store instead of joining a DB column: missions
 * link to milestones via a TEXT id that lives ONLY in the plan-file
 * frontmatter (see `src/services/plan-store/milestones.ts` and
 * migrations/0043_add_missions.sql §header). There's no SQL FK from
 * tasks to missions, by design — the plan files are the source of truth.
 */
function resolveMissionForTask(taskId: number): string | null {
  const db = getDb();
  // listMilestones / listSlices / listPlanTasks throw on missing dirs;
  // catch per-iteration so a half-imported project can't poison the
  // resolver for the rest of the workspace.
  let allProjects: Array<{ path: string | null }>;
  try {
    allProjects = db.select().from(projects).all();
  } catch (err) {
    /* v8 ignore next 3 — defensive: a fully torn-down DB is not reachable
       from the subscriber's hot path. */
    console.warn("[missions/event-subscriber] projects select failed:", err);
    return null;
  }
  for (const project of allProjects) {
    if (!project.path) continue;
    let milestones: ReturnType<typeof listMilestones>;
    try {
      milestones = listMilestones(project.path);
    } catch {
      continue;
    }
    for (const m of milestones) {
      // Cheap pre-filter: only walk slices for milestones that even have
      // a mission_id. Skips projects with hundreds of milestones but no
      // missions wired up.
      if (!m.missionId) continue;
      let slices: ReturnType<typeof listSlices>;
      try {
        slices = listSlices(project.path, m.slug);
      } catch {
        continue;
      }
      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try {
          planTasks = listPlanTasks(project.path, m.slug, s.slug);
        } catch {
          continue;
        }
        for (const pt of planTasks) {
          if (pt.executionTaskId === taskId) {
            return m.missionId;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Build the MissionTrigger envelope passed to SupervisorService.evaluate
 * from a task-terminal event. Trigger kind is always `task_observed`
 * here — the subscriber is the canonical source of "a downstream task
 * just finished" triggers; heartbeat / remediation triggers come from
 * other paths (scheduler, approval queue) and don't flow through this
 * subscriber.
 *
 * `task_output` is left as the empty string by default. The SupervisorService
 * accepts a missing/empty value and renders an empty fenced DATA block —
 * the executor doesn't capture a clean per-task transcript today, and
 * shipping the error_message verbatim is enough signal for the
 * supervisor to react. When richer task output becomes available, it
 * plugs in here without touching the SupervisorService boundary.
 */
function buildTrigger(event: TaskTerminalEvent): MissionTrigger {
  return {
    kind: "task_observed",
    payload: {
      task_id: event.taskId,
      status: event.status,
      ...(event.error !== undefined ? { task_output: event.error } : {}),
      ...(event.depth !== undefined ? { depth: event.depth } : {}),
    },
  };
}

// ─── Subscriber state ───

/** Per-mission queue state. Keyed by mission id. */
const queues = new Map<string, MissionQueueState>();

/** Currently-installed listener so unsubscribe() can detach exactly it. */
let installed: ((event: TaskTerminalEvent) => void) | null = null;

/**
 * Drive one trigger through the supervisor and, on completion, hand off
 * the next pending trigger (if any). Centralized so both the
 * "first-trigger-for-this-mission" path and the
 * "promote-pending-to-running" path share the same retry/error semantics.
 *
 * Errors are logged and swallowed: an LLM provider blip must NOT kill the
 * daemon's only mission listener. The mission timeline is the durable
 * source of truth; if a single evaluate() throws, the next event for the
 * same mission will start a fresh evaluate() against the same DB state.
 */
function runOne(
  svc: SupervisorService,
  missionId: string,
  trigger: MissionTrigger,
): Promise<void> {
  return svc
    .evaluate(missionId, trigger)
    .then(
      () => undefined,
      (err: unknown) => {
        console.warn(
          `[missions/event-subscriber] evaluate() failed for mission ${missionId}:`,
          err,
        );
      },
    )
    .finally(() => {
      const state = queues.get(missionId);
      /* v8 ignore next — state is always populated for the entry that
         owns this finally(); we set it before the await chain. */
      if (!state) return;
      const next = state.pending;
      if (next === null) {
        // Drain complete — drop the queue entry so memory stays bounded.
        queues.delete(missionId);
        return;
      }
      state.pending = null;
      state.running = runOne(svc, missionId, next);
    });
}

/**
 * Enqueue a trigger for a mission. If nothing is in-flight for the
 * mission, start a fresh run; otherwise, REPLACE the pending slot
 * (last-write-wins). See §"Coalescing semantics" in the file header.
 */
function enqueue(
  svc: SupervisorService,
  missionId: string,
  trigger: MissionTrigger,
): void {
  const existing = queues.get(missionId);
  if (!existing) {
    const state: MissionQueueState = {
      running: Promise.resolve(),
      pending: null,
    };
    queues.set(missionId, state);
    state.running = runOne(svc, missionId, trigger);
    return;
  }
  // Already running for this mission — replace the pending slot. The
  // older pending trigger is dropped on purpose: the supervisor reads
  // current mission state, so the freshest trigger subsumes the older
  // one.
  existing.pending = trigger;
}

// ─── Public API ───

/** Optional override for tests — they don't have full DB-backed task
 *  records, so they swap in a stub resolver via `subscribeMissionEvents
 *  ({ resolveMissionForTask: ... })`. */
export interface MissionEventSubscriberDeps {
  /**
   * Look up the mission_id for a given execution task. Defaults to
   * `resolveMissionForTask` (DB + plan store walk).
   */
  resolveMissionForTask?: (taskId: number) => string | null;
  /**
   * Look up an active mission row by id. Defaults to `readActiveMission`
   * (`SELECT id, status FROM missions`). Tests inject in-memory fakes here
   * to avoid spinning up the full schema.
   */
  readActiveMission?: (missionId: string) => MissionRow | null;
}

/**
 * Subscribe ONCE to `taskTerminalEvents` and route eligible events to
 * the supervisor. Idempotent: a second call with the listener still
 * attached is a no-op (returns the same unsubscribe function).
 *
 * Returns an `unsubscribe()` callback the caller (boot path / tests)
 * can use to detach the listener AND drop the per-mission queue map,
 * for clean teardown.
 */
export function subscribeMissionEvents(
  svc: SupervisorService,
  deps: MissionEventSubscriberDeps = {},
): () => void {
  const resolve = deps.resolveMissionForTask ?? resolveMissionForTask;
  const readMission = deps.readActiveMission ?? readActiveMission;

  // Idempotent install: if a listener is already wired, hand back its
  // unsubscriber. Keeps the subscriber single-instance even if the boot
  // path is retried (e.g. tsx watch HMR re-running server-entry).
  if (installed) {
    const current = installed;
    return () => {
      taskTerminalEvents.off(current);
      installed = null;
      queues.clear();
    };
  }

  const listener = (event: TaskTerminalEvent): void => {
    let missionId: string | null;
    try {
      missionId = resolve(event.taskId);
    } catch (err) {
      /* v8 ignore next 5 — resolve() catches per-iteration internally;
         this top-level catch is defense-in-depth for an unexpected
         throw from the dependency override. */
      console.warn(
        `[missions/event-subscriber] resolveMissionForTask threw for task ${event.taskId}:`,
        err,
      );
      return;
    }
    if (!missionId) return; // orphan task — skip without log spam.

    let mission: MissionRow | null;
    try {
      mission = readMission(missionId);
    } catch (err) {
      /* v8 ignore next 5 — same defensive net as resolve(); the SQL
         here is a single SELECT against an indexed PK column. */
      console.warn(
        `[missions/event-subscriber] readActiveMission threw for mission ${missionId}:`,
        err,
      );
      return;
    }
    if (!mission) return; // mission deleted or not active — skip.

    enqueue(svc, missionId, buildTrigger(event));
  };

  taskTerminalEvents.on(listener);
  installed = listener;

  return () => {
    if (installed === listener) {
      taskTerminalEvents.off(listener);
      installed = null;
    }
    queues.clear();
  };
}

// ─── Test seams ───
//
// Exported ONLY so the unit tests can introspect coalescing behavior
// without poking at module internals via the runtime require cache.
// Production callers must NOT import these.

/** @internal — test-only view of the per-mission queue map. */
export function __getMissionQueueState(missionId: string): {
  hasRunning: boolean;
  hasPending: boolean;
} {
  const state = queues.get(missionId);
  return {
    hasRunning: !!state,
    hasPending: !!state?.pending,
  };
}

/** @internal — test-only forced reset between cases. */
export function __resetSubscriber(): void {
  if (installed) {
    taskTerminalEvents.off(installed);
    installed = null;
  }
  queues.clear();
}
