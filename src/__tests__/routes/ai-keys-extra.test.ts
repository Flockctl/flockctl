import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

// Mock claude-cli before app is imported
vi.mock("../../services/claude-cli", async () => {
  const actual = await vi.importActual<any>("../../services/claude-cli");
  return {
    ...actual,
    isClaudeBinaryPresent: vi.fn(() => true),
    isClaudeCodeAuthed: vi.fn(() => true),
    isClaudeCodeReady: vi.fn(() => true),
    CLAUDE_CODE_MODELS: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }],
  };
});

import { app } from "../../server.js";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => sqlite.close());

beforeEach(() => {
  sqlite.exec(`DELETE FROM ai_provider_keys;`);
});

describe("AI Keys — /keys/claude-cli/status", () => {
  it("returns readiness flags and model ids", async () => {
    const res = await app.request("/keys/claude-cli/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(true);
    expect(body.authenticated).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.models).toContain("claude-opus-4-7");
  });
});

