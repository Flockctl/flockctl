import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import Database from "better-sqlite3";

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
  homeBase = mkdtempSync(join(tmpdir(), "flockctl-home-"));
  process.env.FLOCKCTL_HOME = homeBase;
});

afterAll(() => {
  sqlite.close();
  if (origEnv === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origEnv;
  try { rmSync(homeBase, { recursive: true, force: true }); } catch {}
});

import { buildPlanGenerationPrompt } from "../../services/plan-prompt.js";

describe("buildPlanGenerationPrompt", () => {
  let projectPath: string;
  let projectId: number;

  beforeEach(() => {
    // Clean skills dir between tests to isolate
    try { rmSync(join(homeBase, "skills"), { recursive: true, force: true }); } catch {}
    projectPath = mkdtempSync(join(tmpdir(), "plan-prompt-proj-"));
    const p = db.insert(projects).values({ name: `proj-${Date.now()}-${Math.random()}`, path: projectPath }).returning().get();
    projectId = p!.id;
  });

  it("returns prompt with user description and plan dir when skill missing", async () => {
    const prompt = await buildPlanGenerationPrompt(projectId, projectPath, "Build auth", "quick");
    expect(prompt).toContain("## User Description");
    expect(prompt).toContain("Build auth");
    expect(prompt).toContain("## Target Directory");
    expect(prompt).toContain(projectPath);
    expect(prompt).toContain(".flockctl/plan");
  });

  it("directs agent to load planning skill with mode label", async () => {
    const quick = await buildPlanGenerationPrompt(projectId, projectPath, "do X", "quick");
    expect(quick).toContain("planning");
    expect(quick).toContain("Quick Mode");
    expect(quick).toContain("Mode: Quick");

    const deep = await buildPlanGenerationPrompt(projectId, projectPath, "do Y", "deep");
    expect(deep).toContain("Deep Mode");
    expect(deep).toContain("Mode: Deep");
    expect(quick).not.toBe(deep);
  });

  it("includes codebase context when project path exists with README", async () => {
    writeFileSync(join(projectPath, "README.md"), "# Project X");
    const prompt = await buildPlanGenerationPrompt(projectId, projectPath, "desc", "quick");
    expect(prompt).toContain("## Codebase Context");
    expect(prompt).toContain("<readme>");
    expect(prompt).toContain("Project X");
  });

  it("does not inline any skill XML or Project Skills section", async () => {
    // Seed a planning skill file under global skills dir (simulating progressive disclosure source)
    const skillDir = join(homeBase, "skills", "planning");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Planning\n\nBody.\n");

    const prompt = await buildPlanGenerationPrompt(projectId, projectPath, "Nothing", "quick");
    // New architecture: never inject skill content, always reference the skill tool.
    expect(prompt).not.toContain("## Project Skills");
    expect(prompt).not.toContain("<skill ");
    expect(prompt).not.toContain("<skills>");
    rmSync(skillDir, { recursive: true, force: true });
  });
});
