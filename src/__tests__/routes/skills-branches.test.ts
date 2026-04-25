import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;
let wsId: number;
let wsPath: string;
let projectId: number;
let projectPath: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = mkdtempSync(join(tmpdir(), "skills-branches-"));
  wsPath = join(tmpBase, "ws");
  projectPath = join(tmpBase, "proj");
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(projectPath, { recursive: true });

  const ws = db.insert(workspaces).values({ name: "wsb", path: wsPath }).returning().get()!;
  wsId = ws.id;
  const p = db.insert(projects).values({
    name: "projb",
    workspaceId: wsId,
    path: projectPath,
  }).returning().get()!;
  projectId = p.id;
});

afterAll(() => {
  sqlite.close();
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("skills routes — branch gaps", () => {
  it("POST /skills/workspaces/:id/disabled rejects body that is not an object", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not-an-object"]),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/workspaces/:id/disabled rejects missing level field", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/workspaces/:id/disabled rejects invalid level", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "weird" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/workspaces/:id/disabled rejects level='project' (not allowed at ws scope)", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/projects/:pid/disabled accepts all three levels", async () => {
    for (const level of ["global", "workspace", "project"]) {
      const res = await app.request(`/skills/projects/${projectId}/disabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `skill-${level}`, level }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("DELETE /skills/workspaces/:id/disabled 404s for missing workspace", async () => {
    const res = await app.request(`/skills/workspaces/999999/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /skills/workspaces/:id/disabled 404s for missing workspace", async () => {
    const res = await app.request(`/skills/workspaces/999999/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /skills/workspaces/:id/disabled 404s for missing workspace", async () => {
    const res = await app.request(`/skills/workspaces/999999/disabled`);
    expect(res.status).toBe(404);
  });

  it("GET /skills/workspaces/:id/disabled returns [] when workspace has no path", async () => {
    // Workspaces.path is NOT NULL+UNIQUE, so insert a row then UPDATE to empty string.
    const row = db.insert(workspaces).values({
      name: `ws-nopath-${Date.now()}`,
      path: `/tmp/ws-nopath-marker-${Date.now()}-${Math.random()}`,
    }).returning().get()!;
    sqlite.prepare("UPDATE workspaces SET path = '' WHERE id = ?").run(row.id);
    const res = await app.request(`/skills/workspaces/${row.id}/disabled`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledSkills).toEqual([]);
  });

  it("POST /skills/workspaces/:id/disabled 422 when workspace has no path", async () => {
    // Find a workspace already set to path='' from previous test, or create+update with unique suffix
    const existing = sqlite.prepare("SELECT id FROM workspaces WHERE path = '' LIMIT 1").get() as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
    } else {
      const unique = `/tmp/ws-nopath2-${Date.now()}-${Math.random()}`;
      const row = db.insert(workspaces).values({
        name: `ws-nopath2-${Date.now()}`,
        path: unique,
      }).returning().get()!;
      sqlite.prepare("UPDATE workspaces SET path = '' WHERE id = ?").run(row.id);
      id = row.id;
    }
    const res = await app.request(`/skills/workspaces/${id}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE /skills/workspaces/:id/disabled is idempotent when entry absent", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "never-added", level: "global" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /skills/workspaces/:id/skills 404 for unknown workspace id", async () => {
    const res = await app.request(`/skills/workspaces/999999/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ok", content: "# hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /skills/workspaces/:id/skills 422 when name missing", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# hi" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/workspaces/:id/skills 422 when content missing", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "foo" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE /skills/workspaces/:id/skills/:name 404 when file does not exist", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/skills/nonexistent-skill`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /skills/workspaces/:id/skills/:name 404 when workspace missing", async () => {
    const res = await app.request(`/skills/workspaces/999999/skills/foo`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /skills/global/:name 404 when file does not exist", async () => {
    const originalHome = process.env.FLOCKCTL_HOME;
    process.env.FLOCKCTL_HOME = tmpBase;
    try {
      const res = await app.request(`/skills/global/definitely-not-present`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    } finally {
      if (originalHome) process.env.FLOCKCTL_HOME = originalHome;
      else delete process.env.FLOCKCTL_HOME;
    }
  });

  it("POST /skills/global 422 when name missing", async () => {
    const res = await app.request(`/skills/global`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /skills/global 422 when content missing", async () => {
    const res = await app.request(`/skills/global`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "okay" }),
    });
    expect(res.status).toBe(422);
  });

  it("GET /skills/resolved without projectId works (global-only)", async () => {
    const res = await app.request(`/skills/resolved`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET /skills/workspaces/:wid/projects/:pid/skills 404 when project missing", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/999999/skills`);
    expect(res.status).toBe(404);
  });

  it("POST /skills/workspaces/:wid/projects/:pid/skills 404 when project has no path", async () => {
    const noPathProj = db.insert(projects).values({ name: `no-path-${Date.now()}` }).returning().get()!;
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${noPathProj.id}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /skills/workspaces/:wid/projects/:pid/skills/:name 404 for unknown project", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/999999/skills/foo`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /skills/workspaces/:wid/projects/:pid/skills/:name 404 when SKILL.md not present", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills/missing`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("POST /skills/projects/:pid/disabled 404 for unknown project", async () => {
    const res = await app.request(`/skills/projects/999999/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /skills/projects/:pid/disabled 404 for unknown project", async () => {
    const res = await app.request(`/skills/projects/999999/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /skills/projects/:pid/disabled 404 for unknown project", async () => {
    const res = await app.request(`/skills/projects/999999/disabled`);
    expect(res.status).toBe(404);
  });

  it("GET /workspaces/:id/skills returns [] when directory does not exist", async () => {
    // Fresh workspace with path that has no .flockctl/skills
    const wsPath2 = join(tmpBase, `ws-empty-${Date.now()}`);
    mkdirSync(wsPath2, { recursive: true });
    const ws2 = db.insert(workspaces).values({
      name: `ws-empty-${Date.now()}`,
      path: wsPath2,
    }).returning().get()!;
    const res = await app.request(`/skills/workspaces/${ws2.id}/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /workspaces/:id/skills lists skills present on disk", async () => {
    const dir = join(wsPath, ".flockctl", "skills", "my-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# hello");
    // And a non-directory entry at top level to hit the `!entry.isDirectory()` branch
    writeFileSync(join(wsPath, ".flockctl", "skills", "stray.txt"), "not a skill");
    const res = await app.request(`/skills/workspaces/${wsId}/skills`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.find((s) => s.name === "my-skill")).toBeDefined();
  });

  it("GET /workspaces/:wid/projects/:pid/skills lists skills on disk", async () => {
    const dir = join(projectPath, ".flockctl", "skills", "proj-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# p");
    const res = await app.request(`/skills/workspaces/${wsId}/projects/${projectId}/skills`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.find((s) => s.name === "proj-skill")).toBeDefined();
  });

  // ── validateDisableBody `!body` (null) branch ──
  it("POST /skills/workspaces/:id/disabled 422 when body is JSON null", async () => {
    const res = await app.request(`/skills/workspaces/${wsId}/disabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(422);
  });

  // ── DELETE /workspaces/:id/disabled with ws.path empty → 422 ──
  it("DELETE /skills/workspaces/:id/disabled 422 when workspace has no path", async () => {
    const existing = sqlite
      .prepare("SELECT id FROM workspaces WHERE path = '' LIMIT 1")
      .get() as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
    } else {
      const unique = `/tmp/ws-nopath-del-${Date.now()}-${Math.random()}`;
      const row = db
        .insert(workspaces)
        .values({ name: `ws-nopath-del-${Date.now()}`, path: unique })
        .returning()
        .get()!;
      sqlite.prepare("UPDATE workspaces SET path = '' WHERE id = ?").run(row.id);
      id = row.id;
    }
    const res = await app.request(`/skills/workspaces/${id}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  // ── DELETE /projects/:pid/disabled when no prior disabledSkills (?? [] branch) ──
  it("DELETE /skills/projects/:pid/disabled is idempotent when config has no disabledSkills", async () => {
    // Fresh project with no config on disk yet
    const freshPath = join(tmpBase, `proj-del-skill-${Date.now()}`);
    mkdirSync(freshPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `proj-del-skill-${Date.now()}`, path: freshPath })
      .returning()
      .get()!;
    const res = await app.request(`/skills/projects/${p.id}/disabled`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nothing", level: "global" }),
    });
    expect(res.status).toBe(200);
  });

  // ── readSkillsFromDir: entry without SKILL.md skipped ──
  it("GET /workspaces/:id/skills skips directory entries without SKILL.md", async () => {
    const wsPath3 = join(tmpBase, `ws-nofile-${Date.now()}`);
    mkdirSync(wsPath3, { recursive: true });
    // Directory entry but no SKILL.md file inside
    mkdirSync(join(wsPath3, ".flockctl", "skills", "ghost"), { recursive: true });
    const ws3 = db
      .insert(workspaces)
      .values({ name: `ws-nofile-${Date.now()}`, path: wsPath3 })
      .returning()
      .get()!;
    const res = await app.request(`/skills/workspaces/${ws3.id}/skills`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.find((s) => s.name === "ghost")).toBeUndefined();
  });
});
