import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let fkProjA: number;
let fkProjB: number;
let fkProjC: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  fkProjA = db.insert(projects).values({ name: "fk-a" }).returning().get()!.id;
  fkProjB = db.insert(projects).values({ name: "fk-b" }).returning().get()!.id;
  fkProjC = db.insert(projects).values({ name: "fk-c" }).returning().get()!.id;
});

afterAll(() => {
  sqlite.close();
});

describe("Templates routes", () => {
  it("GET /templates returns empty list", async () => {
    const res = await app.request("/templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("POST /templates creates a template", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Run Tests",
        description: "Run all tests",
        prompt: "Execute npm test",
        model: "claude-sonnet-4-20250514",
      }),
    });
    expect(res.status).toBe(201);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("Run Tests");
  });

  it("GET /templates/:id returns template", async () => {
    const res = await app.request("/templates/1");
    expect(res.status).toBe(200);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("Run Tests");
    expect(tmpl.model).toBe("claude-sonnet-4-20250514");
  });

  it("PATCH /templates/:id updates template", async () => {
    const res = await app.request("/templates/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Run All Tests" }),
    });
    expect(res.status).toBe(200);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("Run All Tests");
  });

  it("DELETE /templates/:id deletes template", async () => {
    const delRes = await app.request("/templates/1", { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request("/templates/1");
    expect(getRes.status).toBe(404);
  });

  it("POST /templates requires name", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no name" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /templates with all optional fields populates each", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Full Template",
        description: "desc",
        prompt: "p",
        agent: "claude-code",
        model: "claude-sonnet-4-6",
        image: "ubuntu:22.04",
        workingDir: "/work",
        envVars: { FOO: "bar" },
        timeoutSeconds: 600,
        labelSelector: "team=backend",
        projectId: fkProjA,
        assignedKeyId: null,
      }),
    });
    expect(res.status).toBe(201);
    const tmpl = await res.json();
    expect(tmpl.name).toBe("Full Template");
    expect(tmpl.image).toBe("ubuntu:22.04");
    expect(tmpl.envVars).toBe(JSON.stringify({ FOO: "bar" }));

    const patchRes = await app.request(`/templates/${tmpl.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated",
        description: "new",
        prompt: "p2",
        agent: "openai",
        model: "gpt-x",
        image: "node:20",
        workingDir: "/repo",
        envVars: { BAZ: "qux" },
        timeoutSeconds: 30,
        labelSelector: "team=ops",
        projectId: fkProjB,
        assignedKeyId: null,
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.name).toBe("Updated");
    expect(patched.workingDir).toBe("/repo");
    expect(patched.envVars).toBe(JSON.stringify({ BAZ: "qux" }));
  });

  it("PATCH /templates with envVars cleared sets envVars null", async () => {
    const created = await (await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ClearEnv", envVars: { A: "1" } }),
    })).json();

    const res = await app.request(`/templates/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: null }),
    });
    expect(res.status).toBe(200);
    const patched = await res.json();
    expect(patched.envVars).toBeNull();
  });

  it("PATCH /templates returns 404 for missing template", async () => {
    const res = await app.request("/templates/99999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /templates returns 404 for missing template", async () => {
    const res = await app.request("/templates/99999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /templates filters by project_id", async () => {
    const proj = await (await app.request("/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "PjScoped", projectId: fkProjC }),
    })).json();

    const res = await app.request(`/templates?project_id=${fkProjC}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.find((t: any) => t.id === proj.id)).toBeDefined();
    expect(body.items.every((t: any) => t.projectId === fkProjC)).toBe(true);
  });
});
