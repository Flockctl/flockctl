import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, tasks } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;
let wsId: number;
let projectId: number;
let taskId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = mkdtempSync(join(tmpdir(), "skills-extra-"));

  const ws = db.insert(workspaces).values({
    name: "ws-extra",
    path: join(tmpBase, "ws"),
  }).returning().get()!;
  wsId = ws.id;

  const p = db.insert(projects).values({
    name: "proj-extra",
    workspaceId: wsId,
    path: join(tmpBase, "proj"),
  }).returning().get()!;
  projectId = p.id;

  const t2 = db.insert(tasks).values({ projectId, prompt: "p" }).returning().get()!;
  taskId = t2.id;
});

afterAll(() => {
  sqlite.close();
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("Skills routes — validation", () => {
  it("rejects skill name with path separators", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../evil", content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects skill name with slashes", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "some/path", content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects skill name equal to '.'", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ".", content: "x" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("Skills routes — global", () => {
  it("GET /skills/global returns array", async () => {
    const res = await app.request("/skills/global");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /skills/resolved by task", async () => {
    const res = await app.request(`/skills/resolved?taskId=${taskId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("Skills — workspace disabled toggle with {name, level}", () => {
  it("POST disables a skill at workspace level", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "planning", level: "global" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toContainEqual({ name: "planning", level: "global" });
  });

  it("POST is idempotent — same entry twice stays once", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "planning", level: "global" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills.filter((e: any) => e.name === "planning" && e.level === "global").length).toBe(1);
  });

  it("GET returns list of disabled skills", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toContainEqual({ name: "planning", level: "global" });
  });

  it("DELETE re-enables a skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "planning", level: "global" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).not.toContainEqual({ name: "planning", level: "global" });
  });

  it("POST requires name", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 for missing workspace", async () => {
    const res = await app.request("/skills/workspaces/9999/disabled");
    expect(res.status).toBe(404);
  });
});

describe("Skills — project disabled toggle with {name, level}", () => {
  it("POST disables a skill at project level", async () => {
    const res = await app.request(`/skills/projects/${projectId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "debugging", level: "project" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toContainEqual({ name: "debugging", level: "project" });
  });

  it("GET lists disabled skills", async () => {
    const res = await app.request(`/skills/projects/${projectId}/disabled`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toContainEqual({ name: "debugging", level: "project" });
  });

  it("DELETE re-enables", async () => {
    const res = await app.request(`/skills/projects/${projectId}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "debugging", level: "project" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).not.toContainEqual({ name: "debugging", level: "project" });
  });

  it("404 for missing project", async () => {
    const res = await app.request("/skills/projects/9999/disabled");
    expect(res.status).toBe(404);
  });
});

// Task-level skill disable routes were removed — skills disables only exist at
// workspace or project level in the new reconciler architecture.

describe("Skills — global POST", () => {
  it("creates a global skill", async () => {
    const originalHome = process.env.FLOCKCTL_HOME;
    process.env.FLOCKCTL_HOME = tmpBase;

    try {
      const res = await app.request("/skills/global", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "global-skill", content: "# G" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("global-skill");
      expect(body.level).toBe("global");
    } finally {
      if (originalHome) process.env.FLOCKCTL_HOME = originalHome;
      else delete process.env.FLOCKCTL_HOME;
    }
  });

  it("validates global skill name", async () => {
    const res = await app.request("/skills/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../bad", content: "x" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("Skills — disabled routes for entities without a path", () => {
  it("GET project disabled returns empty list when project has no path", async () => {
    const noPathProj = db.insert(projects).values({ name: "no-path-proj" }).returning().get()!;
    const res = await app.request(`/skills/projects/${noPathProj.id}/disabled`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toEqual([]);
  });

  it("POST project disabled returns 422 when project has no path", async () => {
    const noPathProj = db.insert(projects).values({ name: "no-path-proj-post" }).returning().get()!;
    const res = await app.request(`/skills/projects/${noPathProj.id}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE project disabled returns 422 when project has no path", async () => {
    const noPathProj = db.insert(projects).values({ name: "no-path-proj-del" }).returning().get()!;
    const res = await app.request(`/skills/projects/${noPathProj.id}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST project disabled returns 404 for unknown project", async () => {
    const res = await app.request(`/skills/projects/999999/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE project disabled returns 404 for unknown project", async () => {
    const res = await app.request(`/skills/projects/999999/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });
});
