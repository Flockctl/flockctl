import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import {
  collectAttentionItems,
  type AttentionItem,
  type AttentionSessionRegistry,
} from "../../services/attention.js";
import type { FlockctlDb } from "../../db/index.js";
import { chats, projects, tasks } from "../../db/schema.js";
import type { AgentSession } from "../../services/agent-session/index.js";

// Minimal stand-in for AgentSession — collectAttentionItems only calls
// pendingPermissionEntries(), so everything else can be ignored.
function fakeSession(
  entries: Array<{ tool: string; requestId: string; createdAt: Date }>,
): AgentSession {
  return {
    pendingPermissionEntries: () =>
      entries.map((e) => ({
        request: {
          requestId: e.requestId,
          toolName: e.tool,
          toolInput: {},
          toolUseID: "u-" + e.requestId,
        },
        createdAt: e.createdAt,
      })),
  } as unknown as AgentSession;
}

function brokenSession(): AgentSession {
  return {
    pendingPermissionEntries: () => {
      throw new Error("session went sideways");
    },
  } as unknown as AgentSession;
}

// Push-based fake registry; tests append sessions after the fixture runs.
class FakeRegistry implements AttentionSessionRegistry {
  taskPairs: Array<[number, AgentSession]> = [];
  chatPairs: Array<[number, AgentSession]> = [];
  activeTaskSessions() {
    return this.taskPairs;
  }
  activeChatSessions() {
    return this.chatPairs;
  }
  addTaskSession(id: number, s: AgentSession) {
    this.taskPairs.push([id, s]);
  }
  addChatSession(id: number, s: AgentSession) {
    this.chatPairs.push([id, s]);
  }
}

/** Shared fixture: one pending_approval task + one running task whose session
 * has two pending permissions, at distinct timestamps so sort order is
 * deterministic. Returns the ids and session so tests can layer on top. */
function seedAttentionFixture(db: FlockctlDb, registry: FakeRegistry) {
  db.insert(projects).values({ name: "attn-proj" }).run();
  const approval = db
    .insert(tasks)
    .values({ projectId: 1, prompt: "Please review\nmore detail", status: "pending_approval" })
    .returning()
    .get()!;
  const running = db
    .insert(tasks)
    .values({ projectId: 1, prompt: "run", status: "running" })
    .returning()
    .get()!;
  const session = fakeSession([
    { tool: "Bash", requestId: "r1", createdAt: new Date("2099-01-01T00:00:00Z") },
    { tool: "Edit", requestId: "r2", createdAt: new Date("2099-02-01T00:00:00Z") },
  ]);
  registry.addTaskSession(running.id, session);
  return { approvalId: approval.id, runningId: running.id, session };
}

describe("collectAttentionItems", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an empty array when the DB and registry are both empty", () => {
    const { db, sqlite } = createTestDb();
    const items = collectAttentionItems(db, new FakeRegistry());
    expect(items).toEqual([]);
    sqlite.close();
  });

  it("surfaces one task_approval item per pending_approval task", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    const { approvalId } = seedAttentionFixture(db, registry);
    const items = collectAttentionItems(db, registry);
    const approvals = items.filter((i) => i.kind === "task_approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "task_approval", taskId: approvalId, projectId: 1 });
    sqlite.close();
  });

  it("emits one attention item per pending permission on an active session", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    const { runningId } = seedAttentionFixture(db, registry);
    const items = collectAttentionItems(db, registry);
    const perms = items.filter((i) => i.kind === "task_permission");
    expect(perms).toHaveLength(2);
    expect(perms.every((p) => p.kind === "task_permission" && p.taskId === runningId)).toBe(true);
    expect(perms.map((p) => (p as Extract<AttentionItem, { kind: "task_permission" }>).tool).sort()).toEqual(["Bash", "Edit"]);
    sqlite.close();
  });

  it("skips a session whose pendingPermissionEntries throws and logs a warning", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    seedAttentionFixture(db, registry);
    registry.addTaskSession(999, brokenSession());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = collectAttentionItems(db, registry);
    expect(items.filter((i) => i.kind === "task_permission")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping task session 999"),
      expect.any(Error),
    );
    sqlite.close();
  });

  it("surfaces one chat_approval item per chat with requires_approval=1 AND approval_status='pending'", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    db.insert(projects).values({ name: "chat-proj" }).run();
    // 1. pending — should surface
    const pending = db
      .insert(chats)
      .values({ projectId: 1, title: "Review me", requiresApproval: true, approvalStatus: "pending" })
      .returning()
      .get()!;
    // 2. approved — should NOT surface
    db.insert(chats)
      .values({ projectId: 1, title: "Already approved", requiresApproval: true, approvalStatus: "approved" })
      .run();
    // 3. requires_approval=false — should NOT surface even if approvalStatus='pending'
    db.insert(chats)
      .values({ projectId: 1, title: "Not tracked", requiresApproval: false, approvalStatus: "pending" })
      .run();
    // 4. projectId=null — should still surface (chats support workspace-level / unattached)
    const unattached = db
      .insert(chats)
      .values({ projectId: null, title: "Unattached", requiresApproval: true, approvalStatus: "pending" })
      .returning()
      .get()!;

    const items = collectAttentionItems(db, registry);
    const approvals = items.filter((i) => i.kind === "chat_approval");
    expect(approvals).toHaveLength(2);
    const byId = new Map(
      approvals.map((a) => [a.kind === "chat_approval" ? a.chatId : -1, a]),
    );
    expect(byId.get(pending.id)).toMatchObject({
      kind: "chat_approval",
      chatId: pending.id,
      projectId: 1,
      title: "Review me",
    });
    expect(byId.get(unattached.id)).toMatchObject({
      kind: "chat_approval",
      chatId: unattached.id,
      projectId: null,
      title: "Unattached",
    });
    sqlite.close();
  });

  it("chat_approval falls back to empty title when chats.title is null", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    db.insert(projects).values({ name: "chat-proj" }).run();
    db.insert(chats)
      .values({ projectId: 1, title: null, requiresApproval: true, approvalStatus: "pending" })
      .run();
    const items = collectAttentionItems(db, registry);
    const approvals = items.filter((i) => i.kind === "chat_approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "chat_approval", title: "" });
    sqlite.close();
  });

  it("sorts items by `since` descending (newest blocker first)", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    seedAttentionFixture(db, registry);
    const items = collectAttentionItems(db, registry);
    expect(items.length).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].since >= items[i].since).toBe(true);
    }
    sqlite.close();
  });
});
