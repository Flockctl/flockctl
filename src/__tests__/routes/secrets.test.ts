import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, secrets } from "../../db/schema.js";
import { _resetMasterKeyCache } from "../../services/secrets.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let homeBase: string;
let origEnv: string | undefined;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  origEnv = process.env.FLOCKCTL_HOME;
  homeBase = mkdtempSync(join(tmpdir(), "flockctl-secrets-route-"));
  process.env.FLOCKCTL_HOME = homeBase;
});

afterAll(() => {
  sqlite.close();
  if (origEnv === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origEnv;
  try { rmSync(homeBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  db.delete(secrets).run();
  db.delete(projects).run();
  db.delete(workspaces).run();
  _resetMasterKeyCache();
});

describe("GET /secrets/global", () => {
  it("returns an empty list initially", async () => {
    const res = await app.request("/secrets/global");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [] });
  });

  it("lists global secrets without the encrypted value", async () => {
    await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A", value: "v", description: "d" }),
    });
    const res = await app.request("/secrets/global");
    const body = await res.json();
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]).toEqual(expect.objectContaining({ name: "A", description: "d", scope: "global" }));
    expect(body.secrets[0].value).toBeUndefined();
    expect(body.secrets[0].valueEncrypted).toBeUndefined();
  });
});

describe("POST /secrets/global", () => {
  it("creates a global secret and returns the sanitized record", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TOKEN", value: "super-secret" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("TOKEN");
    expect(body.scope).toBe("global");
    expect(body.value).toBeUndefined();
  });

  it("returns 422 when name is missing", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "v" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when value is missing", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "T" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 500 when name is not identifier-like", async () => {
    // Service throws a generic Error — goes through default error handler as 500
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "1bad", value: "v" }),
    });
    expect(res.status).toBe(500);
  });

  it("upserts when the same name is POSTed twice", async () => {
    await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "K", value: "one" }),
    });
    await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "K", value: "two" }),
    });
    const res = await app.request("/secrets/global");
    const body = await res.json();
    expect(body.secrets).toHaveLength(1);
  });
});

describe("DELETE /secrets/global/:name", () => {
  it("returns 404 when the secret is missing", async () => {
    const res = await app.request("/secrets/global/NOPE", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes an existing secret", async () => {
    await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", value: "v" }),
    });
    const res = await app.request("/secrets/global/X", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });
});

describe("workspace-scoped secrets", () => {
  it("returns 404 for a missing workspace on GET", async () => {
    const res = await app.request("/secrets/workspaces/9999");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing workspace on POST", async () => {
    const res = await app.request("/secrets/workspaces/9999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", value: "v" }),
    });
    expect(res.status).toBe(404);
  });

  it("round-trips a workspace secret", async () => {
    const ws = db.insert(workspaces).values({ name: "ws", path: "/tmp/ws-sr" }).returning().get();
    const postRes = await app.request(`/secrets/workspaces/${ws.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TOKEN", value: "ws-val" }),
    });
    expect(postRes.status).toBe(200);

    const listRes = await app.request(`/secrets/workspaces/${ws.id}`);
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.secrets.map((s: any) => s.name)).toEqual(["TOKEN"]);

    const delRes = await app.request(`/secrets/workspaces/${ws.id}/TOKEN`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
  });
});

describe("project-scoped secrets", () => {
  it("returns 404 for a missing project on GET", async () => {
    const res = await app.request("/secrets/projects/9999");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing project on POST", async () => {
    const res = await app.request("/secrets/projects/9999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", value: "v" }),
    });
    expect(res.status).toBe(404);
  });

  it("round-trips a project secret", async () => {
    const ws = db.insert(workspaces).values({ name: "ws", path: "/tmp/ws-sp" }).returning().get();
    const p = db.insert(projects).values({ workspaceId: ws.id, name: "p", path: "/tmp/ws-sp/p" }).returning().get();

    const postRes = await app.request(`/secrets/projects/${p.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "K", value: "p-val", description: "project-token" }),
    });
    expect(postRes.status).toBe(200);
    const body = await postRes.json();
    expect(body.scope).toBe("project");
    expect(body.scopeId).toBe(p.id);

    const listRes = await app.request(`/secrets/projects/${p.id}`);
    const listBody = await listRes.json();
    expect(listBody.secrets).toHaveLength(1);
    expect(listBody.secrets[0].description).toBe("project-token");

    const delRes = await app.request(`/secrets/projects/${p.id}/K`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const after = await app.request(`/secrets/projects/${p.id}`);
    expect((await after.json()).secrets).toEqual([]);
  });

  it("returns 404 (invalid id) when workspace id is non-numeric", async () => {
    const res = await app.request("/secrets/workspaces/not-a-number");
    // parseInt → NaN → Number.isFinite false → ValidationError → 422
    expect(res.status).toBe(422);
  });

  it("returns 422 when project id is non-numeric", async () => {
    const res = await app.request("/secrets/projects/not-a-number");
    expect(res.status).toBe(422);
  });

  it("POST global returns 422 when body is a scalar", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not-an-object"),
    });
    expect(res.status).toBe(422);
  });

  it("POST global accepts description as non-string (normalized to null)", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NUM_DESC", value: "v", description: 42 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBeNull();
  });

  it("POST global normalizes missing description to null", async () => {
    const res = await app.request("/secrets/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NO_DESC", value: "v" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBeNull();
  });
});
