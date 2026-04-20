import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects, workspaces } from "../db/schema.js";
import { ensureGitignore } from "./claude-skills-sync.js";

const SOURCE_FILE = "AGENTS.md";
const ROOT_FILE = "AGENTS.md";
const SYMLINK_FILE = "CLAUDE.md";
const RECONCILE_MARKER = ".agents-reconcile";

/**
 * Read editable AGENTS.md source from <project>/.flockctl/AGENTS.md.
 * Returns "" if the file doesn't exist (treated as empty source).
 */
export function loadProjectAgentsSource(projectPath: string): string {
  return readSourceFile(join(projectPath, ".flockctl", SOURCE_FILE));
}

export function loadWorkspaceAgentsSource(workspacePath: string): string {
  return readSourceFile(join(workspacePath, ".flockctl", SOURCE_FILE));
}

export function saveProjectAgentsSource(projectPath: string, content: string): void {
  writeSourceFile(join(projectPath, ".flockctl"), content);
}

export function saveWorkspaceAgentsSource(workspacePath: string, content: string): void {
  writeSourceFile(join(workspacePath, ".flockctl"), content);
}

/**
 * Read effective merged AGENTS.md from the directory root (what agents see).
 */
export function loadProjectAgentsEffective(projectPath: string): string {
  return readSourceFile(join(projectPath, ROOT_FILE));
}

export function loadWorkspaceAgentsEffective(workspacePath: string): string {
  return readSourceFile(join(workspacePath, ROOT_FILE));
}

/**
 * Reconcile project: merge workspace + project source into <project>/AGENTS.md
 * and create/refresh <project>/CLAUDE.md → AGENTS.md symlink.
 */
export function reconcileAgentsForProject(projectId: number): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.path || !existsSync(project.path)) return;

  let workspaceSource = "";
  if (project.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
    if (ws?.path && existsSync(ws.path)) {
      workspaceSource = loadWorkspaceAgentsSource(ws.path);
    }
  }
  const projectSource = loadProjectAgentsSource(project.path);
  const merged = mergeAgents(workspaceSource, projectSource);

  writeRootAgents(project.path, merged);
  writeClaudeSymlink(project.path);
  writeReconcileMarker(join(project.path, ".flockctl"));
  ensureGitignore(project.path);
}

/**
 * Reconcile workspace: write workspace source verbatim to <workspace>/AGENTS.md
 * and create/refresh <workspace>/CLAUDE.md → AGENTS.md symlink.
 */
export function reconcileAgentsForWorkspace(workspaceId: number): void {
  const db = getDb();
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws?.path || !existsSync(ws.path)) return;

  const source = loadWorkspaceAgentsSource(ws.path);
  // Workspace has no parent — its effective AGENTS.md is just its source,
  // wrapped with the auto-generated header so agents know not to edit it.
  const effective = buildWorkspaceRootAgents(source);

  writeRootAgents(ws.path, effective);
  writeClaudeSymlink(ws.path);
  writeReconcileMarker(join(ws.path, ".flockctl"));
  ensureGitignore(ws.path);
}

/**
 * Re-reconcile workspace + every project under it. Used when workspace source
 * changes so children can pick up the new cascade.
 */
export function reconcileAllProjectsInWorkspaceAgents(workspaceId: number): void {
  try {
    reconcileAgentsForWorkspace(workspaceId);
  } catch (err) {
    /* v8 ignore next — defensive: workspace reconciler shouldn't throw */
    console.error(`[agents-sync] workspace ${workspaceId} failed:`, err);
  }

  const db = getDb();
  const children = db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).all();
  for (const p of children) {
    try {
      reconcileAgentsForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[agents-sync] project ${p.id} failed:`, err);
    }
  }
}

/**
 * Reconcile every workspace and project. Used on startup to catch drift from
 * teammate pulls or prior crashes.
 */
export function reconcileAllAgents(): void {
  const db = getDb();
  const allWorkspaces = db.select().from(workspaces).all();
  for (const ws of allWorkspaces) {
    try {
      reconcileAgentsForWorkspace(ws.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-workspace reconciler shouldn't throw */
      console.error(`[agents-sync] workspace ${ws.id} failed:`, err);
    }
  }

  const allProjects = db.select().from(projects).all();
  for (const p of allProjects) {
    try {
      reconcileAgentsForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[agents-sync] project ${p.id} failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure merge logic — exported for unit tests
// ---------------------------------------------------------------------------

const PROJECT_HEADER =
  `<!-- AUTO-GENERATED by swarmctl — do not edit this file directly.\n` +
  `     CLAUDE.md in this directory is a symlink to this file.\n\n` +
  `     To change agent guidance:\n` +
  `       - Edit  .flockctl/AGENTS.md  in this project for project-specific rules.\n` +
  `       - Edit  .flockctl/AGENTS.md  in the parent workspace for rules shared across projects.\n` +
  `     The root AGENTS.md is regenerated automatically on the next reconcile. -->`;

const WORKSPACE_HEADER =
  `<!-- AUTO-GENERATED by swarmctl — do not edit this file directly.\n` +
  `     CLAUDE.md in this directory is a symlink to this file.\n\n` +
  `     To change agent guidance, edit  .flockctl/AGENTS.md  in this workspace.\n` +
  `     Those rules also cascade into every project's AGENTS.md in this workspace. -->`;

/**
 * Combine workspace + project AGENTS.md content into a single deterministic
 * string for the project-root AGENTS.md. Pure function — same inputs always
 * produce the same bytes.
 *
 * - Both empty → ""
 * - Otherwise → auto-generated header followed by the non-empty block(s),
 *   each wrapped in BEGIN/END comment markers. Output always ends with
 *   exactly one trailing "\n".
 */
export function mergeAgents(workspaceSource: string, projectSource: string): string {
  const ws = workspaceSource.trim();
  const proj = projectSource.trim();

  if (!ws && !proj) return "";

  const blocks: string[] = [];
  if (ws) {
    blocks.push(
      `<!-- BEGIN workspace AGENTS.md (from <workspace>/.flockctl/AGENTS.md) -->\n\n` +
        `${ws}\n\n` +
        `<!-- END workspace AGENTS.md -->`,
    );
  }
  if (proj) {
    blocks.push(
      `<!-- BEGIN project AGENTS.md (from <project>/.flockctl/AGENTS.md) -->\n\n` +
        `${proj}\n\n` +
        `<!-- END project AGENTS.md -->`,
    );
  }

  return `${PROJECT_HEADER}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Build the workspace-root AGENTS.md: source content prepended with the
 * auto-generated header. Empty source → "" (caller removes the file).
 */
export function buildWorkspaceRootAgents(source: string): string {
  const s = source.trim();
  if (!s) return "";
  return `${WORKSPACE_HEADER}\n\n${s}\n`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readSourceFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function writeSourceFile(flockctlDir: string, content: string): void {
  mkdirSync(flockctlDir, { recursive: true });
  writeAtomic(join(flockctlDir, SOURCE_FILE), content);
}

function writeRootAgents(rootDir: string, content: string): void {
  const finalPath = join(rootDir, ROOT_FILE);

  // Empty merged content: remove the file if it exists. This avoids leaving a
  // stale generated AGENTS.md in the repo when both sources are cleared.
  if (content === "") {
    if (existsSync(finalPath)) {
      try {
        unlinkSync(finalPath);
      } catch (err) {
        /* v8 ignore next — defensive: unlink fails only on permission/race */
        console.warn(`[agents-sync] failed to remove empty ${finalPath}:`, err);
      }
    }
    return;
  }

  writeAtomic(finalPath, content);
}

function writeClaudeSymlink(rootDir: string): void {
  const symlinkPath = join(rootDir, SYMLINK_FILE);
  const agentsPath = join(rootDir, ROOT_FILE);

  // No source AGENTS.md → nothing to point at; remove a stale symlink.
  if (!existsSync(agentsPath)) {
    if (existsSync(symlinkPath) || isBrokenSymlink(symlinkPath)) {
      try {
        const lst = lstatSync(symlinkPath);
        if (lst.isSymbolicLink()) unlinkSync(symlinkPath);
      } catch {
        // not a symlink or already gone
      }
    }
    return;
  }

  let lst;
  try {
    lst = lstatSync(symlinkPath);
  } catch {
    lst = null;
  }

  if (lst && !lst.isSymbolicLink()) {
    /* v8 ignore next 3 — covered indirectly; warn message is the only side-effect */
    console.warn(
      `[agents-sync] ${symlinkPath} is a regular file — leaving it untouched. Delete it manually if you want CLAUDE.md to track AGENTS.md.`,
    );
    return;
  }

  if (lst?.isSymbolicLink()) {
    try {
      const current = readlinkSync(symlinkPath);
      if (current === ROOT_FILE) return;
    } catch {
      // fall through to recreate
    }
    try {
      unlinkSync(symlinkPath);
    } catch (err) {
      /* v8 ignore next 2 — defensive: unlink races with file removal */
      console.warn(`[agents-sync] failed to unlink ${symlinkPath}:`, err);
      return;
    }
  }

  try {
    symlinkSync(ROOT_FILE, symlinkPath);
  } catch (err) {
    /* v8 ignore next — defensive: symlink fails only on permission/race */
    console.warn(`[agents-sync] failed to symlink ${symlinkPath} -> ${ROOT_FILE}:`, err);
  }
}

function writeReconcileMarker(flockctlDir: string): void {
  mkdirSync(flockctlDir, { recursive: true });
  const finalPath = join(flockctlDir, RECONCILE_MARKER);
  const content = JSON.stringify({ reconciled_at: new Date().toISOString() }, null, 2) + "\n";
  writeAtomic(finalPath, content);
}

/**
 * Atomic byte-stable write: skip when content matches existing file bytes,
 * otherwise write to .tmp + rename. Mirrors `writeManifest()` in
 * claude-skills-sync.ts so generated files don't churn git diffs.
 */
function writeAtomic(finalPath: string, content: string): void {
  try {
    if (existsSync(finalPath) && readFileSync(finalPath, "utf-8") === content) return;
  } catch {
    // fall through to write
  }
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

function isBrokenSymlink(path: string): boolean {
  try {
    const lst = lstatSync(path);
    return lst.isSymbolicLink();
  } catch {
    /* v8 ignore next — lstat throws only when path is missing */
    return false;
  }
}
