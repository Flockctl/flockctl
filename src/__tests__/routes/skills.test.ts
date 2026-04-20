import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-skills-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

describe("Skills routes — workspace skills", () => {
  let wsId: number;
  let wsPath: string;

  beforeAll(() => {
    wsPath = join(tmpBase, "ws1");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-skills", path: wsPath }).returning().get();
    wsId = ws!.id;
  });

  it("GET /skills/workspaces/:id/skills returns empty when no skills", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST /skills/workspaces/:id/skills creates a skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-skill", content: "# Test Skill\nHello" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe("test-skill");
    expect(body.level).toBe("workspace");
    expect(body.saved).toBe(true);
  });

  it("GET /skills/workspaces/:id/skills returns created skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("test-skill");
    expect(body[0].content).toContain("# Test Skill");
  });

  it("DELETE /skills/workspaces/:id/skills/:name deletes skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills/test-skill`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).deleted).toBe(true);
  });

  it("DELETE /skills/workspaces/:id/skills/:name returns 404 for missing", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("GET /skills/workspaces/999/skills returns 404 for missing workspace", async () => {
    const res = await app.request("/skills/workspaces/999/skills");
    expect(res.status).toBe(404);
  });

  it("POST /skills/workspaces/:id/skills validates name required", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/workspaces/:id/skills validates content required", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "skill-x" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("Skills routes — project skills", () => {
  let wsId: number;
  let projectId: number;
  let projectPath: string;

  beforeAll(() => {
    const wsPath = join(tmpBase, "ws2");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-project-skills", path: wsPath }).returning().get();
    wsId = ws!.id;
    projectPath = join(tmpBase, "project1");
    mkdirSync(projectPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-skills",
      workspaceId: wsId,
      path: projectPath,
    }).returning().get();
    projectId = proj!.id;
  });

  it("GET project skills returns empty initially", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST creates a project skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "proj-skill", content: "# Project Skill" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.level).toBe("project");
  });

  it("GET returns the created project skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("proj-skill");
  });

  it("DELETE removes the project skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills/proj-skill`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).deleted).toBe(true);
  });

  it("DELETE 404 for missing project skill", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills/nope`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("GET 404 for nonexistent project", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/999/skills`);
    expect(res.status).toBe(404);
  });
});

describe("Skills routes — resolved", () => {
  it("GET /skills/resolved returns array", async () => {
    const res = await app.request("/skills/resolved");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /skills/resolved with projectId returns array", async () => {
    const res = await app.request("/skills/resolved?projectId=999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("Skills routes — global skills", () => {
  it("POST /skills/global creates a global skill, DELETE removes it", async () => {
    const create = await app.request("/skills/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "global-route-skill", content: "# Hi" }),
    });
    expect(create.status).toBe(201);

    const del = await app.request("/skills/global/global-route-skill", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);
  });

  it("DELETE /skills/global/:name returns 404 for missing skill", async () => {
    const res = await app.request("/skills/global/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /skills/global validates name and content", async () => {
    const noName = await app.request("/skills/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(noName.status).toBe(422);

    const noContent = await app.request("/skills/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "abc" }),
    });
    expect(noContent.status).toBe(422);
  });
});

describe("Skills routes — disable validation", () => {
  let wsId: number;
  let wsPath: string;

  beforeAll(() => {
    wsPath = join(tmpBase, "ws-disable-validate");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-disable-val", path: wsPath }).returning().get();
    wsId = ws!.id;
  });

  it("disable POST returns 422 when level is invalid string", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "garbage" }),
    });
    expect(res.status).toBe(422);
  });

  it("workspace disable POST returns 422 when level is 'project' (out of scope)", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("Skills routes — project disabled-skills", () => {
  let pid: number;
  let projPath: string;

  beforeAll(() => {
    projPath = join(tmpBase, "proj-disable-mgmt");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({ name: "proj-disable-mgmt", path: projPath }).returning().get();
    pid = proj!.id;
  });

  it("POST adds, GET lists, DELETE removes a project disabled skill", async () => {
    const add = await app.request(`/skills/projects/${pid}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "skl", level: "project" }),
    });
    expect(add.status).toBe(200);
    expect((await add.json()).disabledSkills).toContainEqual({ name: "skl", level: "project" });

    const list = await (await app.request(`/skills/projects/${pid}/disabled`)).json();
    expect(list.disabledSkills).toContainEqual({ name: "skl", level: "project" });

    const rm = await app.request(`/skills/projects/${pid}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "skl", level: "project" }),
    });
    expect(rm.status).toBe(200);
    expect((await rm.json()).disabledSkills).not.toContainEqual({ name: "skl", level: "project" });
  });

  it("project disable POST returns 404 for unknown project", async () => {
    const res = await app.request("/skills/projects/99999/disabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });

  it("project disable GET returns empty list for project with no path", async () => {
    const noPath = db.insert(projects).values({ name: "no-path-disable" }).returning().get();
    const res = await app.request(`/skills/projects/${noPath!.id}/disabled`);
    expect(res.status).toBe(200);
    expect((await res.json()).disabledSkills).toEqual([]);
  });
});
