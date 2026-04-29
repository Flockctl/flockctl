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
import { dirname, isAbsolute, join } from "path";
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
  ensureGitExclude(project.path, gitExcludeOptionsFromRow(project));
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
  ensureGitExclude(workspace.path, gitExcludeOptionsFromRow(workspace));
}

/**
 * Derive {@link GitExcludeOptions} from a `projects`/`workspaces` row. Keeps
 * caller sites in this file — and in `mcp-sync.ts`, which reconciles the
 * *same* `.git/info/exclude` on behalf of other entities — from each
 * re-implementing the flag plumbing.
 *
 * Note: the DB column names retain the historical `gitignore*` prefix; the
 * flags now drive `.git/info/exclude` (local-only), but the public API
 * contract on `projects`/`workspaces` rows is preserved to avoid a breaking
 * schema migration. See migration 0038 for the columns themselves.
 */
export function gitExcludeOptionsFromRow(
  row: { gitignoreFlockctl?: boolean | null; gitignoreTodo?: boolean | null; gitignoreAgentsMd?: boolean | null } | null | undefined,
): GitExcludeOptions {
  return {
    flockctl: row?.gitignoreFlockctl === true,
    todo: row?.gitignoreTodo === true,
    agentsMd: row?.gitignoreAgentsMd === true,
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

  // Skills marked `nativeInTarget` are sourced from `<targetDir>/<name>` itself
  // (project-owned `.claude/skills/<name>` when `use_project_claude_skills` is
  // on). The directory IS the user's real content — the reconciler must NOT
  // unlink it (cleanup pass below treats non-symlink entries as untouched
  // already, but the desired-set must also exclude these so we don't try to
  // symlink a path onto itself).
  const desired = new Map<string, string>();
  for (const s of skills) {
    if (s.nativeInTarget) continue;
    desired.set(s.name, s.sourceDir);
  }

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

// Base patterns always present inside the Flockctl-managed block in
// `.git/info/exclude`. These are infrastructure files Flockctl writes into
// the project tree that are never useful under version control (symlinks,
// reconcile markers, auto-managed `.mcp.json` containing resolved secrets).
const GIT_EXCLUDE_BASE_PATTERNS = [
  ".claude/skills/",
  ".mcp.json",
  ".flockctl/.skills-reconcile",
  ".flockctl/.mcp-reconcile",
  ".flockctl/.agents-reconcile",
  ".flockctl/import-backup/",
  ".flockctl/plan/",
];

// Optional patterns, each gated by a dedicated DB flag. See migration 0038.
const GIT_EXCLUDE_FLOCKCTL_PATTERN = ".flockctl/";
const GIT_EXCLUDE_TODO_PATTERN = "TODO.md";
// AGENTS.md and CLAUDE.md are paired: both are agent-guidance files and
// Flockctl treats them as a single concept on the UI side, so one toggle
// covers both. Order matters for byte-stability of the written block.
const GIT_EXCLUDE_AGENTS_PATTERNS = ["AGENTS.md", "CLAUDE.md"];

// Every pattern this module has ever written into the marked block. Used by
// the idempotency pass below — and by the legacy `.gitignore` cleanup pass —
// to strip stale lines regardless of which flag combination produced them.
const ALL_MANAGED_PATTERNS = new Set<string>([
  ...GIT_EXCLUDE_BASE_PATTERNS,
  GIT_EXCLUDE_FLOCKCTL_PATTERN,
  GIT_EXCLUDE_TODO_PATTERN,
  ...GIT_EXCLUDE_AGENTS_PATTERNS,
]);

// Same marker text in both `.gitignore` (legacy) and `.git/info/exclude`
// (current target). Lets the cleanup regex work across both files without
// branching, and keeps any stray Flockctl block visually consistent if it
// ever lands somewhere unexpected.
const GIT_EXCLUDE_BEGIN_MARKER = "# ─── Flockctl (auto-managed — do not edit) ───";
const GIT_EXCLUDE_END_MARKER = "# ─── /Flockctl ───";

export interface GitExcludeOptions {
  /** Ignore the whole `.flockctl/` directory instead of listing sub-paths. */
  flockctl?: boolean;
  /** Ignore root-level `TODO.md`. */
  todo?: boolean;
  /** Ignore root-level `AGENTS.md` and `CLAUDE.md` (paired). */
  agentsMd?: boolean;
}

function buildPatternList(opts: GitExcludeOptions): string[] {
  const patterns: string[] = [];
  if (opts.flockctl) {
    // When the whole `.flockctl/` tree is ignored, the granular entries
    // under it would just duplicate what the directory entry already covers,
    // so drop them for a clean block.
    patterns.push(".claude/skills/", ".mcp.json", GIT_EXCLUDE_FLOCKCTL_PATTERN);
  } else {
    patterns.push(...GIT_EXCLUDE_BASE_PATTERNS);
  }
  if (opts.todo) patterns.push(GIT_EXCLUDE_TODO_PATTERN);
  if (opts.agentsMd) patterns.push(...GIT_EXCLUDE_AGENTS_PATTERNS);
  return patterns;
}

function buildFlockctlBlock(opts: GitExcludeOptions): string {
  return [GIT_EXCLUDE_BEGIN_MARKER, ...buildPatternList(opts), GIT_EXCLUDE_END_MARKER].join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MANAGED_BLOCK_REGEX = new RegExp(
  `\\n*${escapeRegExp(GIT_EXCLUDE_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(GIT_EXCLUDE_END_MARKER)}\\n*`,
  "g",
);

/**
 * Strip both the marked Flockctl block AND any bare managed lines from the
 * given content. Shared by the `.git/info/exclude` writer (idempotency pass)
 * and the `.gitignore` legacy-cleanup pass.
 */
function stripManagedSections(content: string): string {
  const withoutBlock = content.replace(MANAGED_BLOCK_REGEX, "\n");
  return withoutBlock
    .split("\n")
    .filter((line) => !ALL_MANAGED_PATTERNS.has(line.trim()))
    .join("\n");
}

/**
 * Resolve the path to `.git/info/exclude` for `dir`.
 *
 * Returns:
 *   - `<dir>/.git/info/exclude` when `<dir>/.git` is a directory (normal repo)
 *   - the resolved `<gitdir>/info/exclude` when `<dir>/.git` is a *file*
 *     containing a `gitdir:` pointer (linked worktrees and submodules)
 *   - `null` when `<dir>` is not a git checkout — caller should no-op.
 */
function resolveGitInfoExcludePath(dir: string): string | null {
  const gitPath = join(dir, ".git");
  let stat;
  try {
    stat = lstatSync(gitPath);
  } catch {
    return null; // not a git repo
  }

  if (stat.isDirectory()) {
    return join(gitPath, "info", "exclude");
  }

  if (stat.isFile()) {
    // Linked worktree or submodule: file content is "gitdir: <path>" —
    // path is absolute or relative to `dir` per `gitrepository-layout(5)`.
    let content: string;
    try {
      content = readFileSync(gitPath, "utf-8");
    } catch {
      /* v8 ignore next — defensive: read failure on lstat-checked file */
      return null;
    }
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    /* v8 ignore next — defensive: regex group is non-empty when the line matches */
    if (!match || !match[1]) return null;
    const raw = match[1].trim();
    const gitdir = isAbsolute(raw) ? raw : join(dir, raw);
    return join(gitdir, "info", "exclude");
  }

  /* v8 ignore next 2 — defensive: `.git` is neither dir nor file (e.g. socket) */
  return null;
}

/**
 * One-time migration: strip the legacy Flockctl-managed block (and any bare
 * managed lines) from `<dir>/.gitignore`. Earlier versions of Flockctl wrote
 * those entries into the team-tracked `.gitignore`; they now live in
 * `.git/info/exclude` instead. Idempotent — leaves `.gitignore` untouched
 * when no managed content is found.
 */
function stripLegacyGitignoreBlock(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) return;

  let current: string;
  try {
    current = readFileSync(gitignorePath, "utf-8");
  } catch {
    /* v8 ignore next — defensive: read failure on existsSync-checked file */
    return;
  }

  const cleaned = stripManagedSections(current);
  // Preserve a single trailing newline iff the file had any user content
  // left, to keep behaviour predictable for downstream tools that expect it.
  const trimmed = cleaned.replace(/\s+$/, "");
  const next = trimmed === "" ? "" : trimmed + "\n";

  if (next === current) return;

  const tmpPath = gitignorePath + ".tmp";
  writeFileSync(tmpPath, next, "utf-8");
  renameSync(tmpPath, gitignorePath);
}

/**
 * Write (or refresh) the marked Flockctl block in `<dir>/.git/info/exclude`.
 *
 * - No-op when `<dir>` is not a git checkout (no `.git` directory or file
 *   pointer present). Writing to `.git/info/exclude` requires the file to
 *   live inside an existing `.git/` tree; we never create one ourselves.
 * - Idempotent: re-running with the same options leaves the file
 *   byte-identical.
 * - Always strips the legacy Flockctl-managed block from `<dir>/.gitignore`
 *   on every call (one-time migration). This is cheap when the file lacks
 *   any managed content and the on-disk state stays untouched.
 *
 * The base patterns (skills symlinks, `.mcp.json`, reconcile markers) are
 * always written. The `flockctl` / `todo` / `agentsMd` options layer extra
 * patterns on top, gated by user-facing toggles persisted on the project /
 * workspace row (see {@link gitExcludeOptionsFromRow}).
 */
export function ensureGitExclude(dir: string, options: GitExcludeOptions = {}): void {
  // Always run the legacy cleanup — even outside git checkouts the user
  // may have a `.gitignore` they want freed of stale Flockctl lines.
  stripLegacyGitignoreBlock(dir);

  const excludePath = resolveGitInfoExcludePath(dir);
  if (!excludePath) return; // not a git repo — silent no-op

  // `.git/info/` exists by default in every `git init`-ed repo, but be
  // tolerant of users who pruned it: it's local-only state, safe to recreate.
  mkdirSync(dirname(excludePath), { recursive: true });

  let current = "";
  if (existsSync(excludePath)) {
    try {
      current = readFileSync(excludePath, "utf-8");
    } catch {
      /* v8 ignore next — defensive: read failure on existsSync-checked file */
      return;
    }
  }

  const cleaned = stripManagedSections(current);
  const trimmed = cleaned.replace(/\s+$/, "");
  const prefix = trimmed === "" ? "" : trimmed + "\n\n";
  const next = prefix + buildFlockctlBlock(options) + "\n";

  if (next === current) return;

  const tmpPath = excludePath + ".tmp";
  writeFileSync(tmpPath, next, "utf-8");
  renameSync(tmpPath, excludePath);
}

// Silence unused-import lint when this file grows; statSync is reserved for
// future use by a symlink freshness check.
void statSync;
