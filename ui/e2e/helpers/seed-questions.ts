import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { createProject } from "../_helpers";

/**
 * DB-direct seed helpers for `agent_questions` rows — the same fast-path
 * pattern documented at the top of `attention.spec.ts`. The Playwright
 * harness boots the daemon with `FLOCKCTL_MOCK_AI=1`, but no AgentSession
 * actually honours that flag, so driving the AskUserQuestion tool from a
 * real agent run is impossible in this environment. Inserting the row
 * directly into the SQLite file the daemon is reading is safe under WAL
 * and matches what the unit/integration tier already does.
 *
 * `seedTaskQuestion` and `seedChatQuestion` are intentionally symmetric
 * so the inbox spec can iterate over both surfaces with one fixture.
 *
 * The slice-04 plan asks the helpers to live under `ui/tests/e2e/helpers/`,
 * but the actual Playwright `testDir` (see `playwright.config.ts:12`) is
 * `./e2e`, so the helpers ship alongside the existing `_helpers.ts` at
 * `ui/e2e/helpers/`. Keeps the import paths short and matches the
 * convention every other spec already follows.
 */

const here = dirname(fileURLToPath(import.meta.url));
// playwright.config.ts sets `FLOCKCTL_HOME` to `<repoRoot>/.e2e-data` for the
// daemon process; the DB file therefore lives at
// `<repoRoot>/.e2e-data/flockctl.db`. `here` resolves to `ui/e2e/helpers`,
// so we walk three levels up.
const dbPath = resolve(here, "..", "..", "..", ".e2e-data", "flockctl.db");

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface SeedQuestionInput {
  question?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  header?: string;
  /** Override the request id (defaults to a fresh nanoid-shaped uuid). */
  requestId?: string;
  /** Override the tool_use id (defaults to "tu-<requestId>"). */
  toolUseId?: string;
}

export interface SeededTaskQuestion {
  taskId: number;
  projectId: number;
  requestId: string;
}

export interface SeededChatQuestion {
  chatId: number;
  projectId: number;
  requestId: string;
}

/**
 * Insert a pending `agent_questions` row tied to a freshly-inserted task.
 *
 * Both the task and the question are pushed directly into SQLite. We
 * deliberately do NOT use `createTask` from `_helpers.ts` — that path
 * invokes the public `POST /tasks` endpoint, which immediately picks the
 * task up via the auto-executor and races our status UPDATE. Inserting
 * the task in `status='waiting_for_input'` from the start mirrors what a
 * real agent run looks like the moment it emits an `AskUserQuestion`
 * tool call, and lets the cold-path resolver in
 * `task-executor/executor-questions.ts:resolveQuestionCold` accept the
 * answer when the test POSTs to `/tasks/:id/question/:requestId/answer`.
 *
 * The project is still created via the REST helper so we get a valid
 * `aiProviderKeyId` and project row consistent with what the e2e harness
 * expects.
 */
export async function seedTaskQuestion(
  request: APIRequestContext,
  input: SeedQuestionInput = {},
  // Optional pre-created project so callers can group multiple questions
  // under one project (used by the 50-row layout scenario).
  preCreatedProjectId?: number,
): Promise<SeededTaskQuestion> {
  const projectId =
    preCreatedProjectId ?? (await createProject(request)).id;

  const requestId = input.requestId ?? `req-${randomUUID()}`;
  const toolUseId = input.toolUseId ?? `tu-${requestId}`;
  const label = `task-question-seed-${requestId}`;

  const db = new Database(dbPath);
  let taskId: number;
  try {
    const taskInfo = db
      .prepare(
        `INSERT INTO tasks (project_id, prompt, agent, status, label, task_type)
         VALUES (?, ?, 'claude-code', 'waiting_for_input', ?, 'execution')`,
      )
      .run(projectId, input.question ?? "task-question-seed", label);
    taskId = Number(taskInfo.lastInsertRowid);

    db.prepare(
      `INSERT INTO agent_questions
         (request_id, task_id, chat_id, tool_use_id, question, options, multi_select, header, status)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      requestId,
      taskId,
      toolUseId,
      input.question ?? "What should I do next?",
      input.options ? JSON.stringify(input.options) : null,
      input.multiSelect ? 1 : 0,
      input.header ?? null,
    );
  } finally {
    db.close();
  }

  return { taskId, projectId, requestId };
}

/**
 * Insert a pending `agent_questions` row tied to a freshly-created chat.
 *
 * Mirror of `seedTaskQuestion`. The chat is created via REST so it picks up a
 * valid `projectId` (the aggregator allows null, but the inbox row prefers a
 * real project so the row matches what a user would see in real life). No
 * cold-path execution — chats have no `waiting_for_input` status, so the row
 * simply surfaces in `/attention` until the answer endpoint is hit.
 */
export async function seedChatQuestion(
  request: APIRequestContext,
  input: SeedQuestionInput = {},
  preCreatedProjectId?: number,
): Promise<SeededChatQuestion> {
  const projectId =
    preCreatedProjectId ?? (await createProject(request)).id;

  const chatRes = await request.post("/chats", {
    data: { projectId, title: "chat-question-seed" },
  });
  if (chatRes.status() !== 201 && chatRes.status() !== 200) {
    throw new Error(
      `seedChatQuestion: POST /chats failed: ${chatRes.status()} ${await chatRes.text()}`,
    );
  }
  const chat = (await chatRes.json()) as { id: number };

  const requestId = input.requestId ?? `req-${randomUUID()}`;
  const toolUseId = input.toolUseId ?? `tu-${requestId}`;

  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO agent_questions
         (request_id, task_id, chat_id, tool_use_id, question, options, multi_select, header, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      requestId,
      chat.id,
      toolUseId,
      input.question ?? "What should I do next?",
      input.options ? JSON.stringify(input.options) : null,
      input.multiSelect ? 1 : 0,
      input.header ?? null,
    );
  } finally {
    db.close();
  }

  return { chatId: chat.id, projectId, requestId };
}

/**
 * Insert a `tasks` row already in `pending_approval` so the inbox surfaces a
 * `task_approval` blocker without driving a real agent. Lifted from
 * `attention.spec.ts` so the inbox spec doesn't fork the same SQL.
 */
export function insertPendingApprovalTask(
  projectId: number,
  label: string,
): number {
  const db = new Database(dbPath);
  try {
    const info = db
      .prepare(
        `INSERT INTO tasks (project_id, prompt, agent, status, label, requires_approval, task_type)
         VALUES (?, ?, ?, 'pending_approval', ?, 1, 'execution')`,
      )
      .run(projectId, "approval-flow-check", "claude-code", label);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

/**
 * Insert a `chats` row pre-flipped to `approval_status='pending'` so the
 * inbox surfaces a `chat_approval` blocker. `requires_approval=1` mirrors
 * the column name on disk (the Drizzle camelCase is `requiresApproval`).
 */
export function insertPendingApprovalChat(
  projectId: number,
  title: string,
): number {
  const db = new Database(dbPath);
  try {
    const info = db
      .prepare(
        `INSERT INTO chats (project_id, title, requires_approval, approval_status)
         VALUES (?, ?, 1, 'pending')`,
      )
      .run(projectId, title);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

/**
 * Mark a previously-seeded question row as answered. Used by the "stale"
 * scenario where the test simulates an external client racing the UI to
 * resolve the question — flipping the row directly is faster and avoids
 * needing a live in-memory chat session.
 */
export function markQuestionAnswered(requestId: string, answer: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `UPDATE agent_questions
         SET status = 'answered', answer = ?, answered_at = datetime('now')
       WHERE request_id = ?`,
    ).run(answer, requestId);
  } finally {
    db.close();
  }
}

/**
 * Read the answer + status pair off a question row. Tests use it to assert
 * the expected answer landed in storage after the picker round-trip.
 */
export function readQuestionRow(requestId: string): {
  answer: string | null;
  status: string;
  multiSelect: number;
} | null {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT answer, status, multi_select AS multiSelect FROM agent_questions WHERE request_id = ?`,
      )
      .get(requestId) as
      | { answer: string | null; status: string; multiSelect: number }
      | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** Test cleanup — nuke every question + task + chat tied to a project so a
 *  flake in one test doesn't leak rows into the next. */
export function cleanupProjectData(projectId: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `DELETE FROM agent_questions
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
            OR chat_id IN (SELECT id FROM chats WHERE project_id = ?)`,
    ).run(projectId, projectId);
    db.prepare(`DELETE FROM tasks WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM chats WHERE project_id = ?`).run(projectId);
  } finally {
    db.close();
  }
}
