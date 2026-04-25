import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ai-client so the ClaudeCodeProvider hands back a stub chat() we can
// inspect; the same pattern the other agent-session tests use.
vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({ chat: vi.fn() })),
}));

import { AgentSession } from "../../services/agent-session/index.js";
import { createAIClient } from "../../services/ai/client.js";
import * as incidentsService from "../../services/incidents/service.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb, getDb } from "../../db/index.js";
import { incidents, projects } from "../../db/schema.js";

const mockCreateAIClient = createAIClient as any;

// Seed a distinctive incident so we can assert the retrieval picked it.
function seedMigrationIncident(projectId: number | null = null): void {
  getDb()
    .insert(incidents)
    .values({
      title: "Migration journal desync",
      symptom: "Sqlite migration failed because journal pointed at a missing file.",
      rootCause: "0025_snapshot.json was not added to meta/_journal.json after creation.",
      resolution: "Regenerated the migration journal entry and restarted the daemon.",
      tags: JSON.stringify(["migration", "sqlite", "journal"]),
      projectId,
    })
    .run();
}

describe("AgentSession — past-incident injection", () => {
  let mockChat: any;
  let testDb: ReturnType<typeof createTestDb>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    mockChat = vi.fn().mockResolvedValue({
      text: "Done",
      rawContent: "Done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    closeDb();
  });

  it("appends <past_incidents> block when the user prompt matches stored incidents", async () => {
    seedMigrationIncident();

    const session = new AgentSession({
      chatId: 42,
      prompt: "My migration is broken after adding a new snapshot — help debug the journal.",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
    });

    await session.run();

    expect(mockChat).toHaveBeenCalledTimes(1);
    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).toContain("<past_incidents>");
    expect(system).toContain("## Past incidents");
    expect(system).toContain("Migration journal desync");
    // The markdown-ish body should also include at least one of the
    // populated fields so the model has something to ground on.
    expect(system).toContain("journal");
  });

  it("omits the <past_incidents> block when nothing matches", async () => {
    seedMigrationIncident();

    const session = new AgentSession({
      chatId: 43,
      // Deliberately disjoint vocabulary — every token is novel relative
      // to the seed's symptom/root_cause/resolution so FTS5 produces zero
      // hits (avoid English stopwords that collide against "a", "the", …).
      prompt: "quantum relativity theorem proof",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("<past_incidents>");
    expect(system).not.toContain("Past incidents");
  });

  it("logs incidents.injected count=N with the session ref on every run", async () => {
    seedMigrationIncident();

    const session = new AgentSession({
      taskId: 7,
      prompt: "migration sqlite journal snapshot",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
    });

    await session.run();

    const logLine = logSpy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .find((msg: string) => msg.includes("incidents.injected"));
    expect(logLine).toBeDefined();
    // count=1 because we seeded a single matching row; ref=t7 carries the
    // task scope so log-scraping can correlate with task ids.
    expect(logLine).toContain("count=1");
    expect(logLine).toContain("ref=t7");
  });

  it("tolerates retrieval failures without blocking the session", async () => {
    // Force searchIncidents to throw — the guard must catch it, log a warn,
    // and let the session run to completion without a <past_incidents> block.
    const searchSpy = vi
      .spyOn(incidentsService, "searchIncidents")
      .mockImplementation(() => {
        throw new Error("db closed");
      });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const session = new AgentSession({
      chatId: 99,
      prompt: "anything",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("<past_incidents>");
    // The guard logs a warn with count=0 so ops can see retrieval degraded.
    const warnLine = warnSpy.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .find((msg: string | undefined) => !!msg && msg.includes("incidents.injected"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("count=0");

    warnSpy.mockRestore();
    searchSpy.mockRestore();
  });

  it("passes projectId into the retrieval so cross-project incidents are filtered out", async () => {
    // Two real projects so the incident's FK resolves, then scope the seed
    // to project 1 and search as project 2 — retrieval must filter it out.
    getDb().insert(projects).values({ name: "p1", path: "/tmp/p1" }).run();
    getDb().insert(projects).values({ name: "p2", path: "/tmp/p2" }).run();
    seedMigrationIncident(1);

    const session = new AgentSession({
      chatId: 100,
      prompt: "migration sqlite journal snapshot",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      projectId: 2,
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("Migration journal desync");
  });
});
