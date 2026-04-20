import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { aiProviderKeys } from "../../db/schema.js";
import Database from "better-sqlite3";
import * as config from "../../config.js";

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
  sqlite.exec("DELETE FROM ai_provider_keys;");
});

describe("/meta/defaults", () => {
  let stored: { defaultModel?: string | null; defaultKeyId?: number | null };

  beforeEach(() => {
    stored = {};
    vi.spyOn(config, "getDefaultModel").mockImplementation(
      () => (stored.defaultModel as string | undefined) ?? "claude-sonnet-4-6",
    );
    vi.spyOn(config, "getDefaultKeyId").mockImplementation(
      () => (typeof stored.defaultKeyId === "number" ? stored.defaultKeyId : null),
    );
    vi.spyOn(config, "setGlobalDefaults").mockImplementation((input) => {
      if (input.defaultModel !== undefined) {
        if (input.defaultModel === null || input.defaultModel === "") {
          delete stored.defaultModel;
        } else {
          stored.defaultModel = input.defaultModel;
        }
      }
      if (input.defaultKeyId !== undefined) {
        if (input.defaultKeyId === null) {
          delete stored.defaultKeyId;
        } else {
          stored.defaultKeyId = input.defaultKeyId;
        }
      }
    });
  });

  it("GET /meta exposes keyId in defaults block", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.defaults.keyId).toBeNull();
  });

  it("PATCH updates defaultModel", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "claude-opus-4-7" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("claude-opus-4-7");
    expect(stored.defaultModel).toBe("claude-opus-4-7");
  });

  it("PATCH clears defaultModel when set to null", async () => {
    stored.defaultModel = "claude-opus-4-7";
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: null }),
    });
    expect(res.status).toBe(200);
    expect(stored.defaultModel).toBeUndefined();
  });

  it("PATCH validates defaultKeyId exists", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: 999 }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH accepts existing keyId", async () => {
    const inserted = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", label: "default-key", priority: 0,
    } as any).returning().get()!;

    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: inserted.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyId).toBe(inserted.id);
    expect(stored.defaultKeyId).toBe(inserted.id);
  });

  it("PATCH rejects non-integer defaultKeyId", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultKeyId: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects empty body", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects malformed JSON", async () => {
    const res = await app.request("/meta/defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{ broken",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /meta", () => {
  it("returns agents array with claude-code entry", async () => {
    const res = await app.request("/meta");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    const claude = body.agents.find((a: any) => a.id === "claude-code");
    expect(claude).toBeDefined();
    expect(claude.name).toBe("Claude Code");
    expect(typeof claude.available).toBe("boolean");
  });

  it("returns defaults with model, planningModel, agent", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.defaults).toBeDefined();
    expect(typeof body.defaults.model).toBe("string");
    expect(typeof body.defaults.planningModel).toBe("string");
    expect(typeof body.defaults.agent).toBe("string");
  });

  it("returns keys array from DB, sorted by priority desc", async () => {
    db.insert(aiProviderKeys).values([
      { provider: "anthropic", providerType: "api_key", label: "A", priority: 1 },
      { provider: "openai", providerType: "api_key", label: "B", priority: 5 },
    ] as any).run();

    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.keys).toHaveLength(2);
    // High priority first
    expect(body.keys[0].name).toBe("B");
    expect(body.keys[1].name).toBe("A");
  });

  it("falls back to 'Key #<id>' label when label empty", async () => {
    const inserted = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "api_key", label: null, priority: 0,
    } as any).returning().get()!;

    const res = await app.request("/meta");
    const body = await res.json();
    expect(body.keys[0].name).toBe(`Key #${inserted.id}`);
    expect(body.keys[0].isActive).toBe(true);
  });

  it("returns models array (may be empty if claude-code unavailable)", async () => {
    const res = await app.request("/meta");
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    // If models present, validate shape
    for (const m of body.models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.name).toBe("string");
      expect(m.agent).toBe("claude-code");
    }
  });
});

describe("/meta/remote-servers", () => {
  type StoredServer = { id: string; name: string; url: string; token?: string };
  let stored: StoredServer[];

  beforeEach(() => {
    stored = [];
    vi.spyOn(config, "getRemoteServers").mockImplementation(() => stored.slice());
    vi.spyOn(config, "addRemoteServer").mockImplementation((input) => {
      const server: StoredServer = {
        id: `srv-${stored.length + 1}`,
        name: input.name,
        url: input.url.replace(/\/$/, ""),
        token: input.token || undefined,
      };
      stored.push(server);
      return server;
    });
    vi.spyOn(config, "updateRemoteServer").mockImplementation((id, input) => {
      const idx = stored.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      const cur = stored[idx];
      const next: StoredServer = {
        id: cur.id,
        name: input.name !== undefined ? input.name : cur.name,
        url: input.url !== undefined ? input.url.replace(/\/$/, "") : cur.url,
        token:
          input.token === null
            ? undefined
            : input.token !== undefined
              ? input.token || undefined
              : cur.token,
      };
      stored[idx] = next;
      return next;
    });
    vi.spyOn(config, "deleteRemoteServer").mockImplementation((id) => {
      const before = stored.length;
      stored = stored.filter((s) => s.id !== id);
      return stored.length < before;
    });
  });

  it("lists remote servers without tokens", async () => {
    stored.push({ id: "srv-1", name: "Prod", url: "https://example.com", token: "secret-1234" });
    const res = await app.request("/meta/remote-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: "srv-1", name: "Prod", url: "https://example.com", hasToken: true },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-1234");
  });

  it("adds a remote server and trims trailing slash", async () => {
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dev", url: "http://10.0.0.2:52077/", token: "tok-abc" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Dev");
    expect(body.url).toBe("http://10.0.0.2:52077");
    expect(body.hasToken).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0].token).toBe("tok-abc");
  });

  it("rejects invalid URLs", async () => {
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a remote server", async () => {
    stored.push({ id: "srv-1", name: "Old", url: "http://old.local" });
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New", token: "t-123" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("New");
    expect(body.hasToken).toBe(true);
    expect(stored[0].token).toBe("t-123");
  });

  it("returns 404 when updating unknown server", async () => {
    const res = await app.request("/meta/remote-servers/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes a remote server", async () => {
    stored.push({ id: "srv-1", name: "Doomed", url: "http://doomed.local" });
    const res = await app.request("/meta/remote-servers/srv-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(0);
  });

  it("hands the token to the proxy-token endpoint", async () => {
    stored.push({ id: "srv-1", name: "Prod", url: "https://example.com", token: "secret" });
    const res = await app.request("/meta/remote-servers/srv-1/proxy-token", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: "secret" });
  });

  it("returns null token when none is configured", async () => {
    stored.push({ id: "srv-1", name: "Prod", url: "https://example.com" });
    const res = await app.request("/meta/remote-servers/srv-1/proxy-token", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: null });
  });

  it("returns 404 for proxy-token of unknown server", async () => {
    const res = await app.request("/meta/remote-servers/missing/proxy-token", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST rejects malformed JSON body", async () => {
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects empty/missing name", async () => {
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", url: "https://x.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects non-string token", async () => {
    const res = await app.request("/meta/remote-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", url: "https://x.com", token: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects malformed JSON body", async () => {
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{ oops",
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects empty string name", async () => {
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects invalid URL", async () => {
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "ftp://nope.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects non-string non-null token", async () => {
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH accepts null token to clear it", async () => {
    stored.push({ id: "srv-1", name: "X", url: "https://x.com", token: "t" });
    const res = await app.request("/meta/remote-servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasToken).toBe(false);
  });

  it("DELETE returns 404 for unknown server", async () => {
    const res = await app.request("/meta/remote-servers/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
