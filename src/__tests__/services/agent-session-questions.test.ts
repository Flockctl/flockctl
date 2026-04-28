import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { agentQuestions, tasks, chats } from "../../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Slice 03 contract — the AskUserQuestion interceptor in
 * `src/services/agent-session/session.ts:601-606` must capture the
 * structured (`options` / `multi_select` / `header`) shape from the
 * harness, persist it through `agent-interaction.ts`'s helpers, and
 * surface it on the `agent_question` WS payload.
 *
 * The tests below stand the AgentSession up directly with a mock provider
 * (no HTTP server, no real Claude SDK) and wire its `question_request`
 * event to `persistAgentQuestion` + `broadcastAgentQuestion` exactly the
 * way `chat-executor.ts` does — so the round trip exercised here matches
 * what runs in production minus the executor wrapper.
 */

let dbModule: typeof import("../../db/index.js");
let wsManagerModule: typeof import("../../services/ws-manager.js");
let agentInteraction: typeof import("../../services/agent-interaction.js");
let agentSessionModule: typeof import("../../services/agent-session/index.js");
let db: ReturnType<typeof createTestDb>["db"];
let sqlite: ReturnType<typeof createTestDb>["sqlite"];

beforeEach(async () => {
  vi.resetModules();
  dbModule = await import("../../db/index.js");
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  dbModule.setDb(db, t.sqlite);
  wsManagerModule = await import("../../services/ws-manager.js");
  agentInteraction = await import("../../services/agent-interaction.js");
  agentSessionModule = await import("../../services/agent-session/index.js");

  // Seed parent rows used by the chat-scoped agent_questions XOR target.
  db.insert(chats).values({ title: "test chat" }).run();
  db.insert(tasks).values({ prompt: "test task" }).run();
});

afterEach(() => {
  dbModule.closeDb();
  sqlite.close();
});

// ─── helpers ────────────────────────────────────────────────────────────

function listenChat(chatId: number) {
  const ws = { send: vi.fn(), readyState: 1 } as any;
  wsManagerModule.wsManager.addGlobalChatClient(ws);
  // Bind to the chat channel as well — `broadcastChat` is what the helpers
  // call. Global clients receive every chat broadcast already.
  return ws;
}

function findFrame(ws: { send: ReturnType<typeof vi.fn> }, type: string): any | null {
  for (const c of ws.send.mock.calls) {
    try {
      const parsed = JSON.parse(c[0]);
      if (parsed?.type === type) return parsed;
    } catch { /* ignore non-JSON frames */ }
  }
  return null;
}

/**
 * Build a minimal provider that returns a scripted sequence of `chat()`
 * results. Each call pops one entry. Captures the `messages` array seen
 * by each call so tests can assert what tool_result was relayed.
 */
function makeScriptedProvider(script: any[]) {
  const observed: any[][] = [];
  const provider: any = {
    id: "scripted",
    displayName: "scripted",
    listModels: () => [],
    checkReadiness: () => ({ installed: true, authenticated: true, ready: true }),
    estimateCost: () => null,
    streamChat: async function* () { /* unused */ },
    chat: vi.fn(async (opts: any) => {
      observed.push(JSON.parse(JSON.stringify(opts.messages)));
      const next = script.shift();
      if (!next) {
        return {
          text: "done",
          rawContent: "done",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      return next;
    }),
  };
  return { provider, observed };
}

function makeSession(provider: any, overrides: any = {}) {
  return new agentSessionModule.AgentSession({
    chatId: 1,
    prompt: "go",
    model: "test-model",
    codebaseContext: "",
    provider,
    ...overrides,
  });
}

/**
 * Wire the session to `chat-executor`'s production behaviour for question
 * persistence + broadcast — without standing up the full executor. Returns
 * the captured-WS object so tests can assert on emitted frames.
 */
function wireQuestionPersistence(
  session: any,
  chatId: number,
): { ws: { send: ReturnType<typeof vi.fn> }; insertedIds: Array<number | null> } {
  const ws = listenChat(chatId);
  const insertedIds: Array<number | null> = [];
  session.on("question_request", (request: any) => {
    const ref = { kind: "chat" as const, id: chatId };
    const id = agentInteraction.persistAgentQuestion(ref, request);
    insertedIds.push(id);
    agentInteraction.broadcastAgentQuestion(ref, request, id);
  });
  return { ws, insertedIds };
}

// ─── tests ──────────────────────────────────────────────────────────────

describe("AgentSession × AskUserQuestion structured options", () => {
  it("round-trip: tool_use with 3 options + multi_select=true + header → DB row + WS payload", async () => {
    const askInput = {
      question: "Which deploy target?",
      header: "Deploy",
      multi_select: true,
      options: [
        { label: "staging", description: "pre-prod" },
        { label: "prod", description: "live", preview: "irreversible" },
        { label: "canary" },
      ],
    };

    const { provider } = makeScriptedProvider([
      // Turn 1 — emit AskUserQuestion tool_use.
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-rt-1", name: "AskUserQuestion", input: askInput },
        ],
        toolCalls: [{ id: "tu-rt-1", name: "AskUserQuestion", input: askInput }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      // Turn 2 — finishes after the answer comes back.
      {
        text: "ok",
        rawContent: "ok",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);

    const requests: any[] = [];
    session.on("question_request", (r: any) => requests.push(r));

    const runP = session.run();
    while (requests.length === 0) await new Promise((r) => setImmediate(r));

    // QuestionRequest carries the structured fields.
    expect(requests[0].question).toBe("Which deploy target?");
    expect(requests[0].header).toBe("Deploy");
    expect(requests[0].multiSelect).toBe(true);
    expect(requests[0].options).toHaveLength(3);
    expect(requests[0].options[1]).toEqual({
      label: "prod",
      description: "live",
      preview: "irreversible",
    });

    // Resolve and let the loop finish.
    expect(session.resolveQuestion(requests[0].requestId, "prod")).toBe(true);
    await runP;

    // DB row carries the structured fields.
    const row = db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, requests[0].requestId))
      .get();
    expect(row).toBeDefined();
    expect(row!.question).toBe("Which deploy target?");
    expect(row!.header).toBe("Deploy");
    expect(row!.multiSelect).toBe(true);
    expect(row!.options).toBeTruthy();
    const parsedOpts = JSON.parse(row!.options!);
    expect(parsedOpts).toEqual(askInput.options);

    // WS payload carries the structured fields.
    const frame = findFrame(ws, "agent_question");
    expect(frame).not.toBeNull();
    expect(frame.payload.question).toBe("Which deploy target?");
    expect(frame.payload.header).toBe("Deploy");
    expect(frame.payload.multi_select).toBe(true);
    expect(frame.payload.options).toEqual(askInput.options);
  });

  it("free-form backward compat: tool_use with only `question` → row + payload omit options", async () => {
    const { provider } = makeScriptedProvider([
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-ff-1", name: "AskUserQuestion", input: { question: "huh?" } },
        ],
        toolCalls: [{ id: "tu-ff-1", name: "AskUserQuestion", input: { question: "huh?" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { text: "done", rawContent: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);
    const requests: any[] = [];
    session.on("question_request", (r: any) => requests.push(r));

    const runP = session.run();
    while (requests.length === 0) await new Promise((r) => setImmediate(r));
    session.resolveQuestion(requests[0].requestId, "answer");
    await runP;

    const row = db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, requests[0].requestId))
      .get();
    expect(row!.options).toBeNull();
    expect(row!.multiSelect).toBe(false);
    expect(row!.header).toBeNull();

    const frame = findFrame(ws, "agent_question");
    expect(frame.payload).not.toHaveProperty("options");
    expect(frame.payload).not.toHaveProperty("header");
    expect(frame.payload.multi_select).toBe(false);
  });

  it("malformed rejection: option with empty label → no row, error tool_result, log captured", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const malformed = {
      question: "pick one",
      // The shared parser requires options[].label to be non-empty.
      options: [{ label: "" }],
    };

    const { provider, observed } = makeScriptedProvider([
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-bad-1", name: "AskUserQuestion", input: malformed },
        ],
        toolCalls: [{ id: "tu-bad-1", name: "AskUserQuestion", input: malformed }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { text: "done", rawContent: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);
    const requests: any[] = [];
    session.on("question_request", (r: any) => requests.push(r));
    const toolResults: Array<[string, string]> = [];
    session.on("tool_result", (n: string, out: string) => toolResults.push([n, out]));

    await session.run();

    // No question_request fired — the parse failed before awaitUserAnswer.
    expect(requests).toHaveLength(0);
    // No DB row written.
    const rows = db.select().from(agentQuestions).all();
    expect(rows).toHaveLength(0);
    // No agent_question WS frame either.
    expect(findFrame(ws, "agent_question")).toBeNull();
    // tool_result emitted with an Error: prefix.
    const tr = toolResults.find(([n]) => n === "AskUserQuestion");
    expect(tr).toBeDefined();
    expect(tr![1]).toMatch(/^Error: invalid AskUserQuestion input/);
    // Validation error logged via console.error.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/AskUserQuestion validation failed/);

    // Second turn saw the error string as a tool_result against the original tool_use_id.
    const turn2Messages = observed[1];
    expect(turn2Messages).toBeDefined();
    const last = turn2Messages![turn2Messages!.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu-bad-1",
    });
    expect(String(last.content[0].content)).toMatch(/^Error: invalid AskUserQuestion input/);

    errorSpy.mockRestore();
  });

  it("oversized rejection: 21-element options array → no row, error tool_result", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const oversized = {
      question: "too many",
      options: Array.from({ length: 21 }, (_, i) => ({ label: `o${i}` })),
    };

    const { provider } = makeScriptedProvider([
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-big-1", name: "AskUserQuestion", input: oversized },
        ],
        toolCalls: [{ id: "tu-big-1", name: "AskUserQuestion", input: oversized }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { text: "done", rawContent: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);
    const toolResults: Array<[string, string]> = [];
    session.on("tool_result", (n: string, out: string) => toolResults.push([n, out]));

    await session.run();

    expect(db.select().from(agentQuestions).all()).toHaveLength(0);
    expect(findFrame(ws, "agent_question")).toBeNull();
    const tr = toolResults.find(([n]) => n === "AskUserQuestion");
    expect(tr![1]).toMatch(/^Error: invalid AskUserQuestion input/);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("empty options collapse: options=[] persists as NULL, behaves as free-form", async () => {
    const { provider } = makeScriptedProvider([
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-empty-1", name: "AskUserQuestion", input: { question: "ok?", options: [] } },
        ],
        toolCalls: [
          { id: "tu-empty-1", name: "AskUserQuestion", input: { question: "ok?", options: [] } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { text: "done", rawContent: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);
    const requests: any[] = [];
    session.on("question_request", (r: any) => requests.push(r));

    const runP = session.run();
    while (requests.length === 0) await new Promise((r) => setImmediate(r));

    // The session-level QuestionRequest does NOT carry an options field —
    // the parser collapsed the empty array.
    expect(requests[0]).not.toHaveProperty("options");
    session.resolveQuestion(requests[0].requestId, "yes");
    await runP;

    const row = db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, requests[0].requestId))
      .get();
    expect(row!.options).toBeNull();
    expect(row!.multiSelect).toBe(false);

    const frame = findFrame(ws, "agent_question");
    expect(frame.payload).not.toHaveProperty("options");
  });

  it("multi_select with single option: persists as-is without rejection", async () => {
    const askInput = {
      question: "confirm?",
      multi_select: true,
      options: [{ label: "yes" }],
    };

    const { provider } = makeScriptedProvider([
      {
        text: "",
        rawContent: [
          { type: "tool_use", id: "tu-ms1-1", name: "AskUserQuestion", input: askInput },
        ],
        toolCalls: [{ id: "tu-ms1-1", name: "AskUserQuestion", input: askInput }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { text: "done", rawContent: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const session = makeSession(provider);
    const { ws } = wireQuestionPersistence(session, 1);
    const requests: any[] = [];
    session.on("question_request", (r: any) => requests.push(r));

    const runP = session.run();
    while (requests.length === 0) await new Promise((r) => setImmediate(r));
    session.resolveQuestion(requests[0].requestId, "yes");
    await runP;

    const row = db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, requests[0].requestId))
      .get();
    expect(row!.multiSelect).toBe(true);
    const opts = JSON.parse(row!.options!);
    expect(opts).toEqual([{ label: "yes" }]);

    const frame = findFrame(ws, "agent_question");
    expect(frame.payload.multi_select).toBe(true);
    expect(frame.payload.options).toEqual([{ label: "yes" }]);
  });

  it("JSON encoding safety: option label with SQL injection chars round-trips byte-for-byte", () => {
    const malicious = `'); DROP TABLE--`;
    const ref = { kind: "chat" as const, id: 1 };
    const insertedId = agentInteraction.persistAgentQuestion(ref, {
      requestId: "sql-injection-1",
      question: "pick poison",
      toolUseID: "tu-sql-1",
      multiSelect: false,
      options: [{ label: malicious, description: malicious }],
      header: malicious,
    } as any);
    expect(insertedId).not.toBeNull();

    // Read the row back with Drizzle (also a prepared statement) and assert
    // the persisted JSON deserialises into the exact original strings.
    const row = db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.requestId, "sql-injection-1"))
      .get();
    expect(row).toBeDefined();
    expect(row!.header).toBe(malicious);
    expect(row!.options).toBeTruthy();
    const parsed = JSON.parse(row!.options!);
    expect(parsed).toEqual([{ label: malicious, description: malicious }]);
    expect(parsed[0].label).toBe(malicious);

    // Sanity-check that agent_questions still has exactly one row — i.e. the
    // injection attempt did not cause any DDL/DML side effect.
    const allRows = db.select().from(agentQuestions).all();
    expect(allRows).toHaveLength(1);
  });

  it("restart resume: pre-persisted row re-broadcasts agent_question with options on resume", () => {
    // Simulate the post-restart DB state: a pending row already exists, no
    // session is running, and a WS client (re)subscribes.
    const optionsJson = JSON.stringify([
      { label: "alpha" },
      { label: "beta", preview: "long-form preview text" },
    ]);
    const inserted = db
      .insert(agentQuestions)
      .values({
        requestId: "resume-1",
        chatId: 1,
        toolUseId: "tu-resume-1",
        question: "Resume me?",
        options: optionsJson,
        multiSelect: true,
        header: "Resume",
        status: "pending",
      })
      .returning()
      .get();

    const ws = listenChat(1);
    const ref = { kind: "chat" as const, id: 1 };
    agentInteraction.broadcastAgentQuestionFromRow(ref, {
      id: inserted!.id,
      requestId: inserted!.requestId,
      question: inserted!.question,
      toolUseId: inserted!.toolUseId,
      options: inserted!.options ?? null,
      multiSelect: inserted!.multiSelect,
      header: inserted!.header ?? null,
    });

    const frame = findFrame(ws, "agent_question");
    expect(frame).not.toBeNull();
    expect(frame.payload.chat_id).toBe("1");
    expect(frame.payload.request_id).toBe("resume-1");
    expect(frame.payload.question).toBe("Resume me?");
    expect(frame.payload.tool_use_id).toBe("tu-resume-1");
    expect(frame.payload.db_id).toBe(inserted!.id);
    expect(frame.payload.multi_select).toBe(true);
    expect(frame.payload.header).toBe("Resume");
    expect(frame.payload.options).toEqual([
      { label: "alpha" },
      { label: "beta", preview: "long-form preview text" },
    ]);
  });
});
