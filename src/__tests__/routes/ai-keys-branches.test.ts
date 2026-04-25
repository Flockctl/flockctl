import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM ai_provider_keys;`);
});

describe("ai-keys routes — branch gaps", () => {
  it("POST /keys rejects missing providerType (422)", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /keys rejects github_copilot with empty-string keyValue", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github_copilot",
        providerType: "oauth",
        keyValue: "",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /keys rejects github_copilot with whitespace-only keyValue", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github_copilot",
        providerType: "oauth",
        keyValue: "   ",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /keys rejects github_copilot with non-string keyValue (422)", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github_copilot",
        providerType: "oauth",
        keyValue: 12345,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /keys applies default priority=0 when omitted", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude_cli",
        providerType: "claude-agent-sdk",
        label: "default-priority",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.priority).toBe(0);
    expect(body.isActive).toBe(true); // default
  });

  it("POST /keys respects explicit isActive=false", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude_cli",
        providerType: "claude-agent-sdk",
        isActive: false,
      }),
    });
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  it("GET /keys paginates respecting per_page", async () => {
    for (let i = 0; i < 5; i++) {
      db.insert(schema.aiProviderKeys).values({
        provider: "claude_cli",
        providerType: "claude-agent-sdk",
        label: `k${i}`,
      } as any).run();
    }
    const res = await app.request("/keys?per_page=2");
    const body = await res.json();
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(5);
  });

  it("GET /keys redacts non-null keyValue and returns null when keyValue is null", async () => {
    db.insert(schema.aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", keyValue: "sk-ant-abcdef1234567890",
    } as any).run();
    db.insert(schema.aiProviderKeys).values({
      provider: "claude_cli", providerType: "claude-agent-sdk", keyValue: null,
    } as any).run();
    const res = await app.request("/keys");
    const body = await res.json();
    const withKey = body.items.find((k: any) => k.provider === "anthropic");
    expect(withKey.keyValue).toContain("...");
    expect(withKey.key_suffix).toMatch(/.{4}/);
    const noKey = body.items.find((k: any) => k.provider === "claude_cli");
    expect(noKey.keyValue).toBeNull();
    expect(noKey.key_suffix).toBeNull();
  });

  it("PATCH /keys/:id 404 when key missing", async () => {
    const res = await app.request("/keys/999999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /keys/:id with only priority leaves other fields intact", async () => {
    const k = db.insert(schema.aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", label: "stay",
      keyValue: "sk-ant-unchanged-123456",
    } as any).returning().get()!;
    const res = await app.request(`/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe("stay");
    expect(body.priority).toBe(7);
  });

  it("PATCH /keys/:id can clear keyValue to null (redacted null on response)", async () => {
    const k = db.insert(schema.aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key",
      keyValue: "sk-ant-aboutToClear-999",
    } as any).returning().get()!;
    const res = await app.request(`/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyValue: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyValue).toBeNull();
    expect(body.key_suffix).toBeNull();
  });

  it("PATCH /keys/:id returns is_active=false when isActive explicitly null/false", async () => {
    const k = db.insert(schema.aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", isActive: true,
    } as any).returning().get()!;
    const res = await app.request(`/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    const body = await res.json();
    expect(body.is_active).toBe(false);
  });

  it("DELETE /keys/:id 404 when missing", async () => {
    const res = await app.request("/keys/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /keys/:id 404 when id is out of range", async () => {
    const res = await app.request("/keys/999999");
    expect(res.status).toBe(404);
  });

  it("GET /keys/:id/identity 404 when key missing", async () => {
    const res = await app.request("/keys/999999/identity");
    expect(res.status).toBe(404);
  });

  it("GET /keys/:id/identity returns unsupported=false marker for non-claude_cli provider", async () => {
    const k = db.insert(schema.aiProviderKeys).values({
      provider: "github_copilot", providerType: "oauth", keyValue: "gho_x1234567890",
    } as any).returning().get()!;
    const res = await app.request(`/keys/${k.id}/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supported).toBe(false);
    expect(body.loggedIn).toBe(false);
    expect(body.reason).toContain("claude_cli");
  });

  it("GET /keys/providers lists claude_cli and github_copilot", async () => {
    const res = await app.request("/keys/providers");
    const body = await res.json();
    expect(body.claude_cli).toBeDefined();
    expect(body.github_copilot).toBeDefined();
  });

  it("GET /keys/claude-cli/status returns ready fields", async () => {
    const res = await app.request("/keys/claude-cli/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("installed");
    expect(body).toHaveProperty("authenticated");
    expect(body).toHaveProperty("ready");
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("GET /keys/copilot/status returns ready fields", async () => {
    const res = await app.request("/keys/copilot/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("installed");
    expect(body).toHaveProperty("authenticated");
    expect(body).toHaveProperty("ready");
    expect(Array.isArray(body.models)).toBe(true);
  });
});
