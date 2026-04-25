import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

// Mock the identity helper before the server is imported — the route `await
// import`s the module, so hoisted vi.mock is the cleanest way to intercept.
vi.mock("../../services/claude/identity", () => ({
  getClaudeIdentity: vi.fn(),
}));

import { app } from "../../server.js";
import { getClaudeIdentity } from "../../services/claude/identity.js";
import { getDb } from "../../db/index.js";
import { aiProviderKeys } from "../../db/schema.js";

const mockIdentity = getClaudeIdentity as unknown as ReturnType<typeof vi.fn>;

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
  mockIdentity.mockReset();
});

describe("GET /keys/:id/identity", () => {
  it("returns 404 when the key does not exist", async () => {
    const res = await app.request("/keys/99999/identity");
    expect(res.status).toBe(404);
  });

  it("returns { supported: false } for non-claude_cli providers without calling the resolver", async () => {
    const { id } = getDb().insert(aiProviderKeys).values({
      provider: "github_copilot",
      providerType: "copilot-sdk",
      label: "Copilot",
      keyValue: "ghp_sample",
    }).returning().get();

    const res = await app.request(`/keys/${id}/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supported).toBe(false);
    expect(body.loggedIn).toBe(false);
    expect(body.reason).toContain("claude_cli");
    expect(mockIdentity).not.toHaveBeenCalled();
  });

  it("forwards configDir to the resolver and returns its profile for a claude_cli key", async () => {
    const { id } = getDb().insert(aiProviderKeys).values({
      provider: "claude_cli",
      providerType: "claude-agent-sdk",
      label: "Personal",
      configDir: "~/.claude-personal",
    }).returning().get();

    mockIdentity.mockResolvedValueOnce({
      loggedIn: true,
      email: "personal@example.com",
      accountUuid: "acct-1",
      organizationUuid: "org-1",
      organizationName: "personal@example.com's Organization",
      organizationType: "claude_max",
      rateLimitTier: "default_claude_max_20x",
      hasClaudeMax: true,
      hasClaudePro: false,
      subscriptionStatus: "active",
    });

    const res = await app.request(`/keys/${id}/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      supported: true,
      loggedIn: true,
      email: "personal@example.com",
      accountUuid: "acct-1",
      organizationUuid: "org-1",
      organizationName: "personal@example.com's Organization",
      organizationType: "claude_max",
      rateLimitTier: "default_claude_max_20x",
      hasClaudeMax: true,
      hasClaudePro: false,
      subscriptionStatus: "active",
    });

    expect(mockIdentity).toHaveBeenCalledOnce();
    expect(mockIdentity).toHaveBeenCalledWith("~/.claude-personal");
  });

  it("forwards null configDir (default ~/.claude) verbatim", async () => {
    const { id } = getDb().insert(aiProviderKeys).values({
      provider: "claude_cli",
      providerType: "claude-agent-sdk",
      label: "Default",
      configDir: null,
    }).returning().get();

    mockIdentity.mockResolvedValueOnce({ loggedIn: false, error: "anthropic returned HTTP 401" });

    const res = await app.request(`/keys/${id}/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supported).toBe(true);
    expect(body.loggedIn).toBe(false);
    expect(body.error).toBe("anthropic returned HTTP 401");
    expect(mockIdentity).toHaveBeenCalledWith(null);
  });
});
