import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getDb } from "../db/index.js";
import { projects, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getGlobalSkillsDir } from "../config.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { loadProjectConfig } from "./project-config.js";
import type { DisableEntry } from "./workspace-config.js";

export type SkillLevel = "global" | "workspace" | "project";

export interface Skill {
  name: string;
  level: SkillLevel;
  sourceDir: string;
  content?: string;
}

function loadSkillsFromDir(dir: string, level: SkillLevel): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (existsSync(skillFile)) {
      skills.push({ name: entry.name, level, sourceDir: skillDir });
    }
  }
  return skills;
}

function disabledNamesForLevel(entries: DisableEntry[] | undefined, level: SkillLevel): Set<string> {
  const result = new Set<string>();
  if (!entries) return result;
  for (const e of entries) if (e.level === level) result.add(e.name);
  return result;
}

/**
 * Resolve the effective set of skills visible at the project level,
 * taking workspace + project disables into account.
 *
 * Precedence: project > workspace > global (same-name overrides at lower level).
 */
export function resolveSkillsForProject(projectId?: number | null): Skill[] {
  const out = new Map<string, Skill>();

  const globalDir = getGlobalSkillsDir();
  for (const s of loadSkillsFromDir(globalDir, "global")) out.set(s.name, s);

  if (!projectId) return [...out.values()];

  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return [...out.values()];

  let wsDisabledGlobal = new Set<string>();
  let wsDisabledWorkspace = new Set<string>();
  if (project.workspaceId) {
    const workspace = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
    if (workspace?.path) {
      const wsConfig = loadWorkspaceConfig(workspace.path);
      wsDisabledGlobal = disabledNamesForLevel(wsConfig.disabledSkills, "global");
      wsDisabledWorkspace = disabledNamesForLevel(wsConfig.disabledSkills, "workspace");

      for (const name of wsDisabledGlobal) {
        const s = out.get(name);
        if (s && s.level === "global") out.delete(name);
      }

      const wsSkillsDir = join(workspace.path, ".flockctl", "skills");
      for (const s of loadSkillsFromDir(wsSkillsDir, "workspace")) {
        if (!wsDisabledWorkspace.has(s.name)) out.set(s.name, s);
      }
    }
  }

  if (project.path) {
    const projConfig = loadProjectConfig(project.path);
    const projDisabledGlobal = disabledNamesForLevel(projConfig.disabledSkills, "global");
    const projDisabledWorkspace = disabledNamesForLevel(projConfig.disabledSkills, "workspace");
    const projDisabledProject = disabledNamesForLevel(projConfig.disabledSkills, "project");

    for (const name of projDisabledGlobal) {
      const s = out.get(name);
      if (s && s.level === "global") out.delete(name);
    }
    for (const name of projDisabledWorkspace) {
      const s = out.get(name);
      if (s && s.level === "workspace") out.delete(name);
    }

    const projSkillsDir = join(project.path, ".flockctl", "skills");
    for (const s of loadSkillsFromDir(projSkillsDir, "project")) {
      if (!projDisabledProject.has(s.name)) out.set(s.name, s);
    }
  }

  return [...out.values()];
}

/**
 * Resolve skills visible at the workspace level (global + workspace, minus disables).
 * Used by the reconciler to write workspace-level .claude/skills/ view.
 */
export function resolveSkillsForWorkspace(workspaceId: number): Skill[] {
  const out = new Map<string, Skill>();

  const globalDir = getGlobalSkillsDir();
  for (const s of loadSkillsFromDir(globalDir, "global")) out.set(s.name, s);

  const db = getDb();
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace?.path) return [...out.values()];

  const wsConfig = loadWorkspaceConfig(workspace.path);
  const wsDisabledGlobal = disabledNamesForLevel(wsConfig.disabledSkills, "global");
  const wsDisabledWorkspace = disabledNamesForLevel(wsConfig.disabledSkills, "workspace");

  for (const name of wsDisabledGlobal) {
    const s = out.get(name);
    if (s && s.level === "global") out.delete(name);
  }

  const wsSkillsDir = join(workspace.path, ".flockctl", "skills");
  for (const s of loadSkillsFromDir(wsSkillsDir, "workspace")) {
    if (!wsDisabledWorkspace.has(s.name)) out.set(s.name, s);
  }

  return [...out.values()];
}

/**
 * Read the SKILL.md content for a resolved skill. Used by tests and any
 * caller that needs the body; the reconciler does not.
 */
export function readSkillContent(skill: Skill): string {
  return readFileSync(join(skill.sourceDir, "SKILL.md"), "utf-8");
}
