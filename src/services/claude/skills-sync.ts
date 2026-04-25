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
import { getDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import { resolveSkillsForProject, resolveSkillsForWorkspace, type Skill } from "../skills.js";

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
  ensureGitignore(project.path, gitignoreOptionsFromRow(project));
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
  ensureGitignore(workspace.path, gitignoreOptionsFromRow(workspace));
}

/**
 * Derive {@link GitignoreOptions} from a `projects`/`workspaces` row. Keeps
 * caller sites in this file — and in `mcp-sync.ts`, which reconciles the
 * *same* `.gitignore` on behalf of other entities — from each re-implementing
 * the flag plumbing.
 */
export function gitignoreOptionsFromRow(
  row: { gitignoreFlockctl?: boolean | null; gitignoreTodo?: boolean | null; gitignoreAgentsMd?: boolean | null } | null | undefined,
): GitignoreOptions {
  const flockctl = row?.gitignoreFlockctl === true;
  const todo = row?.gitignoreTodo === true;
  const agentsMd = row?.gitignoreAgentsMd === true;
  // When the user has explicitly turned on at least one flag we create
  // `.gitignore` if missing — otherwise the preference would be silently
  // dropped on freshly `git init`-ed checkouts that have no file yet.
  // With all flags off the call stays a no-op in non-git dirs.
  return {
    flockctl,
    todo,
    agentsMd,
    createIfMissing: flockctl || todo || agentsMd,
  };
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

// Base patterns always present inside the Flockctl-managed block when the
// directory already contains a `.gitignore`. These are infrastructure files
// Flockctl writes into the project tree that are never useful under version
// control (symlinks, reconcile markers, auto-managed `.mcp.json`).
const GITIGNORE_BASE_PATTERNS = [
  ".claude/skills/",
  ".mcp.json",
  ".flockctl/.skills-reconcile",
  ".flockctl/.mcp-reconcile",
  ".flockctl/.agents-reconcile",
  ".flockctl/import-backup/",
  ".flockctl/plan/",
];

// Optional patterns, each gated by a dedicated DB flag. See migration 0038.
const GITIGNORE_FLOCKCTL_PATTERN = ".flockctl/";
const GITIGNORE_TODO_PATTERN = "TODO.md";
// AGENTS.md and CLAUDE.md are paired: both are agent-guidance files and
// Flockctl treats them as a single concept on the UI side, so one toggle
// covers both. Order matters for byte-stability of the written block.
const GITIGNORE_AGENTS_PATTERNS = ["AGENTS.md", "CLAUDE.md"];

// Every pattern this module has ever written into the marked block. Used by
// the idempotency pass below to strip stale lines regardless of whether they
// were produced by the current flag configuration or by a prior one.
const ALL_MANAGED_PATTERNS = new Set<string>([
  ...GITIGNORE_BASE_PATTERNS,
  GITIGNORE_FLOCKCTL_PATTERN,
  GITIGNORE_TODO_PATTERN,
  ...GITIGNORE_AGENTS_PATTERNS,
]);

const GITIGNORE_BEGIN_MARKER = "# ─── Flockctl (auto-managed — do not edit) ───";
const GITIGNORE_END_MARKER = "# ─── /Flockctl ───";

export interface GitignoreOptions {
  /** Ignore the whole `.flockctl/` directory instead of listing sub-paths. */
  flockctl?: boolean;
  /** Ignore root-level `TODO.md`. */
  todo?: boolean;
  /** Ignore root-level `AGENTS.md` and `CLAUDE.md` (paired). */
  agentsMd?: boolean;
  /**
   * Create `<dir>/.gitignore` if it does not exist. Default `false` — stay
   * non-invasive in directories that are not git repos. The route layer
   * flips this to `true` when the user enables any flag explicitly so the
   * preference is honoured even in a fresh checkout.
   */
  createIfMissing?: boolean;
}

function buildPatternList(opts: GitignoreOptions): string[] {
  const patterns: string[] = [];
  if (opts.flockctl) {
    // When the whole `.flockctl/` tree is ignored, the granular entries
    // under it would just duplicate what the directory entry already covers,
    // so drop them for a clean block.
    patterns.push(".claude/skills/", ".mcp.json", GITIGNORE_FLOCKCTL_PATTERN);
  } else {
    patterns.push(...GITIGNORE_BASE_PATTERNS);
  }
  if (opts.todo) patterns.push(GITIGNORE_TODO_PATTERN);
  if (opts.agentsMd) patterns.push(...GITIGNORE_AGENTS_PATTERNS);
  return patterns;
}

function buildFlockctlBlock(opts: GitignoreOptions): string {
  return [GITIGNORE_BEGIN_MARKER, ...buildPatternList(opts), GITIGNORE_END_MARKER].join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append (or refresh) a marked Flockctl block in <dir>/.gitignore.
 * Migrates raw entries from prior versions into the block. No-op when
 * <dir>/.gitignore is missing unless `createIfMissing` is set — that flag
 * is only passed when the caller explicitly enables one of the user-facing
 * toggles so we never pollute non-git dirs by accident.
 */
export function ensureGitignore(dir: string, options: GitignoreOptions = {}): void {
  const gitignorePath = join(dir, ".gitignore");
  const fileExists = existsSync(gitignorePath);
  const anyToggleOn = Boolean(options.flockctl || options.todo || options.agentsMd);
  if (!fileExists && !(options.createIfMissing && anyToggleOn)) return;

  let current = "";
  if (fileExists) {
    try {
      current = readFileSync(gitignorePath, "utf-8");
    } catch {
      /* v8 ignore next — defensive: read failure on existsSync-checked file */
      return;
    }
  }

  const blockRegex = new RegExp(
    `\\n*${escapeRegExp(GITIGNORE_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(GITIGNORE_END_MARKER)}\\n*`,
    "g",
  );
  const withoutBlock = current.replace(blockRegex, "\n");
  // Strip any bare managed lines that leaked outside the block (e.g. from
  // older Flockctl versions, or a user hand-editing patterns we now own).
  // Using ALL_MANAGED_PATTERNS rather than the current flag-dependent list
  // guarantees stale entries disappear even after the user flips a flag off.
  const cleaned = withoutBlock
    .split("\n")
    .filter((line) => !ALL_MANAGED_PATTERNS.has(line.trim()))
    .join("\n");

  const trimmed = cleaned.replace(/\s+$/, "");
  const prefix = trimmed === "" ? "" : trimmed + "\n\n";
  const next = prefix + buildFlockctlBlock(options) + "\n";

  if (next === current) return;

  const tmpPath = gitignorePath + ".tmp";
  writeFileSync(tmpPath, next, "utf-8");
  renameSync(tmpPath, gitignorePath);
}

// Silence unused-import lint when this file grows; statSync is reserved for
// future use by a symlink freshness check.
void statSync;
