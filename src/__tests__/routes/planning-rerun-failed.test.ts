import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";

// We let the real auto-executor be imported so `repointPlanTask` runs end-to-end
// against the on-disk plan tree, but stub the executor's external surface so no
// subprocess is spawned and `startAutoExecution` is observable. `vi.hoisted` is
// the only safe way to share a spy with a `vi.mock` factory — bare top-level
// `const`s are unreachable from the hoisted factory body.
const { startAutoExecutionMock } = vi.hoisted(() => ({
  startAutoExecutionMock: vi.fn(async () => {}),
}));
vi.mock("../../services/auto-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/auto-executor.js")>(
    "../../services/auto-executor.js",
  );
  return {
    ...actual,
    startAutoExecution: startAutoExecutionMock,
  };
});

vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(),
    cancel: vi.fn(),
    getMetrics: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    resolvePermission: vi.fn(() => true),
    pendingPermissions: vi.fn(() => []),
  },
}));

import {
  createMilestone, createSlice, createPlanTask,
  listPlanTasks, listSlices, updatePlanTask,
} from "../../services/plan-store/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";

describe("POST /projects/:pid/milestones/:mslug/rerun-failed", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let projectPath: string;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
  });

  beforeEach(() => {
    if (projectPath) rmSync(projectPath, { recursive: true, force: true });
    testDb.sqlite.exec("DELETE FROM tasks; DELETE FROM projects;");
    projectPath = mkdtempSync(join(tmpdir(), "rerun-failed-"));
    const p = testDb.db
      .insert(projects)
      .values({ name: "Rerun Failed Project", path: projectPath })
      .returning()
      .get()!;
    projectId = p.id;
    startAutoExecutionMock.mockClear();
    (taskExecutor.execute as ReturnType<typeof vi.fn>).mockClear();
  });

  it("404 when milestone does not exist", async () => {
    const res = await app.request(`/projects/${projectId}/milestones/no-such/rerun-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns count=0 and resumed=false when nothing is failed", async () => {
    const m = createMilestone(projectPath, { title: "Clean" });
    const s = createSlice(projectPath, m.slug, { title: "s" });
    const pt = createPlanTask(projectPath, m.slug, s.slug, { title: "ok" });
    const exec = testDb.db.insert(tasks).values({ projectId, status: "done" } as any).returning().get()!;
    updatePlanTask(projectPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "completed" });

    const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/rerun-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rerun: [], count: 0, resumed: false });
    expect(taskExecutor.execute).not.toHaveBeenCalled();
    expect(startAutoExecutionMock).not.toHaveBeenCalled();
  });

  it("clones every failed plan-task into a child rerun task and re-points the plan", async () => {
    const m = createMilestone(projectPath, { title: "Has fails" });
    const s = createSlice(projectPath, m.slug, { title: "s1" });

    // Two failed plan tasks + one completed (control) + one failed-but-no-exec-id (skipped).
    const ptA = createPlanTask(projectPath, m.slug, s.slug, { title: "fail-a" });
    const ptB = createPlanTask(projectPath, m.slug, s.slug, { title: "fail-b" });
    const ptOk = createPlanTask(projectPath, m.slug, s.slug, { title: "ok" });
    const ptOrphan = createPlanTask(projectPath, m.slug, s.slug, { title: "orphan-fail" });

    const execA = testDb.db.insert(tasks).values({
      projectId, status: "failed", prompt: "P-A", agent: "claude_cli",
      label: "task-a", taskType: "execution",
    } as any).returning().get()!;
    const execB = testDb.db.insert(tasks).values({
      projectId, status: "timed_out", prompt: "P-B", agent: "claude_cli",
      taskType: "execution",
    } as any).returning().get()!;
    const execOk = testDb.db.insert(tasks).values({
      projectId, status: "done", prompt: "P-ok",
    } as any).returning().get()!;

    updatePlanTask(projectPath, m.slug, s.slug, ptA.slug, { executionTaskId: execA.id, status: "failed" });
    updatePlanTask(projectPath, m.slug, s.slug, ptB.slug, { executionTaskId: execB.id, status: "failed" });
    updatePlanTask(projectPath, m.slug, s.slug, ptOk.slug, { executionTaskId: execOk.id, status: "completed" });
    updatePlanTask(projectPath, m.slug, s.slug, ptOrphan.slug, { status: "failed" }); // no exec id

    const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/rerun-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.resumed).toBe(true);
    expect(body.rerun).toHaveLength(2);
    expect(body.rerun.map((r: { originalTaskId: number }) => r.originalTaskId).sort()).toEqual(
      [execA.id, execB.id].sort(),
    );

    // Each new task carries parentTaskId + clones key fields + label is rerun-prefixed.
    for (const { originalTaskId, newTaskId } of body.rerun) {
      const child = testDb.db.select().from(tasks).where(
        // eq() imported below
        (await import("drizzle-orm")).eq(tasks.id, newTaskId),
      ).get()!;
      expect(child.parentTaskId).toBe(originalTaskId);
      expect(child.label).toMatch(/^rerun-/);
      expect(child.prompt).toBeTruthy();
    }

    // Plan now points at the new exec ids and is back to "active".
    const refreshed = listPlanTasks(projectPath, m.slug, s.slug);
    const byTitle = Object.fromEntries(refreshed.map((p) => [p.title, p]));
    expect(byTitle["fail-a"].status).toBe("active");
    expect(byTitle["fail-b"].status).toBe("active");
    expect(byTitle["ok"].status).toBe("completed"); // untouched
    expect(byTitle["orphan-fail"].status).toBe("failed"); // untouched
    expect(byTitle["fail-a"].executionTaskId).not.toBe(execA.id);
    expect(byTitle["fail-b"].executionTaskId).not.toBe(execB.id);

    // Slice flipped out of "failed" because some tasks are active again.
    expect(listSlices(projectPath, m.slug)[0].status).toBe("active");

    expect(taskExecutor.execute).toHaveBeenCalledTimes(2);
    expect(startAutoExecutionMock).toHaveBeenCalledTimes(1);
    expect(startAutoExecutionMock).toHaveBeenCalledWith(projectId, projectPath, m.slug);
  });

  it("respects ?resume=false — re-queues tasks but does not restart the orchestrator", async () => {
    const m = createMilestone(projectPath, { title: "No resume" });
    const s = createSlice(projectPath, m.slug, { title: "s" });
    const pt = createPlanTask(projectPath, m.slug, s.slug, { title: "x" });
    const exec = testDb.db.insert(tasks).values({
      projectId, status: "failed", prompt: "p", taskType: "execution",
    } as any).returning().get()!;
    updatePlanTask(projectPath, m.slug, s.slug, pt.slug, { executionTaskId: exec.id, status: "failed" });

    const res = await app.request(
      `/projects/${projectId}/milestones/${m.slug}/rerun-failed?resume=false`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.resumed).toBe(false);
    expect(taskExecutor.execute).toHaveBeenCalledTimes(1);
    expect(startAutoExecutionMock).not.toHaveBeenCalled();
  });
});
