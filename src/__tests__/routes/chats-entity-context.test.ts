import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, chats, workspaces } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Capture AgentSession ctor args so the test can assert the prompt.
const agentSessionCalls: Array<{ opts: any }> = [];

vi.mock("../../services/agent-session/index", async () => {
  const { EventEmitter } = await import("events");
  class MockAgentSession extends EventEmitter {
    opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
      agentSessionCalls.push({ opts });
    }
    async run() {
      this.emit("text", "ack");
      this.emit("usage", {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
      });
      this.emit("session_id", "sess-mock");
    }
    abort() { /* no-op */ }
    resolvePermission() { return false; }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

describe("Chats — entity-aware system prompt (stream handler)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let projectPath: string;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    projectPath = join(tmpdir(), `flockctl-test-entity-prompt-${process.pid}`);
    // Create a plan tree: one milestone + one slice + one task file.
    const milestoneDir = join(projectPath, ".flockctl", "plan", "01-cool-milestone");
    const sliceDir = join(milestoneDir, "02-cool-slice");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(milestoneDir, "milestone.md"),
      "---\ntitle: Cool Milestone\nstatus: pending\n---\n\n## Vision\n\nA milestone about coolness.\n",
    );
    writeFileSync(
      join(sliceDir, "slice.md"),
      "---\ntitle: Cool Slice\nstatus: pending\n---\n\nSlice body.\n",
    );
    writeFileSync(
      join(sliceDir, "03-cool-task.md"),
      "---\ntitle: Cool Task\nstatus: pending\n---\n\nTask body.\n",
    );

    const p = testDb.db.insert(projects).values({
      name: "Entity Prompt Project",
      path: projectPath,
    }).returning().get()!;
    projectId = p.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("prepends entity-aware prompt when chat row has entityType/entityId (milestone)", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({
      projectId,
      entityType: "milestone",
      entityId: "01-cool-milestone",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("Entity Prompt Project");
    expect(prompt).toContain("milestone");
    expect(prompt).toContain("01-cool-milestone");
    expect(prompt).toContain("Cool Milestone");
    // Default base is appended after the entity prompt.
    expect(prompt.endsWith("You are a helpful AI assistant.")).toBe(true);
  });

  it("resolves slice parent milestone by walking plan dir", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({
      projectId,
      entityType: "slice",
      entityId: "02-cool-slice",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("slice");
    expect(prompt).toContain("02-cool-slice");
    expect(prompt).toContain("Cool Slice");
  });

  it("resolves task parent milestone+slice by walking plan dir", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({
      projectId,
      entityType: "task",
      entityId: "03-cool-task",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("task");
    expect(prompt).toContain("03-cool-task");
    expect(prompt).toContain("Cool Task");
  });

  it("explicit body.system overrides the entity-aware prompt", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({
      projectId,
      entityType: "milestone",
      entityId: "01-cool-milestone",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hi",
        system: "You are a code reviewer.",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // body.system wins — no entity prompt leaks through.
    expect(agentSessionCalls[0].opts.systemPromptOverride).toBe("You are a code reviewer.");
  });

  it("falls back to default base when chat has no entity and no body.system", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(agentSessionCalls[0].opts.systemPromptOverride).toBe("You are a helpful AI assistant.");
  });

  it("missing entity file still produces a prompt referencing the entity ids", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({
      projectId,
      entityType: "milestone",
      entityId: "99-does-not-exist",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("99-does-not-exist");
    // No file content block when the .md is missing.
    expect(prompt).not.toContain("Current milestone file content:");
  });
});

describe("Chats — entity-scoped POST is idempotent", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    const p = testDb.db.insert(projects).values({
      name: "Idempotent Entity Project",
      path: join(tmpdir(), `flockctl-test-idempotent-${process.pid}`),
    }).returning().get()!;
    projectId = p.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
  });

  it("POST /chats returns the same chat row for repeat {projectId, entityType, entityId}", async () => {
    // First POST creates; returns 201.
    const res1 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        entityType: "milestone",
        entityId: "idem-milestone-1",
      }),
    });
    expect(res1.status).toBe(201);
    const chat1 = await res1.json() as { id: number };

    // Second POST with identical triple must NOT create a new row.
    const res2 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        entityType: "milestone",
        entityId: "idem-milestone-1",
      }),
    });
    expect(res2.status).toBe(200);
    const chat2 = await res2.json() as { id: number };

    expect(chat2.id).toBe(chat1.id);

    // And only ONE row exists in the DB for this triple.
    const rows = testDb.db.select().from(chats).all();
    const matching = rows.filter(
      (r) => r.projectId === projectId && r.entityType === "milestone" && r.entityId === "idem-milestone-1",
    );
    expect(matching).toHaveLength(1);
  });

  it("different entityId under same project creates a separate chat", async () => {
    const res1 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, entityType: "slice", entityId: "slice-a" }),
    });
    const chat1 = await res1.json() as { id: number };

    const res2 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, entityType: "slice", entityId: "slice-b" }),
    });
    const chat2 = await res2.json() as { id: number };

    expect(chat2.id).not.toBe(chat1.id);
  });

  it("without entity triple, each POST creates a fresh row (non-idempotent)", async () => {
    const res1 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const chat1 = await res1.json() as { id: number };

    const res2 = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const chat2 = await res2.json() as { id: number };

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(chat2.id).not.toBe(chat1.id);
  });

  it("GET /chats filter returns the same existing chat on repeated lookup", async () => {
    // Seed one chat via POST (idempotent create).
    const create = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        entityType: "task",
        entityId: "task-lookup",
      }),
    });
    const { id: createdId } = await create.json() as { id: number };

    const qs = `project_id=${projectId}&entity_type=task&entity_id=task-lookup`;
    const res1 = await app.request(`/chats?${qs}`);
    const body1 = await res1.json() as { items: Array<{ id: number }>; total: number };

    const res2 = await app.request(`/chats?${qs}`);
    const body2 = await res2.json() as { items: Array<{ id: number }>; total: number };

    expect(body1.total).toBe(1);
    expect(body2.total).toBe(1);
    expect(body1.items[0].id).toBe(createdId);
    expect(body2.items[0].id).toBe(createdId);
  });
});

describe("Chats — workspace-aware system prompt (stream handler)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let workspaceId: number;
  let workspacePath: string;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    workspacePath = join(tmpdir(), `flockctl-test-ws-prompt-${process.pid}`);
    mkdirSync(workspacePath, { recursive: true });

    const ws = testDb.db.insert(workspaces).values({
      name: "Demo Workspace",
      path: workspacePath,
      description: "A workspace for the test",
    }).returning().get()!;
    workspaceId = ws.id;

    testDb.db.insert(projects).values({
      workspaceId,
      name: "Alpha",
      path: join(workspacePath, "alpha"),
      description: "First project",
    }).run();
    testDb.db.insert(projects).values({
      workspaceId,
      name: "Beta",
      path: join(workspacePath, "beta"),
    }).run();
    // Unrelated project (different workspace) must not leak into the prompt.
    testDb.db.insert(projects).values({
      name: "Orphan",
      path: join(tmpdir(), "flockctl-orphan"),
    }).run();
  });

  afterAll(() => {
    testDb.sqlite.close();
    try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("lists workspace projects in the system prompt for a workspace-only chat", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ workspaceId }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("Demo Workspace");
    expect(prompt).toContain(workspacePath);
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain(join(workspacePath, "alpha"));
    expect(prompt).toContain("First project");
    expect(prompt).toContain("Beta");
    expect(prompt).toContain(join(workspacePath, "beta"));
    expect(prompt).not.toContain("Orphan");
    expect(prompt.endsWith("You are a helpful AI assistant.")).toBe(true);
  });

  it("explicit body.system still overrides the workspace prompt", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ workspaceId }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi", system: "You are a code reviewer." }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(agentSessionCalls[0].opts.systemPromptOverride).toBe("You are a code reviewer.");
  });

  it("entity prompt wins over workspace prompt when both are present", async () => {
    agentSessionCalls.length = 0;

    // Seed a project under the workspace with a minimal plan tree so the
    // entity-aware branch can resolve a milestone file.
    const projPath = join(workspacePath, "gamma");
    mkdirSync(join(projPath, ".flockctl", "plan", "01-ws-milestone"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "plan", "01-ws-milestone", "milestone.md"),
      "---\ntitle: WS Milestone\n---\n\nBody.\n",
    );
    const proj = testDb.db.insert(projects).values({
      workspaceId,
      name: "Gamma",
      path: projPath,
    }).returning().get()!;

    const chat = testDb.db.insert(chats).values({
      workspaceId,
      projectId: proj.id,
      entityType: "milestone",
      entityId: "01-ws-milestone",
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const prompt = agentSessionCalls[0].opts.systemPromptOverride as string;
    expect(prompt).toContain("01-ws-milestone");
    expect(prompt).toContain("WS Milestone");
    // Workspace-level listing should NOT appear when the entity branch matched.
    expect(prompt).not.toContain("Projects in this workspace");
  });

  it("threads workspaceContext through AgentSession for workspace chats (stream)", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ workspaceId }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const ctx = agentSessionCalls[0].opts.workspaceContext;
    expect(ctx).toBeDefined();
    expect(ctx.name).toBe("Demo Workspace");
    expect(ctx.path).toBe(workspacePath);
    const names = ctx.projects.map((p: { name: string }) => p.name).sort();
    // Alpha, Beta from the workspace; Gamma seeded in the earlier test. Orphan
    // belongs to no workspace and must not leak.
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
    expect(names).not.toContain("Orphan");
  });

  it("walks up from chat.projectId to the workspace when chat.workspaceId is null (stream)", async () => {
    agentSessionCalls.length = 0;

    const projRow = testDb.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, "Alpha"))
      .get()!;

    // Only projectId is set — workspaceContext must still resolve via the
    // project's workspaceId.
    const chat = testDb.db
      .insert(chats)
      .values({ projectId: projRow.id })
      .returning()
      .get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const ctx = agentSessionCalls[0].opts.workspaceContext;
    expect(ctx).toBeDefined();
    expect(ctx.name).toBe("Demo Workspace");
  });

  it("non-stream POST also resolves workspace prompt + workspaceContext", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ workspaceId }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(201);
    await res.text();

    const opts = agentSessionCalls[0].opts;
    // Non-stream path used to fall back to "You are a helpful AI assistant.";
    // now it must go through resolveChatSystemPrompt like the stream handler.
    expect(opts.systemPromptOverride).toContain("Demo Workspace");
    expect(opts.systemPromptOverride).toContain(workspacePath);
    expect(opts.workspaceContext?.name).toBe("Demo Workspace");
  });
});
