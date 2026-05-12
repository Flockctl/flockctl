// ─── scheduled wakeups: unit tests ───
//
// Pins the slice contract for `wakeup-service.ts` + `wakeup-worker.ts`:
//
//   • record() inserts a pending row, computing fire_at from
//     delaySeconds + now(); rejects neither/both/missing-fields cases.
//   • findDuePending() returns only pending rows whose fire_at <= now,
//     ascending by fire_at (drains backlog chronologically).
//   • markFired / cancel / markMissed are idempotent on non-pending
//     status — a double-tick or double-click cannot re-transition.
//   • sweepMissed() flips every overdue-past-grace pending row to
//     missed, in a single transaction, returning the affected ids.
//   • The worker tick:
//       - drops re-entrant ticks via the `ticking` flag,
//       - calls onMissed BEFORE the fire callback (so a long downtime
//         doesn't blast hours of stale wakeups through the resume path),
//       - leaves the row pending if the fire callback throws (next
//         tick retries — transient blip safety),
//       - invokes onFired with the post-update row.
//
// Tests use a synthesized in-memory DB via `createTestDb()` — same shape
// as the service hits in production but isolated per-case via `setDb()`.
// The worker is driven through `runWakeupTick()` directly so we avoid
// real wall-clock timer races.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import {
  cancel,
  findDuePending,
  getById,
  list,
  markFired,
  markMissed,
  record,
  sweepMissed,
  WAKEUP_FIRE_GRACE_SECONDS,
  type WakeupRow,
} from "../../services/wakeups/wakeup-service.js";
import {
  __resetWakeupWorker,
  runWakeupTick,
  startWakeupWorker,
} from "../../services/wakeups/wakeup-worker.js";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function seedChat(sqlite: ReturnType<typeof createTestDb>["sqlite"], claudeSessionId = "cs-test"): number {
  // Minimal chat row — only the columns scheduled_wakeups.chat_id FK
  // requires (chats.id NOT NULL).
  const res = sqlite
    .prepare(`INSERT INTO chats (claude_session_id) VALUES (?)`)
    .run(claudeSessionId);
  return Number(res.lastInsertRowid);
}

describe("wakeup-service", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];

  beforeEach(() => {
    const made = createTestDb();
    sqlite = made.sqlite;
    setDb(made.db, made.sqlite);
  });

  afterEach(() => {
    sqlite.close();
    __resetWakeupWorker();
  });

  it("record() inserts a pending row scoped to chatId with computed fire_at", () => {
    const chatId = seedChat(sqlite);
    const before = nowSec();

    const row = record({
      chatId,
      claudeSessionId: "cs-1",
      delaySeconds: 270,
      prompt: "checking SRPM build",
      reason: "build poll",
    });

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.chatId).toBe(chatId);
    expect(row.taskId).toBeNull();
    expect(row.status).toBe("pending");
    expect(row.fireAt).toBeGreaterThanOrEqual(before + 270);
    expect(row.fireAt).toBeLessThanOrEqual(before + 270 + 5);
    expect(row.prompt).toBe("checking SRPM build");
    expect(row.reason).toBe("build poll");
  });

  it("record() rejects neither/both/missing-prompt/missing-session inputs", () => {
    const chatId = seedChat(sqlite);

    expect(() =>
      record({
        claudeSessionId: "cs-1",
        delaySeconds: 60,
        prompt: "p",
      }),
    ).toThrow(/chatId OR taskId/i);

    expect(() =>
      record({
        chatId,
        taskId: 99,
        claudeSessionId: "cs-1",
        delaySeconds: 60,
        prompt: "p",
      }),
    ).toThrow(/XOR/i);

    expect(() =>
      record({
        chatId,
        claudeSessionId: "cs-1",
        delaySeconds: 60,
        prompt: "",
      }),
    ).toThrow(/prompt is required/);

    expect(() =>
      record({
        chatId,
        claudeSessionId: "",
        delaySeconds: 60,
        prompt: "p",
      }),
    ).toThrow(/claudeSessionId is required/);

    expect(() =>
      record({
        chatId,
        claudeSessionId: "cs-1",
        delaySeconds: -1,
        prompt: "p",
      }),
    ).toThrow(/delaySeconds/);
  });

  it("findDuePending() returns only due rows, ascending by fire_at", () => {
    const chatId = seedChat(sqlite);
    const a = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "now" });
    const b = record({ chatId, claudeSessionId: "cs", delaySeconds: 1000, prompt: "later" });
    // Force a's fire_at into the past and b's into the future explicitly so
    // the order assertion isn't sensitive to insertion timing.
    sqlite
      .prepare(`UPDATE scheduled_wakeups SET fire_at = ? WHERE id = ?`)
      .run(nowSec() - 10, a.id);

    const due = findDuePending(nowSec());
    expect(due.map((r) => r.id)).toEqual([a.id]);
    // b is in the future -> excluded
    expect(due.find((r) => r.id === b.id)).toBeUndefined();
  });

  it("markFired / cancel / markMissed are idempotent on non-pending", () => {
    const chatId = seedChat(sqlite);
    const row = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "go" });

    const fired = markFired(row.id);
    expect(fired?.status).toBe("fired");
    // Second markFired on a fired row is a no-op (status stays fired,
    // fired_at unchanged-ish) — we just assert the row wasn't reverted.
    const fired2 = markFired(row.id);
    expect(fired2?.status).toBe("fired");

    // cancel on a fired row is also a no-op
    const c = cancel(row.id);
    expect(c?.status).toBe("fired");

    // markMissed on a fired row is also a no-op
    const m = markMissed(row.id);
    expect(m?.status).toBe("fired");
  });

  it("sweepMissed() flips overdue-past-grace pending rows to missed and returns ids", () => {
    const chatId = seedChat(sqlite);
    const overdue = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "stale" });
    const within = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "fresh" });

    // overdue: fire_at well past grace; within: just past fire_at but inside
    // the grace window.
    sqlite
      .prepare(`UPDATE scheduled_wakeups SET fire_at = ? WHERE id = ?`)
      .run(nowSec() - WAKEUP_FIRE_GRACE_SECONDS - 10, overdue.id);
    sqlite
      .prepare(`UPDATE scheduled_wakeups SET fire_at = ? WHERE id = ?`)
      .run(nowSec() - 5, within.id);

    const ids = sweepMissed();
    expect(ids).toEqual([overdue.id]);
    expect(getById(overdue.id)?.status).toBe("missed");
    expect(getById(within.id)?.status).toBe("pending");
  });

  it("list() filters by chat / task / status", () => {
    const chatA = seedChat(sqlite, "cs-a");
    const chatB = seedChat(sqlite, "cs-b");

    const a1 = record({ chatId: chatA, claudeSessionId: "cs-a", delaySeconds: 60, prompt: "p" });
    const a2 = record({ chatId: chatA, claudeSessionId: "cs-a", delaySeconds: 60, prompt: "q" });
    record({ chatId: chatB, claudeSessionId: "cs-b", delaySeconds: 60, prompt: "r" });

    cancel(a2.id);

    expect(list({ chatId: chatA }).map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(list({ chatId: chatA, status: "pending" }).map((r) => r.id)).toEqual([a1.id]);
    expect(list({ chatId: chatA, status: "cancelled" }).map((r) => r.id)).toEqual([a2.id]);
  });
});

describe("wakeup-worker", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];

  beforeEach(() => {
    const made = createTestDb();
    sqlite = made.sqlite;
    setDb(made.db, made.sqlite);
  });

  afterEach(() => {
    sqlite.close();
    __resetWakeupWorker();
  });

  it("runWakeupTick() invokes the fire callback and marks rows fired", async () => {
    const chatId = seedChat(sqlite);
    const row = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "go" });

    const fired: WakeupRow[] = [];
    startWakeupWorker((r) => {
      fired.push(r);
    }, { intervalMs: 1_000_000 /* effectively never */ });

    await runWakeupTick();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(row.id);
    expect(getById(row.id)?.status).toBe("fired");
  });

  it("runWakeupTick() leaves row pending when fire callback throws", async () => {
    const chatId = seedChat(sqlite);
    const row = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "go" });

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startWakeupWorker(() => {
      throw new Error("transport blip");
    }, { intervalMs: 1_000_000 });

    await runWakeupTick();

    expect(getById(row.id)?.status).toBe("pending");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("runWakeupTick() sweeps missed rows BEFORE firing the callback (downtime backlog)", async () => {
    const chatId = seedChat(sqlite);

    const overdue = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "stale" });
    const fresh = record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "fresh" });

    sqlite
      .prepare(`UPDATE scheduled_wakeups SET fire_at = ? WHERE id = ?`)
      .run(nowSec() - WAKEUP_FIRE_GRACE_SECONDS - 10, overdue.id);
    sqlite
      .prepare(`UPDATE scheduled_wakeups SET fire_at = ? WHERE id = ?`)
      .run(nowSec() - 1, fresh.id);

    const fired: string[] = [];
    const missed: string[] = [];
    startWakeupWorker(
      (r) => {
        fired.push(r.id);
      },
      {
        intervalMs: 1_000_000,
        onMissed: (ids) => {
          missed.push(...ids);
        },
      },
    );

    await runWakeupTick();

    expect(missed).toEqual([overdue.id]);
    expect(fired).toEqual([fresh.id]); // overdue was demoted before fire scan
    expect(getById(overdue.id)?.status).toBe("missed");
    expect(getById(fresh.id)?.status).toBe("fired");
  });

  it("runWakeupTick() drops re-entrant ticks", async () => {
    const chatId = seedChat(sqlite);
    record({ chatId, claudeSessionId: "cs", delaySeconds: 0, prompt: "go" });

    let inFlight = 0;
    let maxOverlap = 0;
    let calls = 0;
    startWakeupWorker(async () => {
      calls += 1;
      inFlight += 1;
      maxOverlap = Math.max(maxOverlap, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    }, { intervalMs: 1_000_000 });

    // Fire two ticks back-to-back; the second should drop because the
    // first's callback is still awaiting.
    const a = runWakeupTick();
    const b = runWakeupTick();
    await Promise.all([a, b]);

    expect(maxOverlap).toBe(1);
    // The second tick was dropped before any DB scan ran, so the row was
    // fired exactly once.
    expect(calls).toBe(1);
  });
});
