// Bulk-cancel cross-tenant safety
//
// There is no `/tasks:bulk-cancel` endpoint — by design. The UI implements
// "cancel selected" as `Promise.allSettled(ids.map(id => POST /tasks/:id/cancel))`
// and the backend keeps the per-task transition guard as the single source of
// truth. This test pins that contract:
//
//   1. Each per-task POST is authorised on its own (status guard, NotFound,
//      Zod). A 404 / 400 in one parallel slot must not poison its siblings.
//   2. A bulk fired across project boundaries does not leak cancellations to
//      tasks the caller didn't list — a request for tasks in project A must
//      never side-effect tasks in project B even when fired concurrently.
//   3. Tasks in a non-cancellable terminal state (e.g. `done`) reject with
//      422 (ValidationError → unprocessable entity) without flipping any
//      other row.
//
// Pattern mirrors `tasks.test.ts` (in-memory DB via createTestDb, executor
// stubbed so we exercise the route + transition validator only).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb, seedProject } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { tasks as tasksTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// Neuter side effects: `cancel()` would tear down a real scheduler entry, and
// `execute()` would try to spawn Claude Code. We only want to verify the route
// transition / 404 / no-cross-talk semantics.
vi.spyOn(taskExecutor, "execute").mockImplementation(async () => {});
const cancelSpy = vi.spyOn(taskExecutor, "cancel").mockReturnValue(true);

describe("POST /tasks/:id/cancel — bulk cross-tenant safety (parallel per-task)", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });
  afterAll(() => testDb.sqlite.close());

  beforeEach(() => {
    cancelSpy.mockClear();
  });

  function insertTask(opts: { projectId?: number | null; status?: string; label?: string } = {}): number {
    const row = testDb.db.insert(tasksTable).values({
      prompt: "bulk-cancel-fixture",
      projectId: opts.projectId ?? null,
      status: opts.status ?? "running",
      label: opts.label ?? null,
    }).returning().get();
    return row!.id;
  }

  function statusOf(id: number): string | undefined {
    return testDb.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get()?.status ?? undefined;
  }

  async function cancel(id: number | string): Promise<Response> {
    return app.request(`/tasks/${id}/cancel`, { method: "POST" });
  }

  it("parallel cancels target only the listed task IDs — sibling tasks (same and different project) are untouched", async () => {
    const projA = seedProject(testDb.sqlite, { name: `A-${Date.now()}` });
    const projB = seedProject(testDb.sqlite, { name: `B-${Date.now()}` });

    // Targets — what the caller asked to cancel.
    const targetA1 = insertTask({ projectId: projA, status: "running", label: "A-target-1" });
    const targetA2 = insertTask({ projectId: projA, status: "queued",  label: "A-target-2" });
    const targetA3 = insertTask({ projectId: projA, status: "waiting_for_input", label: "A-target-3" });

    // Bystanders — must NOT be affected by a parallel batch that doesn't list
    // them. Includes a same-project sibling and an unrelated-project task.
    const bystanderA = insertTask({ projectId: projA, status: "running", label: "A-bystander" });
    const bystanderB1 = insertTask({ projectId: projB, status: "running", label: "B-bystander-1" });
    const bystanderB2 = insertTask({ projectId: projB, status: "queued",  label: "B-bystander-2" });
    const orphan = insertTask({ projectId: null, status: "running", label: "orphan" });

    // Fire the targets in parallel — this is what the UI's
    // `Promise.allSettled(ids.map(POST /tasks/:id/cancel))` does.
    const results = await Promise.all([
      cancel(targetA1),
      cancel(targetA2),
      cancel(targetA3),
    ]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    for (const r of results) {
      const body = await r.json();
      expect(body.status).toBe("cancelled");
    }

    // Targets flipped.
    expect(statusOf(targetA1)).toBe("cancelled");
    expect(statusOf(targetA2)).toBe("cancelled");
    expect(statusOf(targetA3)).toBe("cancelled");

    // Bystanders (same project, other project, no project) untouched.
    expect(statusOf(bystanderA)).toBe("running");
    expect(statusOf(bystanderB1)).toBe("running");
    expect(statusOf(bystanderB2)).toBe("queued");
    expect(statusOf(orphan)).toBe("running");

    // Executor.cancel() called exactly once per listed id and never with a
    // bystander id — proves the route does not iterate beyond `:id`.
    const calledIds = cancelSpy.mock.calls.map(args => args[0]);
    expect(new Set(calledIds)).toEqual(new Set([targetA1, targetA2, targetA3]));
    expect(calledIds).not.toContain(bystanderA);
    expect(calledIds).not.toContain(bystanderB1);
    expect(calledIds).not.toContain(bystanderB2);
    expect(calledIds).not.toContain(orphan);
  });

  it("a 404 in one parallel slot does not poison sibling cancels", async () => {
    const proj = seedProject(testDb.sqlite, { name: `P404-${Date.now()}` });
    const live1 = insertTask({ projectId: proj, status: "running" });
    const live2 = insertTask({ projectId: proj, status: "running" });
    const ghostId = 9_000_001; // not in DB

    const [r1, rGhost, r2] = await Promise.all([
      cancel(live1),
      cancel(ghostId),
      cancel(live2),
    ]);

    expect(r1.status).toBe(200);
    expect(rGhost.status).toBe(404);
    expect(r2.status).toBe(200);

    expect(statusOf(live1)).toBe("cancelled");
    expect(statusOf(live2)).toBe("cancelled");
    // The ghost id never had a row to begin with.
    expect(statusOf(ghostId)).toBeUndefined();
  });

  it("a 422 (uncancellable status) in one parallel slot does not poison sibling cancels", async () => {
    const proj = seedProject(testDb.sqlite, { name: `P400-${Date.now()}` });
    const live = insertTask({ projectId: proj, status: "running" });
    // `done` has no outbound transitions per TASK_STATUS_TRANSITIONS — cancel
    // must reject with 422 (ValidationError) and leave the row alone.
    const finished = insertTask({ projectId: proj, status: "done" });
    const liveAlso = insertTask({ projectId: proj, status: "queued" });

    const [r1, rDone, r2] = await Promise.all([
      cancel(live),
      cancel(finished),
      cancel(liveAlso),
    ]);

    expect(r1.status).toBe(200);
    expect(rDone.status).toBe(422);
    expect(r2.status).toBe(200);

    expect(statusOf(live)).toBe("cancelled");
    expect(statusOf(liveAlso)).toBe("cancelled");
    // `done` task left untouched — no accidental flip to `cancelled`.
    expect(statusOf(finished)).toBe("done");
  });

  it("rejects negative / non-integer ids per slot without disturbing sibling cancels", async () => {
    const proj = seedProject(testDb.sqlite, { name: `Pbad-${Date.now()}` });
    const live = insertTask({ projectId: proj, status: "running" });

    const [rGood, rNegative, rWord] = await Promise.all([
      cancel(live),
      cancel(-7),
      cancel("not-a-number"),
    ]);

    expect(rGood.status).toBe(200);
    expect(rNegative.status).toBeGreaterThanOrEqual(400);
    expect(rNegative.status).toBeLessThan(500);
    expect(rWord.status).toBeGreaterThanOrEqual(400);
    expect(rWord.status).toBeLessThan(500);

    expect(statusOf(live)).toBe("cancelled");
  });

  it("idempotent under double-fire — second cancel of an already-cancelled id returns 422, original cancel sticks", async () => {
    const proj = seedProject(testDb.sqlite, { name: `Pdup-${Date.now()}` });
    const id = insertTask({ projectId: proj, status: "running" });

    const r1 = await cancel(id);
    expect(r1.status).toBe(200);
    expect(statusOf(id)).toBe("cancelled");

    // Cancelling again — `cancelled` has only `[queued]` outbound, so a
    // second cancel attempt fails the transition guard with 422 instead of
    // silently no-op'ing or, worse, cascading into a different row.
    const r2 = await cancel(id);
    expect(r2.status).toBe(422);
    expect(statusOf(id)).toBe("cancelled");
  });

  it("interleaved cross-project parallel batch — each row's status decision is independent", async () => {
    const projA = seedProject(testDb.sqlite, { name: `iA-${Date.now()}` });
    const projB = seedProject(testDb.sqlite, { name: `iB-${Date.now()}` });

    // 6 tasks, alternating projects and statuses, fired at the same time.
    const a1 = insertTask({ projectId: projA, status: "running" });
    const b1 = insertTask({ projectId: projB, status: "running" });
    const a2 = insertTask({ projectId: projA, status: "done" });        // → 422
    const b2 = insertTask({ projectId: projB, status: "queued" });
    const a3 = insertTask({ projectId: projA, status: "waiting_for_input" });
    const b3 = insertTask({ projectId: projB, status: "done" });        // → 422

    const responses = await Promise.all([cancel(a1), cancel(b1), cancel(a2), cancel(b2), cancel(a3), cancel(b3)]);
    const codes = responses.map(r => r.status);
    expect(codes).toEqual([200, 200, 422, 200, 200, 422]);

    // Per-id outcomes — exactly the rows that returned 200 flipped, no others.
    expect(statusOf(a1)).toBe("cancelled");
    expect(statusOf(b1)).toBe("cancelled");
    expect(statusOf(a2)).toBe("done");
    expect(statusOf(b2)).toBe("cancelled");
    expect(statusOf(a3)).toBe("cancelled");
    expect(statusOf(b3)).toBe("done");

    // Executor.cancel() invoked only for the four 200 slots.
    const calledIds = new Set(cancelSpy.mock.calls.map(args => args[0]));
    expect(calledIds).toEqual(new Set([a1, b1, b2, a3]));
  });
});
