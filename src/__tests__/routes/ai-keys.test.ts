import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
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

describe("AI Keys routes", () => {
  it("GET /keys returns empty list", async () => {
    const res = await app.request("/keys");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("POST /keys creates a key", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        providerType: "api_key",
        label: "Test Key",
        keyValue: "sk-ant-api-testkey1234567890",
        priority: 1,
      }),
    });
    expect(res.status).toBe(201);
    const key = await res.json();
    expect(key.id).toBeDefined();
    expect(key.provider).toBe("anthropic");
    expect(key.label).toBe("Test Key");
  });

  it("GET /keys/:id returns key with redacted value", async () => {
    const res = await app.request("/keys/1");
    expect(res.status).toBe(200);
    const key = await res.json();
    expect(key.keyValue).toContain("...");
    expect(key.provider).toBe("anthropic");
  });

  it("GET /keys/:id returns 404 for unknown", async () => {
    const res = await app.request("/keys/999");
    expect(res.status).toBe(404);
  });

  it("PATCH /keys/:id updates key", async () => {
    const res = await app.request("/keys/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Updated Key", priority: 5 }),
    });
    expect(res.status).toBe(200);
    const key = await res.json();
    expect(key.label).toBe("Updated Key");
  });

  it("DELETE /keys/:id deletes key", async () => {
    // Create a key to delete
    await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", providerType: "api_key", keyValue: "sk-test1234567890abcdef" }),
    });
    const delRes = await app.request("/keys/2", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.deleted).toBe(true);

    const getRes = await app.request("/keys/2");
    expect(getRes.status).toBe(404);
  });

  it("GET /keys/providers returns provider list", async () => {
    const res = await app.request("/keys/providers");
    expect(res.status).toBe(200);
  });

  it("POST /keys requires provider", async () => {
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "no provider" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE /keys/:id returns 404 when key does not exist", async () => {
    const res = await app.request("/keys/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("PATCH /keys/:id can toggle isActive false → true", async () => {
    const created = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        providerType: "api_key",
        label: "toggle-key",
        keyValue: "sk-toggleabcdef1234567890",
      }),
    });
    const { id } = await created.json();

    const off = await app.request(`/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.status).toBe(200);
    const offBody = await off.json();
    expect(offBody.is_active).toBe(false);
    expect(offBody.key_suffix).toBe("7890");

    const on = await app.request(`/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    const onBody = await on.json();
    expect(onBody.is_active).toBe(true);
  });

  it("PATCH /keys/:id updates provider, providerType, keyValue, configDir together", async () => {
    const created = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        providerType: "api_key",
        label: "multi-patch",
        keyValue: "sk-ant-api-originalvalue1234",
      }),
    });
    const { id } = await created.json();

    const res = await app.request(`/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        providerType: "oauth",
        keyValue: "sk-newsecretvalue12345",
        configDir: "/tmp/cfg",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("openai");
    expect(body.config_dir).toBe("/tmp/cfg");
    // Key value is redacted in the PATCH response
    expect(body.keyValue).toContain("...");
    expect(body.key_suffix).toBe("2345");
  });

  it("PATCH returns null keyValue & key_suffix when key has no value", async () => {
    const created = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        providerType: "oauth",
        label: "cli-only",
      }),
    });
    const { id } = await created.json();

    const res = await app.request(`/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "renamed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyValue).toBeNull();
    expect(body.key_suffix).toBeNull();
  });
});
