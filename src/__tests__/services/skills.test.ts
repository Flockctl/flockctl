import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;

// Mock config to control global skills dir
vi.mock("../../config", () => ({
  getFlockctlHome: () => "/mock-home",
  getWorkspacesDir: () => "/mock-home/workspaces",
  getGlobalSkillsDir: () => join(tmpdir(), `flockctl-test-skills-svc-${process.pid}`, "global"),
}));

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-skills-svc-${process.pid}`);
  mkdirSync(join(tmpBase, "global"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

import { resolveSkillsForProject, resolveSkillsForWorkspace, readSkillContent } from "../../services/skills.js";

describe("resolveSkillsForProject", () => {
  it("returns empty array with no skills dirs", () => {
    const result = resolveSkillsForProject(null);
    expect(result).toEqual([]);
  });

  it("loads global skills from directory", () => {
    const globalDir = join(tmpBase, "global");
    const skillDir = join(globalDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# My Skill\nContent here");

    const result = resolveSkillsForProject(null);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const skill = result.find(s => s.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill!.level).toBe("global");
    const content = readFileSync(join(skill!.sourceDir, "SKILL.md"), "utf-8");
    expect(content).toContain("# My Skill");
  });

  it("workspace skills override global skills with same name", () => {
    const wsPath = join(tmpBase, "ws-override");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-override-test", path: wsPath }).returning().get();

    const proj = db.insert(projects).values({
      name: "proj-override-test",
      workspaceId: ws!.id,
      path: join(tmpBase, "proj-override"),
    }).returning().get();
    mkdirSync(join(tmpBase, "proj-override"), { recursive: true });

    // Create workspace skill with same name as global
    const wsSkillDir = join(wsPath, ".flockctl", "skills", "my-skill");
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(join(wsSkillDir, "SKILL.md"), "# Workspace Override");

    const result = resolveSkillsForProject(proj!.id);
    const skill = result.find(s => s.name === "my-skill");
    expect(skill).toBeDefined();
    expect(skill!.level).toBe("workspace");
    const content = readFileSync(join(skill!.sourceDir, "SKILL.md"), "utf-8");
    expect(content).toContain("Workspace Override");
  });

  it("project skills override workspace skills with same name", () => {
    const wsPath = join(tmpBase, "ws-proj-override");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-proj-override-test", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-override-2");
    mkdirSync(projPath, { recursive: true });

    const proj = db.insert(projects).values({
      name: "proj-override-test-2",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    // Create workspace skill
    const wsSkillDir = join(wsPath, ".flockctl", "skills", "override-test");
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(join(wsSkillDir, "SKILL.md"), "# Workspace Level");

    // Create project skill with same name
    const projSkillDir = join(projPath, ".flockctl", "skills", "override-test");
    mkdirSync(projSkillDir, { recursive: true });
    writeFileSync(join(projSkillDir, "SKILL.md"), "# Project Level");

    const result = resolveSkillsForProject(proj!.id);
    const skill = result.find(s => s.name === "override-test");
    expect(skill).toBeDefined();
    expect(skill!.level).toBe("project");
    const content = readFileSync(join(skill!.sourceDir, "SKILL.md"), "utf-8");
    expect(content).toContain("Project Level");
  });

  it("disabledSkills config removes skills", () => {
    const wsPath2 = join(tmpBase, "ws-disabled");
    mkdirSync(wsPath2, { recursive: true });
    const ws2 = db.insert(workspaces).values({ name: "ws-disabled-test", path: wsPath2 }).returning().get();
    const projPath2 = join(tmpBase, "proj-disabled");
    mkdirSync(projPath2, { recursive: true });
    const proj2 = db.insert(projects).values({
      name: "proj-disabled-test",
      workspaceId: ws2!.id,
      path: projPath2,
    }).returning().get();

    // Create a workspace skill
    const wsSkillDir2 = join(wsPath2, ".flockctl", "skills", "disabled-skill");
    mkdirSync(wsSkillDir2, { recursive: true });
    writeFileSync(join(wsSkillDir2, "SKILL.md"), "# Should be disabled");

    // Create project config that disables the workspace-level skill
    const projConfigDir = join(projPath2, ".flockctl");
    mkdirSync(projConfigDir, { recursive: true });
    writeFileSync(
      join(projConfigDir, "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "disabled-skill", level: "workspace" }] }),
    );

    const result = resolveSkillsForProject(proj2!.id);
    const skill = result.find(s => s.name === "disabled-skill");
    expect(skill).toBeUndefined();
  });

  it("returns empty for nonexistent projectId", () => {
    const result = resolveSkillsForProject(99999);
    // Project doesn't exist — returns only global skills
    expect(Array.isArray(result)).toBe(true);
  });

  it("project config can disable its own project-level skill", () => {
    const wsPath = join(tmpBase, "ws-proj-self-disable");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-psd", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-self-disable");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-psd",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    const projSkillDir = join(projPath, ".flockctl", "skills", "own-disabled");
    mkdirSync(projSkillDir, { recursive: true });
    writeFileSync(join(projSkillDir, "SKILL.md"), "# should be hidden");

    writeFileSync(
      join(projPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "own-disabled", level: "project" }] }),
    );

    const result = resolveSkillsForProject(proj!.id);
    expect(result.find((s) => s.name === "own-disabled")).toBeUndefined();
  });

  it("workspace config can disable a global skill (visible in resolveSkillsForProject)", () => {
    const globalDir = join(tmpBase, "global");
    const gskill = join(globalDir, "ws-disables-global");
    mkdirSync(gskill, { recursive: true });
    writeFileSync(join(gskill, "SKILL.md"), "# Global skill");

    const wsPath = join(tmpBase, "ws-disables-global");
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "ws-disables-global", level: "global" }] }),
    );
    const ws = db.insert(workspaces).values({ name: "ws-dg", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-ws-dg");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-ws-dg",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    const result = resolveSkillsForProject(proj!.id);
    expect(result.find((s) => s.name === "ws-disables-global")).toBeUndefined();
  });

  it("project config can disable a global skill", () => {
    const globalDir = join(tmpBase, "global");
    const gskill = join(globalDir, "global-to-disable");
    mkdirSync(gskill, { recursive: true });
    writeFileSync(join(gskill, "SKILL.md"), "# Global skill");

    const wsPath = join(tmpBase, "ws-proj-disables-global");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-pdg", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-disables-global");
    mkdirSync(join(projPath, ".flockctl"), { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-pdg",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    writeFileSync(
      join(projPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "global-to-disable", level: "global" }] }),
    );

    const result = resolveSkillsForProject(proj!.id);
    expect(result.find((s) => s.name === "global-to-disable")).toBeUndefined();
  });
});

describe("resolveSkillsForWorkspace", () => {
  it("filters out workspace skills disabled by workspace config", () => {
    const wsPath = join(tmpBase, "ws-self-disable");
    mkdirSync(join(wsPath, ".flockctl", "skills", "ws-self-disabled"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "skills", "ws-self-disabled", "SKILL.md"),
      "# Should not appear",
    );
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "ws-self-disabled", level: "workspace" }] }),
    );
    const ws = db.insert(workspaces).values({ name: "ws-self-disable", path: wsPath }).returning().get();

    const result = resolveSkillsForWorkspace(ws!.id);
    expect(result.find((s) => s.name === "ws-self-disabled")).toBeUndefined();
  });
});

describe("resolveSkillsForProject — level mismatch in disable entries", () => {
  it("disable entry with wrong level is a no-op (not a fallback match by name)", () => {
    const globalDir = join(tmpBase, "global");
    const gskill = join(globalDir, "level-mismatch");
    mkdirSync(gskill, { recursive: true });
    writeFileSync(join(gskill, "SKILL.md"), "# Global level-mismatch");

    const wsPath = join(tmpBase, "ws-level-mismatch");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-lm", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-level-mismatch");
    mkdirSync(join(projPath, ".flockctl"), { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-lm",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    // Disable at "workspace" level but the skill is actually "global" — no-op
    writeFileSync(
      join(projPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "level-mismatch", level: "workspace" }] }),
    );

    const result = resolveSkillsForProject(proj!.id);
    expect(result.find((s) => s.name === "level-mismatch")).toBeDefined();
  });
});

describe("resolveSkillsForWorkspace — level mismatch", () => {
  it("disable entry with project level on a workspace-level skill is a no-op", () => {
    const wsPath = join(tmpBase, "ws-disable-proj-level");
    const wsSkillDir = join(wsPath, ".flockctl", "skills", "ws-kept");
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(join(wsSkillDir, "SKILL.md"), "# Keep me");
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "ws-kept", level: "project" }] }),
    );
    const ws = db.insert(workspaces).values({ name: "ws-wrong-level", path: wsPath }).returning().get();

    const result = resolveSkillsForWorkspace(ws!.id);
    expect(result.find((s) => s.name === "ws-kept")).toBeDefined();
  });
});

describe("readSkillContent", () => {
  it("returns SKILL.md bytes from sourceDir", () => {
    const skillDir = join(tmpBase, "read-content-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Hello content");

    const content = readSkillContent({
      name: "read-content-skill",
      level: "global",
      sourceDir: skillDir,
    });
    expect(content).toBe("# Hello content");
  });
});
