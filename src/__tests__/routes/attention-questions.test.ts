/**
 * Integration tests for /attention question rows + WS attention_changed
 * events.
 *
 * Layered on top of the existing `attention.test.ts` route coverage and the
 * `attention-questions.test.ts` pure-serializer coverage to give M05's
 * `task_question` / `chat_question` kinds an end-to-end gate. Concretely we
 * verify:
 *   - GET /attention surfaces pending agent_questions on tasks and chats
 *     with the documented payload shape (header optional, options optional,
 *     `multiSelect` always present)
 *   - Answered/cancelled rows stay out of the inbox
 *   - WS `attention_changed` fires both on question CREATE (via the same
 *     internal helper the executor uses) and on question RESOLVE (via the
 *     `/answer` route)
 *   - The four pre-existing kinds (task_approval, chat_approval,
 *     task_permission, chat_permission) keep their shapes unchanged after
 *     the question rows landed alongside them
 *
 * The two cross-owner cases (`excludes_other_owners_questions` and
 * `cross_owner_idor`) are `.skip`'d for the same reason
 * `chats-questions.test.ts` skips its IDOR placeholder: the schema has no
 * owner_id column on tasks/chats and bearer tokens grant un-scoped access,
 * so there's no contract to gate against yet. Parking spots stay so a future
 * pass can wire up real owner scoping without re-discovering the gap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import {
  projects,
  tasks,
  chats,
  agentQuestions,
} from "../../db/schema.js";
import { wsManager } from "../../services/ws-manager.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { handleQuestionEmitted } from "../../services/task-executor/executor-questions.js";
import type { AgentSession } from "../../services/agent-session/index.js";

// Stub the agent registry — chat reads/updates poke at it for cost and
// session rename, neither of which the attention pipeline needs.
vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

// ─── WS test helpers ───────────────────────────────────────────────────────

interface WSCapture {
  ws: { send: (msg: string) => void; readyState: number };
  frames: Array<Record<string, unknown>>;
}

/** Subscribe a fake socket to the global WS bus. Frames are pushed into the
 *  returned array in JSON-decoded form so test assertions can shape-match
 *  without re-parsing. */
function attachClient(): WSCapture {
  const frames: Array<Record<string, unknown>> = [];
  const ws = {
    send: (msg: string) => frames.push(JSON.parse(msg)),
    readyState: 1,
  };
  wsManager.addGlobalChatClient(ws as never);
  return { ws, frames };
}

/** Poll until `predicate` matches one of the captured frames or the timeout
 *  expires. Fast-path returns immediately when the frame is already there
 *  (broadcasts inside the same tick), so callers don't pay the polling cost
 *  on the happy path. */
async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 500,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForFrame timed out after ${timeoutMs}ms (saw ${frames.length} frames: ${frames
      .map((f) => f.type)
      .join(",")})`,
  );
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe("GET /attention — question rows + WS events", () => {
  let testDb: ReturnType<typeof createTestDb>;
  // Two independent ownership envelopes so the regression + cross-owner
  // cases share one fixture. There's no `owner_id` column today, so "owner"
  // is shorthand for "task/chat in a different project".
  let ownerATaskId: number;
  let ownerAChatId: number;
  let ownerBTaskId: number;
  let ownerBChatId: number;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    _resetRateLimiter();

    testDb.db.insert(projects).values({ name: "ownerA-proj" }).run();
    testDb.db.insert(projects).values({ name: "ownerB-proj" }).run();

    ownerATaskId = testDb.db
      .insert(tasks)
      .values({ projectId: 1, prompt: "ownerA task", status: "running" })
      .returning()
      .get()!.id;
    ownerBTaskId = testDb.db
      .insert(tasks)
      .values({ projectId: 2, prompt: "ownerB task", status: "running" })
      .returning()
      .get()!.id;
    ownerAChatId = testDb.db
      .insert(chats)
      .values({ projectId: 1, title: "ownerA chat" })
      .returning()
      .get()!.id;
    ownerBChatId = testDb.db
      .insert(chats)
      .values({ projectId: 2, title: "ownerB chat" })
      .returning()
      .get()!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
  });

  // ─── Seed helpers ────────────────────────────────────────────────────────

  type QuestionOverrides = Partial<typeof agentQuestions.$inferInsert>;

  function seedTaskQuestion(
    taskId: number,
    overrides: QuestionOverrides = {},
  ): string {
    const requestId =
      overrides.requestId ?? `req-task-${Math.random().toString(36).slice(2, 10)}`;
    testDb.db
      .insert(agentQuestions)
      .values({
        requestId,
        taskId,
        toolUseId: `tu-${requestId}`,
        question: "what?",
        status: "pending",
        ...overrides,
      })
      .run();
    return requestId;
  }

  function seedChatQuestion(
    chatId: number,
    overrides: QuestionOverrides = {},
  ): string {
    const requestId =
      overrides.requestId ?? `req-chat-${Math.random().toString(36).slice(2, 10)}`;
    testDb.db
      .insert(agentQuestions)
      .values({
        requestId,
        chatId,
        toolUseId: `tu-${requestId}`,
        question: "what?",
        status: "pending",
        ...overrides,
      })
      .run();
    return requestId;
  }

  async function getAttention(): Promise<{ items: unknown[]; total: number }> {
    const res = await app.request("/attention");
    expect(res.status).toBe(200);
    return (await res.json()) as { items: unknown[]; total: number };
  }

  /** Stub `chatExecutor.answerQuestion` to perform the same observable side
   *  effects as the real implementation: flip the row to status='answered'
   *  and broadcast `attention_changed`. Mirrors the helper inside
   *  `chats-questions.test.ts`. */
  function spyChatAnswer(): void {
    vi.spyOn(chatExecutor, "answerQuestion").mockImplementation(
      (cId: number, rId: string, ans: string): boolean => {
        const row = testDb.db
          .select()
          .from(agentQuestions)
          .where(eq(agentQuestions.requestId, rId))
          .get();
        if (!row || row.chatId !== cId || row.status !== "pending") return false;
        testDb.db
          .update(agentQuestions)
          .set({
            answer: ans,
            status: "answered",
            answeredAt: new Date().toISOString(),
          })
          .where(eq(agentQuestions.id, row.id))
          .run();
        wsManager.broadcastAll({ type: "attention_changed", payload: {} });
        return true;
      },
    );
  }

  function spyTaskAnswer(): void {
    vi.spyOn(taskExecutor, "answerQuestion").mockImplementation(
      (tId: number, rId: string, ans: string): boolean => {
        const row = testDb.db
          .select()
          .from(agentQuestions)
          .where(eq(agentQuestions.requestId, rId))
          .get();
        if (!row || row.taskId !== tId || row.status !== "pending") return false;
        testDb.db
          .update(agentQuestions)
          .set({
            answer: ans,
            status: "answered",
            answeredAt: new Date().toISOString(),
          })
          .where(eq(agentQuestions.id, row.id))
          .run();
        wsManager.broadcastAll({ type: "attention_changed", payload: {} });
        return true;
      },
    );
  }

  // ─── 1. Pending task questions surface in /attention ─────────────────────

  it("includes_pending_task_questions", async () => {
    seedTaskQuestion(ownerATaskId, {
      requestId: "tq-1",
      question: "Pick one",
      header: "Pick",
      multiSelect: false,
      options: JSON.stringify([{ label: "yes" }, { label: "no" }]),
    });
    seedTaskQuestion(ownerATaskId, {
      requestId: "tq-2",
      question: "Free form?",
    });

    const body = await getAttention();
    const taskQs = (body.items as Array<Record<string, unknown>>).filter(
      (i) => i.kind === "task_question",
    );
    expect(taskQs).toHaveLength(2);

    const byReq = new Map(taskQs.map((q) => [q.requestId as string, q]));
    expect(byReq.get("tq-1")).toMatchObject({
      kind: "task_question",
      taskId: ownerATaskId,
      projectId: 1,
      question: "Pick one",
      header: "Pick",
      multiSelect: false,
      options: [{ label: "yes" }, { label: "no" }],
    });
    expect(byReq.get("tq-2")).toMatchObject({
      kind: "task_question",
      taskId: ownerATaskId,
      projectId: 1,
      question: "Free form?",
      multiSelect: false,
    });
    // Free-form payload does not carry `options` / `header` keys at all —
    // mirrors the WS broadcaster's "absent === free-form" contract so
    // clients can't accidentally render an empty picker.
    expect(byReq.get("tq-2")).not.toHaveProperty("options");
    expect(byReq.get("tq-2")).not.toHaveProperty("header");
  });

  // ─── 2. Pending chat questions surface in /attention ─────────────────────

  it("includes_pending_chat_questions", async () => {
    seedChatQuestion(ownerAChatId, {
      requestId: "cq-1",
      question: "Targets?",
      header: "Targets",
      multiSelect: true,
      options: JSON.stringify([
        { label: "alpha" },
        { label: "beta", description: "second" },
      ]),
    });
    seedChatQuestion(ownerAChatId, {
      requestId: "cq-2",
      question: "Free form?",
    });

    const body = await getAttention();
    const chatQs = (body.items as Array<Record<string, unknown>>).filter(
      (i) => i.kind === "chat_question",
    );
    expect(chatQs).toHaveLength(2);

    const byReq = new Map(chatQs.map((q) => [q.requestId as string, q]));
    expect(byReq.get("cq-1")).toMatchObject({
      kind: "chat_question",
      chatId: ownerAChatId,
      projectId: 1,
      question: "Targets?",
      header: "Targets",
      multiSelect: true,
      options: [
        { label: "alpha" },
        { label: "beta", description: "second" },
      ],
    });
    expect(byReq.get("cq-2")).toMatchObject({
      kind: "chat_question",
      chatId: ownerAChatId,
      projectId: 1,
      question: "Free form?",
      multiSelect: false,
    });
    expect(byReq.get("cq-2")).not.toHaveProperty("options");
    expect(byReq.get("cq-2")).not.toHaveProperty("header");
  });

  // ─── 3. Answered/cancelled rows are filtered ─────────────────────────────

  it("excludes_answered_questions", async () => {
    seedTaskQuestion(ownerATaskId, { requestId: "pending-1" });
    seedTaskQuestion(ownerATaskId, {
      requestId: "answered-1",
      status: "answered",
      answer: "ok",
      answeredAt: new Date().toISOString(),
    });
    seedTaskQuestion(ownerATaskId, {
      requestId: "cancelled-1",
      status: "cancelled",
    });
    seedChatQuestion(ownerAChatId, { requestId: "pending-2" });
    seedChatQuestion(ownerAChatId, {
      requestId: "answered-2",
      status: "answered",
      answer: "ok",
      answeredAt: new Date().toISOString(),
    });

    const body = await getAttention();
    const reqIds = (body.items as Array<Record<string, unknown>>)
      .filter((i) => i.kind === "task_question" || i.kind === "chat_question")
      .map((i) => i.requestId as string)
      .sort();
    expect(reqIds).toEqual(["pending-1", "pending-2"]);
  });

  // ─── 4. attention_changed fires when a question is created ───────────────

  it("emits_attention_changed_on_question_create", async () => {
    const { ws, frames } = attachClient();
    try {
      // Direct call into the executor helper that the AgentSession invokes
      // when AskUserQuestion fires. Side effects: persists the row, flips
      // the task to waiting_for_input, and broadcasts `attention_changed`.
      handleQuestionEmitted(ownerATaskId, {
        requestId: "create-1",
        toolUseID: "tu-create-1",
        question: "Quick check?",
      });

      const frame = await waitForFrame(
        frames,
        (m) => m.type === "attention_changed",
      );
      expect(frame).toEqual({ type: "attention_changed", payload: {} });
    } finally {
      wsManager.removeClient(ws as never);
    }
  });

  // ─── 5. attention_changed fires when a chat question is resolved ─────────

  it("emits_attention_changed_on_question_resolve_for_chat", async () => {
    seedChatQuestion(ownerAChatId, { requestId: "chat-resolve-1" });
    spyChatAnswer();

    const { ws, frames } = attachClient();
    try {
      const res = await app.request(
        `/chats/${ownerAChatId}/question/chat-resolve-1/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "blue" }),
        },
      );
      expect(res.status).toBe(200);

      await waitForFrame(frames, (m) => m.type === "attention_changed");
    } finally {
      wsManager.removeClient(ws as never);
    }
  });

  // ─── 6. attention_changed fires when a task question is resolved ─────────

  it("emits_attention_changed_on_question_resolve_for_task", async () => {
    seedTaskQuestion(ownerATaskId, { requestId: "task-resolve-1" });
    spyTaskAnswer();

    const { ws, frames } = attachClient();
    try {
      const res = await app.request(
        `/tasks/${ownerATaskId}/question/task-resolve-1/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "go" }),
        },
      );
      expect(res.status).toBe(200);

      await waitForFrame(frames, (m) => m.type === "attention_changed");
    } finally {
      wsManager.removeClient(ws as never);
    }
  });

  // ─── 7. Cross-owner IDOR placeholders ────────────────────────────────────
  //
  // The /attention route is currently un-scoped — neither tasks nor chats
  // carry an owner_id column and bearer tokens grant access without an
  // owner constraint. Both placeholders are kept (and tagged) so the next
  // pass at multi-owner ACLs has a parking spot. Mirrors the equivalent
  // skipped block in chats-questions.test.ts.

  it.skip("excludes_other_owners_questions", () => {
    // Future shape:
    //   1. Seed ownerA + ownerB tokens via remote-auth config.
    //   2. Seed pending questions on ownerA's task/chat.
    //   3. GET /attention with ownerB's bearer.
    //   4. Assert ownerA's task_question / chat_question rows are absent.
    expect(true).toBe(true);
  });

  it.skip("cross_owner_idor", () => {
    // Future shape:
    //   1. Same fixture as `excludes_other_owners_questions`.
    //   2. POST /tasks/<ownerA-task>/question/<req>/answer with ownerB's
    //      bearer → expect 403 (or 404 — TBD when the ACL contract lands).
    //   3. Re-read agent_questions row → status still 'pending'.
    expect(true).toBe(true);
  });

  // ─── 8. Empty inbox ──────────────────────────────────────────────────────

  it("returns_empty_object_when_no_pending_items", async () => {
    // Wipe every entity that could surface as a blocker — the seed adds two
    // tasks/chats but neither carries pending state, so `items` should be
    // empty even before the wipe. The wipe is defensive against future
    // beforeEach expansions.
    testDb.db.delete(agentQuestions).run();
    testDb.db.delete(tasks).run();
    testDb.db.delete(chats).run();

    const body = await getAttention();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  // ─── 9. options column NULL → key omitted ────────────────────────────────

  it("options_NULL_omitted_not_null", async () => {
    seedTaskQuestion(ownerATaskId, {
      requestId: "free-form-1",
      question: "What now?",
      options: null,
    });

    const body = await getAttention();
    const row = (body.items as Array<Record<string, unknown>>).find(
      (i) => i.kind === "task_question" && i.requestId === "free-form-1",
    );
    expect(row).toBeDefined();
    // Strict assertion: the key must be absent, not present-with-undefined.
    // Anything else lets a downstream `JSON.stringify` emit `"options":null`,
    // which would break the WS broadcaster's "absent === free-form"
    // invariant.
    expect(row).not.toHaveProperty("options");
  });

  // ─── 10. 100 rows in deterministic order, fast ───────────────────────────

  it("100_pending_deterministic_order", async () => {
    // Synthesise monotonically increasing createdAt values so the global
    // newest-first sort lands `bulk-099` first and `bulk-000` last.
    for (let i = 0; i < 100; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
      testDb.db
        .insert(agentQuestions)
        .values({
          requestId: `bulk-${i.toString().padStart(3, "0")}`,
          taskId: ownerATaskId,
          toolUseId: `tu-bulk-${i}`,
          question: `q ${i}`,
          status: "pending",
          createdAt: ts,
        })
        .run();
    }

    const t0 = Date.now();
    const body = await getAttention();
    const elapsed = Date.now() - t0;

    const taskQs = (body.items as Array<Record<string, unknown>>).filter(
      (i) => i.kind === "task_question",
    );
    expect(taskQs).toHaveLength(100);
    // Newest blocker first per `attention.ts` global sort.
    expect(taskQs[0].requestId).toBe("bulk-099");
    expect(taskQs[99].requestId).toBe("bulk-000");
    for (let i = 1; i < taskQs.length; i++) {
      expect(
        (taskQs[i - 1].createdAt as string) >= (taskQs[i].createdAt as string),
      ).toBe(true);
    }
    // Sanity gate: a no-N+1 implementation easily lands under 200ms even on
    // a slow CI box. The test is informational on faster hardware.
    expect(elapsed).toBeLessThan(200);
  });

  // ─── 11. Two attention_changed frames in order ───────────────────────────

  it("two_attention_changed_in_order", async () => {
    const { ws, frames } = attachClient();
    try {
      // Frame 1 — synchronous create-side broadcast.
      handleQuestionEmitted(ownerATaskId, {
        requestId: "rapid-1",
        toolUseID: "tu-rapid-1",
        question: "first",
      });

      // Frame 2 — resolve-side broadcast through the same /answer route the
      // UI calls. Index of frame 2 must be > index of frame 1; we verify the
      // ordering rather than the exact count to stay tolerant of unrelated
      // broadcasts (e.g. `task_status` from handleQuestionEmitted) landing
      // in between.
      spyTaskAnswer();

      const res = await app.request(
        `/tasks/${ownerATaskId}/question/rapid-1/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "ok" }),
        },
      );
      expect(res.status).toBe(200);

      await waitForFrame(frames, () => {
        const count = frames.filter((f) => f.type === "attention_changed")
          .length;
        return count >= 2;
      });

      const indices = frames
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.type === "attention_changed")
        .map(({ i }) => i);
      expect(indices.length).toBeGreaterThanOrEqual(2);
      // Strictly increasing → arrived in create-then-resolve order.
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
    } finally {
      wsManager.removeClient(ws as never);
    }
  });

  // ─── 12. Existing kinds keep their shapes (regression) ───────────────────

  it("existing_kinds_unchanged_regression", async () => {
    // 1. task_approval — flip ownerA's task to pending_approval with a label.
    testDb.db
      .update(tasks)
      .set({ status: "pending_approval", label: "Review me" })
      .where(eq(tasks.id, ownerATaskId))
      .run();

    // 2. chat_approval — flip ownerA's chat into pending approval.
    testDb.db
      .update(chats)
      .set({ requiresApproval: true, approvalStatus: "pending" })
      .where(eq(chats.id, ownerAChatId))
      .run();

    // 3 + 4. task_permission / chat_permission — stub the executor's session
    // registry rather than booting a real AgentSession. The aggregator only
    // calls `pendingPermissionEntries()` on each session, so a tiny duck-
    // typed object is enough.
    const fakeTaskSession = {
      pendingPermissionEntries: () => [
        {
          request: {
            requestId: "tp-1",
            toolName: "Bash",
            toolInput: {},
            toolUseID: "u-tp-1",
          },
          createdAt: new Date(),
        },
      ],
    } as unknown as AgentSession;
    const fakeChatSession = {
      pendingPermissionEntries: () => [
        {
          request: {
            requestId: "cp-1",
            toolName: "Edit",
            toolInput: {},
            toolUseID: "u-cp-1",
          },
          createdAt: new Date(),
        },
      ],
    } as unknown as AgentSession;
    vi.spyOn(taskExecutor, "activeSessions").mockReturnValue(
      [[ownerBTaskId, fakeTaskSession]] as unknown as IterableIterator<
        [number, AgentSession]
      >,
    );
    vi.spyOn(chatExecutor, "activeSessions").mockReturnValue(
      [[ownerBChatId, fakeChatSession]] as unknown as IterableIterator<
        [number, AgentSession]
      >,
    );

    // 5 + 6. task_question / chat_question on the OTHER project so the
    // assertions stay readable (each kind is owned by a single entity id).
    seedTaskQuestion(ownerBTaskId, { requestId: "rg-tq-1", question: "tqq" });
    seedChatQuestion(ownerBChatId, { requestId: "rg-cq-1", question: "cqq" });

    const body = await getAttention();
    const byKind = new Map<string, Array<Record<string, unknown>>>();
    for (const item of body.items as Array<Record<string, unknown>>) {
      const list = byKind.get(item.kind as string) ?? [];
      list.push(item);
      byKind.set(item.kind as string, list);
    }

    // Each kind appears exactly once.
    expect(byKind.get("task_approval")?.length).toBe(1);
    expect(byKind.get("chat_approval")?.length).toBe(1);
    expect(byKind.get("task_permission")?.length).toBe(1);
    expect(byKind.get("chat_permission")?.length).toBe(1);
    expect(byKind.get("task_question")?.length).toBe(1);
    expect(byKind.get("chat_question")?.length).toBe(1);

    // Lock down the four pre-existing kinds' shapes. Using `toMatchObject`
    // (per the slice brief) keeps the diff readable when /attention adds a
    // new optional field — full snapshots would force a regen on every
    // additive change.
    expect(byKind.get("task_approval")![0]).toMatchObject({
      kind: "task_approval",
      taskId: ownerATaskId,
      projectId: 1,
      title: "Review me",
    });
    expect(typeof byKind.get("task_approval")![0].since).toBe("string");

    expect(byKind.get("chat_approval")![0]).toMatchObject({
      kind: "chat_approval",
      chatId: ownerAChatId,
      projectId: 1,
      title: "ownerA chat",
    });
    expect(typeof byKind.get("chat_approval")![0].since).toBe("string");

    expect(byKind.get("task_permission")![0]).toMatchObject({
      kind: "task_permission",
      taskId: ownerBTaskId,
      projectId: 2,
      requestId: "tp-1",
      tool: "Bash",
    });
    expect(typeof byKind.get("task_permission")![0].since).toBe("string");

    expect(byKind.get("chat_permission")![0]).toMatchObject({
      kind: "chat_permission",
      chatId: ownerBChatId,
      projectId: 2,
      requestId: "cp-1",
      tool: "Edit",
    });
    expect(typeof byKind.get("chat_permission")![0].since).toBe("string");

    // Sanity check the question rows too — they're new, so we assert their
    // ids reach back to the seeded entities and a `multiSelect` boolean is
    // always present on the wire.
    expect(byKind.get("task_question")![0]).toMatchObject({
      kind: "task_question",
      taskId: ownerBTaskId,
      projectId: 2,
      requestId: "rg-tq-1",
      multiSelect: false,
    });
    expect(byKind.get("chat_question")![0]).toMatchObject({
      kind: "chat_question",
      chatId: ownerBChatId,
      projectId: 2,
      requestId: "rg-cq-1",
      multiSelect: false,
    });

    // total === items.length is the route-level invariant; cheap to verify
    // alongside the kind breakdown.
    expect(body.total).toBe((body.items as unknown[]).length);
  });
});
