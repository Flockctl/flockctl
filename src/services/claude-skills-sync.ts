import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects, workspaces } from "../db/schema.js";
import { resolveSkillsForProject, resolveSkillsForWorkspace, type Skill } from "./skills.js";

interface ManifestEntry {
  name: string;
  level: "global" | "workspace" | "project";
}

/**
 * Reconcile the effective skills set for a project:
 * writes symlinks to <project>/.claude/skills/ and a byte-stable
 * manifest to <project>/.flockctl/skills-state.json.
 */
export function reconcileClaudeSkillsForProject(projectId: number): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.path || !existsSync(project.path)) return;

  const skills = resolveSkillsForProject(projectId);
  const targetDir = join(project.path, ".claude", "skills");
  const flockctlDir = join(project.path, ".flockctl");

  writeSymlinks(targetDir, skills);
  writeManifest(flockctlDir, skills);
  writeLocalReconcileMarker(flockctlDir);
  ensureGitignore(project.path);
}

/**
 * Reconcile the effective skills set at the workspace level
 * (global + workspace skills minus workspace-scoped disables).
 */
export function reconcileClaudeSkillsForWorkspace(workspaceId: number): void {
  const db = getDb();
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace?.path || !existsSync(workspace.path)) return;

  const skills = resolveSkillsForWorkspace(workspaceId);
  const targetDir = join(workspace.path, ".claude", "skills");
  const flockctlDir = join(workspace.path, ".flockctl");

  writeSymlinks(targetDir, skills);
  writeManifest(flockctlDir, skills);
  writeLocalReconcileMarker(flockctlDir);
  ensureGitignore(workspace.path);
}

/**
 * Reconcile every known project. Used on startup to catch drift from
 * teammate pulls or prior crashes.
 */
export function reconcileAllProjects(): void {
  const db = getDb();
  const allWorkspaces = db.select().from(workspaces).all();
  for (const ws of allWorkspaces) {
    try {
      reconcileClaudeSkillsForWorkspace(ws.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-workspace reconciler shouldn't throw */
      console.error(`[skills-sync] workspace ${ws.id} failed:`, err);
    }
  }

  const allProjects = db.select().from(projects).all();
  for (const p of allProjects) {
    try {
      reconcileClaudeSkillsForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[skills-sync] project ${p.id} failed:`, err);
    }
  }
}

/**
 * Reconcile workspace manifest + every project under the workspace.
 * Used when workspace-level state changes so children stay in sync.
 */
export function reconcileAllProjectsInWorkspace(workspaceId: number): void {
  try {
    reconcileClaudeSkillsForWorkspace(workspaceId);
  } catch (err) {
    /* v8 ignore next — defensive: workspace reconciler shouldn't throw */
    console.error(`[skills-sync] workspace ${workspaceId} failed:`, err);
  }

  const db = getDb();
  const children = db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).all();
  for (const p of children) {
    try {
      reconcileClaudeSkillsForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[skills-sync] project ${p.id} failed:`, err);
    }
  }
}

function writeSymlinks(targetDir: string, skills: Skill[]): void {
  mkdirSync(targetDir, { recursive: true });

  const desired = new Map<string, string>();
  for (const s of skills) desired.set(s.name, s.sourceDir);

  let existing: string[] = [];
  try {
    existing = readdirSync(targetDir);
  } catch {
    existing = [];
  }

  for (const name of existing) {
    const fullPath = join(targetDir, name);
    let lst;
    try {
      lst = lstatSync(fullPath);
    } catch {
      /* v8 ignore next — defensive: lstat fails only on permission/race */
      continue;
    }

    if (!lst.isSymbolicLink()) {
      /* v8 ignore next 2 — defensive: non-symlink entries left to user */
      console.warn(`[skills-sync] non-symlink entry ${fullPath} left untouched`);
      continue;
    }

    let linkTarget: string | null = null;
    try {
      linkTarget = readlinkSync(fullPath);
    } catch {
      /* v8 ignore next — defensive: readlink fails only on race */
      linkTarget = null;
    }

    const wantedSource = desired.get(name);
    const targetMissing = linkTarget !== null && !existsSync(linkTarget);
    const notInDesired = wantedSource === undefined;
    const pointsWrong = wantedSource !== undefined && linkTarget !== wantedSource;

    if (targetMissing || notInDesired || pointsWrong) {
      try {
        unlinkSync(fullPath);
      } catch (err) {
        /* v8 ignore next — defensive: unlink fails only on permission/race */
        console.warn(`[skills-sync] failed to unlink ${fullPath}:`, err);
      }
    }
  }

  for (const [name, sourceDir] of desired) {
    const linkPath = join(targetDir, name);
    if (existsSync(linkPath)) {
      try {
        const current = readlinkSync(linkPath);
        if (current === sourceDir) continue;
        unlinkSync(linkPath);
      } catch {
        /* v8 ignore next — defensive: readlink/unlink races with FS state */
        continue;
      }
    }
    try {
      symlinkSync(sourceDir, linkPath);
    } catch (err) {
      /* v8 ignore next — defensive: symlink fails only on permission/race */
      console.warn(`[skills-sync] failed to symlink ${linkPath} -> ${sourceDir}:`, err);
    }
  }
}

function writeManifest(flockctlDir: string, skills: Skill[]): void {
  mkdirSync(flockctlDir, { recursive: true });

  const entries: ManifestEntry[] = skills
    .map((s) => ({ name: s.name, level: s.level }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const content = JSON.stringify({ skills: entries }, null, 2) + "\n";
  const finalPath = join(flockctlDir, "skills-state.json");

  try {
    if (existsSync(finalPath) && readFileSync(finalPath, "utf-8") === content) return;
  } catch {
    // fall through to write
  }

  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

function writeLocalReconcileMarker(flockctlDir: string): void {
  mkdirSync(flockctlDir, { recursive: true });
  const finalPath = join(flockctlDir, ".skills-reconcile");
  const content = JSON.stringify({ reconciled_at: new Date().toISOString() }, null, 2) + "\n";
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

const GITIGNORE_PATTERNS = [
  ".claude/skills/",
  ".mcp.json",
  ".flockctl/.skills-reconcile",
  ".flockctl/.mcp-reconcile",
  ".flockctl/.agents-reconcile",
  ".flockctl/import-backup/",
];

const GITIGNORE_BEGIN_MARKER = "# ─── Flockctl (auto-managed — do not edit) ───";
const GITIGNORE_END_MARKER = "# ─── /Flockctl ───";

function buildFlockctlBlock(): string {
  return [GITIGNORE_BEGIN_MARKER, ...GITIGNORE_PATTERNS, GITIGNORE_END_MARKER].join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append (or refresh) a marked Flockctl block in <dir>/.gitignore.
 * Migrates raw entries from prior versions into the block. No-op when
 * <dir>/.gitignore is missing — don't pollute non-git dirs.
 */
export function ensureGitignore(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) return;

  let current = "";
  try {
    current = readFileSync(gitignorePath, "utf-8");
  } catch {
    /* v8 ignore next — defensive: read failure on existsSync-checked file */
    return;
  }

  const blockRegex = new RegExp(
    `\\n*${escapeRegExp(GITIGNORE_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(GITIGNORE_END_MARKER)}\\n*`,
    "g",
  );
  const patternSet = new Set(GITIGNORE_PATTERNS);
  const withoutBlock = current.replace(blockRegex, "\n");
  const cleaned = withoutBlock
    .split("\n")
    .filter((line) => !patternSet.has(line.trim()))
    .join("\n");

  const trimmed = cleaned.replace(/\s+$/, "");
  const prefix = trimmed === "" ? "" : trimmed + "\n\n";
  const next = prefix + buildFlockctlBlock() + "\n";

  if (next === current) return;

  const tmpPath = gitignorePath + ".tmp";
  writeFileSync(tmpPath, next, "utf-8");
  renameSync(tmpPath, gitignorePath);
}

// Silence unused-import lint when this file grows; statSync is reserved for
// future use by a symlink freshness check.
void statSync;
