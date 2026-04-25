/**
 * Branch-coverage extras for `services/skills.ts`.
 *
 * Fills:
 *   - loadSkillsFromDir: non-directory entries skipped
 *   - loadSkillsFromDir: directory without SKILL.md skipped
 *   - resolveSkillsForProject: workspace has no path (workspace?.path falsy)
 *   - resolveSkillsForProject: project has no path (project.path falsy)
 *   - resolveSkillsForProject: workspace disables a skill that isn't global (no-op)
 *   - resolveSkillsForWorkspace: workspace row missing path (no workspace skills added)
 *   - resolveSkillsForWorkspace: workspace disables a skill that isn't global (no-op)
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;

vi.mock("../../config", () => ({
  getFlockctlHome: () => "/mock-home",
  getWorkspacesDir: () => "/mock-home/workspaces",
  getGlobalSkillsDir: () =>
    join(tmpdir(), `flockctl-test-skills-branches-${process.pid}`, "global"),
}));

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-skills-branches-${process.pid}`);
  mkdirSync(join(tmpBase, "global"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  db.delete(projects).run();
  db.delete(workspaces).run();
  try {
    rmSync(join(tmpBase, "global"), { recursive: true, force: true });
  } catch {}
  mkdirSync(join(tmpBase, "global"), { recursive: true });
});

import {
  resolveSkillsForProject,
  resolveSkillsForWorkspace,
} from "../../services/skills.js";

describe("loadSkillsFromDir — branches", () => {
  it("skips non-directory entries at the top level", () => {
    const globalDir = join(tmpBase, "global");
    // Stray file at the root — not a directory.
    writeFileSync(join(globalDir, "stray.txt"), "not a skill");
    // Directory without SKILL.md — the `if (existsSync(skillFile))` skip.
    mkdirSync(join(globalDir, "empty-skill"), { recursive: true });
    // Valid skill
    mkdirSync(join(globalDir, "real"), { recursive: true });
    writeFileSync(join(globalDir, "real", "SKILL.md"), "# R\n");

    const out = resolveSkillsForProject(null);
    const names = out.map((s) => s.name);
    expect(names).toContain("real");
    expect(names).not.toContain("stray.txt");
    expect(names).not.toContain("empty-skill");
  });
});

describe("resolveSkillsForProject — branches", () => {
  it("returns global-only when project id unknown", () => {
    // Add one global skill so we can see it.
    const dir = join(tmpBase, "global", "g1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# g\n");
    const out = resolveSkillsForProject(999999);
    expect(out.find((s) => s.name === "g1")).toBeDefined();
  });

  it("skips workspace when workspace.path is empty", () => {
    const dir = join(tmpBase, "global", "gx");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# gx\n");
    // Workspace with empty path (bypass NOT NULL via direct SQL)
    sqlite
      .prepare("INSERT INTO workspaces (name, path) VALUES (?, ?)")
      .run(`ws-empty-${Date.now()}`, `placeholder-${Date.now()}`);
    sqlite.prepare("UPDATE workspaces SET path='' WHERE name LIKE 'ws-empty-%'").run();
    const wsRow = sqlite
      .prepare("SELECT id FROM workspaces ORDER BY id DESC LIMIT 1")
      .get() as { id: number };
    const pPath = join(tmpBase, `p-noWs-${Date.now()}`);
    mkdirSync(pPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `p-noWs-${Date.now()}`, workspaceId: wsRow.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveSkillsForProject(p.id);
    // No throw; global skill still present.
    expect(out.find((s) => s.name === "gx")).toBeDefined();
  });

  it("skips project branch when project.path is null", () => {
    const dir = join(tmpBase, "global", "gy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# gy\n");
    const p = db
      .insert(projects)
      .values({ name: `p-noPath-${Date.now()}` })
      .returning()
      .get()!;
    const out = resolveSkillsForProject(p.id);
    expect(out.find((s) => s.name === "gy")).toBeDefined();
  });

  it("workspace-level disable entry referencing non-global skill is a no-op (branch: s && s.level === 'global' false)", () => {
    const wsPath = join(tmpBase, `ws-noop-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    // Disable a name that isn't present at global level.
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ level: "global", name: "does-not-exist" }] }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-noop-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-noop-${Date.now()}`);
    mkdirSync(pPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `p-noop-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveSkillsForProject(p.id);
    // No throw; resolves cleanly.
    expect(Array.isArray(out)).toBe(true);
  });

  it("project-level disable of non-workspace skill is a no-op (branch: s && s.level === 'workspace' false)", () => {
    const wsPath = join(tmpBase, `ws-proj-noop-${Date.now()}`);
    mkdirSync(wsPath, { recursive: true });
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-proj-noop-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-proj-noop-${Date.now()}`);
    mkdirSync(join(pPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(pPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledSkills: [{ level: "workspace", name: "never-was-workspace" }],
      }),
    );
    const p = db
      .insert(projects)
      .values({ name: `p-proj-noop-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveSkillsForProject(p.id);
    expect(Array.isArray(out)).toBe(true);
  });

  it("loads workspace skills directory when workspace dir has skills", () => {
    const wsPath = join(tmpBase, `ws-skills-${Date.now()}`);
    const wsSkillDir = join(wsPath, ".flockctl", "skills", "ws-only");
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(join(wsSkillDir, "SKILL.md"), "# ws\n");
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-skills-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-ws-skills-${Date.now()}`);
    mkdirSync(pPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `p-ws-skills-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveSkillsForProject(p.id);
    expect(out.find((s) => s.name === "ws-only")).toBeDefined();
  });
});

describe("resolveSkillsForWorkspace — branches", () => {
  it("returns global-only when workspace id unknown", () => {
    const dir = join(tmpBase, "global", "gz");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# gz\n");
    const out = resolveSkillsForWorkspace(999999);
    expect(out.find((s) => s.name === "gz")).toBeDefined();
  });

  it("returns global-only when workspace has empty path", () => {
    sqlite
      .prepare("INSERT INTO workspaces (name, path) VALUES (?, ?)")
      .run(`ws-nopath-${Date.now()}`, `placeholder-${Date.now()}`);
    sqlite.prepare("UPDATE workspaces SET path='' WHERE name LIKE 'ws-nopath-%'").run();
    const wsRow = sqlite
      .prepare("SELECT id FROM workspaces ORDER BY id DESC LIMIT 1")
      .get() as { id: number };
    expect(() => resolveSkillsForWorkspace(wsRow.id)).not.toThrow();
  });

  it("workspace-level disable referencing non-global name is a no-op", () => {
    const wsPath = join(tmpBase, `ws-nodis-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ level: "global", name: "missing" }] }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-nodis-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const out = resolveSkillsForWorkspace(ws.id);
    expect(Array.isArray(out)).toBe(true);
  });
});
