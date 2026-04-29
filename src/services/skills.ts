import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getDb } from "../db/index.js";
import { projects, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getGlobalSkillsDir } from "../config/index.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { loadProjectConfig } from "./project-config.js";
import type { DisableEntry } from "./workspace-config.js";

export type SkillLevel = "global" | "workspace" | "project";

export interface Skill {
  name: string;
  level: SkillLevel;
  sourceDir: string;
  content?: string;
  /**
   * `true` for skills sourced directly from the project's own
   * `<project>/.claude/skills/<name>/SKILL.md` when the project opted in via
   * `projects.use_project_claude_skills`. These bypass the per-project
   * `disabledSkills` filter (the operator opted them in at create-time and
   * cannot turn them off through the UI toggle list) and the reconciler skips
   * symlink writes for them — the source already lives at the destination.
   */
  locked?: boolean;
  /**
   * `true` when `sourceDir` IS the path the skills reconciler would otherwise
   * write a symlink to (i.e. `<project>/.claude/skills/<name>`). Used by
   * `writeSymlinks()` to skip both deletion and re-creation for these
   * entries — the directory is the user's real content, not a Flockctl link.
   */
  nativeInTarget?: boolean;
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

/**
 * Walk `<projectPath>/.claude/skills/<name>/SKILL.md` and return one Skill per
 * entry, marked locked + nativeInTarget. Used only when the project opted in
 * via `projects.use_project_claude_skills` (see migration 0045).
 *
 * Symlinks inside `.claude/skills/` are deliberately ignored: those are the
 * Flockctl-managed view written by `writeSymlinks()`, not the user's own
 * content. Only real directories with a real `SKILL.md` count as a project
 * source — otherwise a stale symlink would shadow the global / workspace
 * skill of the same name and the override would be invisible to the operator.
 */
function loadProjectClaudeSkills(projectPath: string): Skill[] {
  const dir = join(projectPath, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({
      name: entry.name,
      level: "project",
      sourceDir: skillDir,
      locked: true,
      nativeInTarget: true,
    });
  }
  return out;
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

    // Project-owned skills sourced from `<project>/.claude/skills/<name>/SKILL.md`.
    // Opt-in per migration 0045: `projects.use_project_claude_skills`. Locked
    // entries override anything at lower precedence (global / workspace /
    // `.flockctl/skills/`) AND ignore the per-project `disabledSkills` list,
    // so the operator's create-time opt-in cannot be silently undone via the
    // skills toggle UI.
    if (project.useProjectClaudeSkills) {
      for (const s of loadProjectClaudeSkills(project.path)) {
        out.set(s.name, s);
      }
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
