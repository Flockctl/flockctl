import { execFileSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

/**
 * worktree-manager — per-task / per-chat git-worktree isolation.
 *
 * Design contract (matches `claude --worktree` semantics):
 *
 * - **Opt-in.** Callers only invoke this module when the owning row has
 *   `isolation = 'worktree'`. NULL isolation = legacy behaviour, no
 *   worktree, this module never runs.
 * - **Branched from current HEAD of the project's main worktree** (the
 *   operator's currently checked-out branch — confirmed by the user).
 *   We do NOT base on `origin/HEAD` so a developer working in a feature
 *   branch sees their own work as the starting point.
 * - **Stored under `<project>/.flockctl/worktrees/<owner-kind>-<owner-id>/`**.
 *   In-tree (mirrors claude-code's `.claude/worktrees/<slug>` layout) so
 *   the operator finds them by browsing the project. The `.flockctl/`
 *   directory is already in `.git/info/exclude` via skills-sync, so the
 *   nested worktree directories don't pollute `git status` of the main
 *   worktree.
 * - **Branch name `flockctl/<owner-kind>-<owner-id>`** (no hash suffix —
 *   confirmed by the user). Predictable so operators can reason about
 *   `git branch --list flockctl/*` output.
 * - **Cleanup is operator-driven for chats, automatic-when-clean for
 *   tasks.** This module only exposes the primitives; lifecycle policy
 *   lives in the executor / route layer.
 * - **Idempotent create.** If the worktree directory already exists AND
 *   is registered with git, `createWorktree` returns it as-is with
 *   `reused: true`. Lets task retries / daemon restarts reattach to a
 *   pre-existing worktree without surprise.
 * - **No shell.** All git invocations go through `execFileSync` with an
 *   argv array — operator-supplied paths and branch names cannot be
 *   shell-reinterpreted.
 *
 * Edge cases this module does NOT handle (caller's responsibility):
 *
 * - **Project is not a git repo.** `createWorktree` throws
 *   `WorktreeError('not_a_git_repo')`. Callers (executor-setup,
 *   resolveChatCwd) catch this and fall back to non-isolated mode with
 *   a warning. Doing the silent-fallback HERE would hide the failure
 *   from telemetry.
 * - **Project has no commits yet.** `git worktree add` fails because
 *   there's no HEAD; we surface `WorktreeError('no_initial_commit')`.
 * - **Concurrent creation for the same owner.** The DB write that
 *   reserves the row id is the serialisation point — autoincrement
 *   guarantees a unique id, and the per-id worktree path/branch are
 *   thus unique. If two threads race on the same id (shouldn't happen)
 *   the second `git worktree add` fails and the loser falls back to
 *   `reused: true` via the idempotency check.
 */

const BRANCH_PREFIX = "flockctl";
const WORKTREES_SUBDIR_PARTS = [".flockctl", "worktrees"] as const;

export type WorktreeOwnerKind = "task" | "chat";

export type WorktreeErrorCode =
  | "not_a_git_repo"
  | "no_initial_commit"
  | "git_command_failed"
  | "worktree_path_blocked";

export class WorktreeError extends Error {
  constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface CreateWorktreeOptions {
  /** Absolute path to the project's main worktree (= `projects.path`). */
  projectPath: string;
  ownerKind: WorktreeOwnerKind;
  /** Owner row's primary key (`tasks.id` or `chats.id`). */
  ownerId: number;
}

export interface CreateWorktreeResult {
  /** Absolute path to the new worktree directory. */
  path: string;
  /** Branch name created with the worktree. */
  branch: string;
  /** True iff the worktree pre-existed and we returned it as-is. */
  reused: boolean;
}

export interface WorktreeStatus {
  /** Does the worktree directory exist on disk? */
  pathExists: boolean;
  /** Is git aware of it (`git worktree list` mentions it)? */
  registered: boolean;
  /** `git status --porcelain` returned at least one line. */
  hasUncommittedChanges: boolean;
}

export interface CleanupResult {
  removed: boolean;
  reason: "clean" | "dirty" | "missing" | "not_a_git_repo";
}

export interface ApplyWorktreeOptions {
  projectPath: string;
  worktreePath: string;
  /** Branch the worktree owns (`flockctl/<kind>-<id>`). */
  branch: string;
}

export type ApplyWorktreeReason =
  | "merged" // merge commit produced (or fast-forward landed)
  | "already_merged" // source is already an ancestor of target HEAD — no-op success
  | "worktree_dirty" // worktree has uncommitted changes — refuse
  | "project_dirty" // project's main directory has uncommitted changes — refuse
  | "project_detached" // project is on detached HEAD — no target branch to land on
  | "conflict" // merge produced conflicts; we ran `git merge --abort`
  | "not_a_git_repo";

export interface ApplyWorktreeResult {
  /** True iff the merge committed OR was already an ancestor (no-op). */
  applied: boolean;
  reason: ApplyWorktreeReason;
  sourceBranch: string;
  /** Branch we merged INTO, i.e. project's HEAD at apply time. */
  targetBranch: string;
  /** New tip of `targetBranch` after the merge. Only set when `applied`. */
  mergeCommit?: string;
  /** Conflict file list. Only set when `reason === 'conflict'`. */
  conflicts?: string[];
}

export interface ListWorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  /** True if the path is one Flockctl created (branch matches our prefix). */
  managed: boolean;
}

// ─── Path / branch helpers ───

export function buildBranchName(kind: WorktreeOwnerKind, ownerId: number): string {
  return `${BRANCH_PREFIX}/${kind}-${ownerId}`;
}

export function buildWorktreePath(
  projectPath: string,
  kind: WorktreeOwnerKind,
  ownerId: number,
): string {
  return join(projectPath, ...WORKTREES_SUBDIR_PARTS, `${kind}-${ownerId}`);
}

// ─── git plumbing ───

/**
 * Run `git <args>` in `cwd`, capturing stdout. Throws `WorktreeError`
 * with the captured stderr on non-zero exit. Always uses `execFileSync`
 * (no shell), so `cwd` and arg values are safe even with quotes /
 * semicolons / backticks.
 */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).toString();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf-8")
          : "";
    throw new WorktreeError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${e.message ?? "unknown"}`,
      stderr,
    );
  }
}

/** Try-variant of `git()` that returns null on failure rather than throwing. */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    /* v8 ignore next — `git()` always throws WorktreeError on non-zero
     * exit. The catch keeps this function null-safe regardless of how
     * the caller's surrounding workflow has gone wrong. */
    return null;
  }
}

/**
 * True iff `path` looks like a working tree of a git repository. Mirrors
 * the heuristic in `skills-sync.ts:resolveGitInfoExcludePath` — `.git`
 * may be a directory (normal repo) OR a file (linked worktree /
 * submodule with a `gitdir:` pointer).
 */
function isGitWorkTree(path: string): boolean {
  const dotGit = join(path, ".git");
  let stat;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return true;
  if (stat.isFile()) {
    try {
      const txt = readFileSync(dotGit, "utf-8");
      return /^gitdir:\s*\S+/m.test(txt);
    } catch {
      /* v8 ignore next — defensive: lstatSync above already proved
       * `dotGit` is a readable file; reaching this branch implies a
       * race (file was deleted between the lstat and the read). */
      return false;
    }
  }
  /* v8 ignore next 2 — defensive: `.git` is neither dir nor file
   * (e.g. socket, symlink to nowhere). git itself wouldn't recognise
   * such a checkout either. */
  return false;
}

/**
 * True iff the project has at least one commit on the current branch.
 * `git worktree add HEAD` requires a resolvable HEAD — a brand-new
 * `git init` repo has none.
 */
function hasInitialCommit(projectPath: string): boolean {
  return gitTry(projectPath, ["rev-parse", "--verify", "HEAD"]) !== null;
}

// ─── public API ───

/**
 * Create (or reattach to) a per-owner git worktree.
 *
 * Idempotent: if `<projectPath>/.flockctl/worktrees/<kind>-<id>/` already
 * exists AND is registered with git, returns it with `reused: true`. If
 * the directory exists but is NOT registered, raises
 * `WorktreeError('worktree_path_blocked')` rather than clobbering it.
 */
export function createWorktree(opts: CreateWorktreeOptions): CreateWorktreeResult {
  const { projectPath, ownerKind, ownerId } = opts;

  if (!isAbsolute(projectPath)) {
    throw new WorktreeError(
      "git_command_failed",
      `projectPath must be absolute, got: ${projectPath}`,
    );
  }
  if (!isGitWorkTree(projectPath)) {
    throw new WorktreeError("not_a_git_repo", `${projectPath} is not a git working tree`);
  }
  if (!hasInitialCommit(projectPath)) {
    throw new WorktreeError(
      "no_initial_commit",
      `${projectPath} has no HEAD yet — make an initial commit before using isolation`,
    );
  }

  const wtPath = buildWorktreePath(projectPath, ownerKind, ownerId);
  const branch = buildBranchName(ownerKind, ownerId);

  // Idempotency: existing path + registered worktree → reuse.
  if (existsSync(wtPath)) {
    if (isGitWorkTree(wtPath)) {
      return { path: wtPath, branch, reused: true };
    }
    throw new WorktreeError(
      "worktree_path_blocked",
      `path ${wtPath} exists but is not a git worktree — refusing to clobber`,
    );
  }

  // Ensure parent `<project>/.flockctl/worktrees/` exists. The leaf
  // (`<kind>-<id>/`) MUST NOT exist — `git worktree add` requires the
  // target to be absent.
  const parentDir = join(projectPath, ...WORKTREES_SUBDIR_PARTS);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Branch may already exist from a prior aborted run that left the DB
  // row but lost the worktree directory. In that case we attach to the
  // existing branch instead of creating a fresh one (`-B` would reset
  // it; we want the existing tip preserved).
  const branchExists =
    gitTry(projectPath, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== null;

  if (branchExists) {
    git(projectPath, ["worktree", "add", wtPath, branch]);
  } else {
    // -b creates the branch from HEAD (operator's current branch — per
    // the design decision documented at the top of this file).
    git(projectPath, ["worktree", "add", "-b", branch, wtPath, "HEAD"]);
  }

  return { path: wtPath, branch, reused: false };
}

/**
 * Snapshot a worktree's status for cleanup decisions. Cheap — three
 * `git` invocations, no network.
 */
export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  if (!existsSync(worktreePath)) {
    return { pathExists: false, registered: false, hasUncommittedChanges: false };
  }
  if (!isGitWorkTree(worktreePath)) {
    return { pathExists: true, registered: false, hasUncommittedChanges: false };
  }

  // `git status --porcelain` is silent for a clean tree. Any output =
  // dirty (untracked files included — agents that wrote files but didn't
  // commit them will surface here).
  const porcelain = gitTry(worktreePath, ["status", "--porcelain"]) ?? "";
  return {
    pathExists: true,
    registered: true,
    hasUncommittedChanges: porcelain.trim().length > 0,
  };
}

/**
 * Force-remove a worktree and its branch. Used by manual cleanup
 * endpoints (DELETE /tasks/:id/worktree, DELETE /chats/:id/worktree)
 * and by `cleanupIfClean` once it has decided "clean enough to nuke".
 *
 * `force: true` passes `--force` to `git worktree remove`, which lets
 * git delete a worktree with uncommitted changes. Branch deletion is
 * always with `-D` (force) — the branch is just our temp marker; no
 * upstream tracking, no merge-base checks.
 *
 * Best-effort: a missing worktree directory or unregistered worktree
 * still results in branch cleanup + `git worktree prune` to clear the
 * stale `.git/worktrees/<name>/` admin file.
 */
export function removeWorktree(opts: {
  projectPath: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
}): void {
  const { projectPath, worktreePath, branch, force } = opts;

  /* v8 ignore next 5 — defensive: covered by the cleanupIfClean
   * not_a_git_repo branch test for the parallel chat/task flow.
   * Reaching this branch directly through removeWorktree would
   * require an operator who manually deleted `.git/` mid-cleanup;
   * a contrived scenario exhaustive testing buys little. */
  if (!isGitWorkTree(projectPath)) {
    return;
  }

  if (existsSync(worktreePath) && isGitWorkTree(worktreePath)) {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    gitTry(projectPath, args); // Best-effort; if it fails we still try the branch and prune.
  }

  // Always prune to clear the admin file in `.git/worktrees/<name>/`
  // (a no-op if there's nothing to prune).
  gitTry(projectPath, ["worktree", "prune"]);

  // Best-effort branch removal. `-D` is fine because the branch was our
  // exclusive temp; if someone has it checked out elsewhere git refuses
  // and we surface that via the warn (caller decides what to do).
  gitTry(projectPath, ["branch", "-D", branch]);
}

/**
 * Cleanup-if-clean decision used by:
 *
 *   - Tasks on finalize (`executor.ts` post-run hook). Clean → remove,
 *     dirty → leave the worktree behind for operator review.
 *   - Chats on `POST /chats/:id/end-session` without `force=true`.
 *   - Chats on `DELETE /chats/:id` without `force=true` — dirty chats
 *     return 409 to prevent silent data loss.
 *
 * Returns `{ removed, reason }`. Callers persist the new state by
 * writing `worktree_path = NULL`, `worktree_branch = NULL` on the owner
 * row when `removed === true`.
 */
export function cleanupIfClean(opts: {
  projectPath: string;
  worktreePath: string;
  branch: string;
}): CleanupResult {
  const { projectPath, worktreePath, branch } = opts;

  if (!isGitWorkTree(projectPath)) {
    return { removed: false, reason: "not_a_git_repo" };
  }

  const status = getWorktreeStatus(worktreePath);

  // Missing on disk OR unregistered with git → consider it gone, but
  // still sweep the branch + prune so the DB row can be NULLed without
  // leaving git in a half-state.
  if (!status.pathExists || !status.registered) {
    gitTry(projectPath, ["worktree", "prune"]);
    gitTry(projectPath, ["branch", "-D", branch]);
    return { removed: true, reason: "missing" };
  }

  if (status.hasUncommittedChanges) {
    return { removed: false, reason: "dirty" };
  }

  removeWorktree({ projectPath, worktreePath, branch });
  return { removed: true, reason: "clean" };
}

/**
 * Apply (merge) the worktree's branch back into whatever branch is
 * currently checked out in the project's main directory. Counterpart
 * to `cleanupIfClean` — instead of throwing the agent's work away, this
 * lands it on the operator's working branch with a merge commit. The
 * worktree itself is left intact: the operator can keep iterating on
 * the chat after the merge, or hit "End session" separately to wipe it.
 *
 * Refuses (and never mutates the project) when:
 *
 *   - worktree has uncommitted changes (`worktree_dirty`) — the agent
 *     should commit before we land anything.
 *   - project's main directory has uncommitted changes (`project_dirty`)
 *     — merging into a dirty index would mix the operator's WIP with
 *     the chat's commits and make rollback ugly.
 *   - project is on detached HEAD (`project_detached`) — there's no
 *     branch to advance.
 *   - the merge produces conflicts (`conflict`) — we run `git merge
 *     --abort` to leave the project clean and surface the conflicting
 *     files so the operator can resolve manually.
 *
 * Idempotent: if the worktree branch is already an ancestor of the
 * project's HEAD (operator already merged via CLI, or a previous Apply
 * succeeded), reports `already_merged` instead of trying to merge
 * again.
 */
export function applyWorktreeBranch(
  opts: ApplyWorktreeOptions,
): ApplyWorktreeResult {
  const { projectPath, worktreePath, branch } = opts;

  if (!isGitWorkTree(projectPath)) {
    return {
      applied: false,
      reason: "not_a_git_repo",
      sourceBranch: branch,
      targetBranch: "",
    };
  }

  // Worktree must be clean — we're merging committed history, not
  // staging the agent's untracked drafts. Mirrors `cleanupIfClean`'s
  // dirty gate.
  const wtStatus = getWorktreeStatus(worktreePath);
  if (wtStatus.hasUncommittedChanges) {
    return {
      applied: false,
      reason: "worktree_dirty",
      sourceBranch: branch,
      targetBranch: "",
    };
  }

  // Project's main directory must be clean too — `git merge` refuses to
  // run on a dirty index, and even when it doesn't (no conflicting
  // paths), mixing operator WIP with the chat's merge commit is the
  // kind of "wait, what did I just commit" surprise that erodes trust.
  //
  // Filter `.flockctl/` out of the dirty signal: that directory holds
  // our nested worktrees and IS expected to appear as untracked when
  // `.git/info/exclude` hasn't been wired up yet (skills-sync only
  // writes the exclude entry when skills get synced, and a brand-new
  // isolated project may not have hit that path). Treating our own
  // namespace as "operator dirt" would mean Apply never works on a
  // pristine project — exactly the case we want to support.
  const projStatus = gitTry(projectPath, ["status", "--porcelain"]) ?? "";
  const dirtyLines = projStatus
    .split("\n")
    .filter((l) => l.length > 0)
    .filter((l) => {
      // Porcelain v1: "XY <path>" — XY is two status chars, then a
      // space, then the path (optionally wrapped in quotes for paths
      // with whitespace / control chars).
      const raw = l.slice(3);
      const path =
        raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      return path !== ".flockctl" && !path.startsWith(".flockctl/");
    });
  if (dirtyLines.length > 0) {
    return {
      applied: false,
      reason: "project_dirty",
      sourceBranch: branch,
      targetBranch: "",
    };
  }

  // Resolve target. `--abbrev-ref HEAD` returns the symbolic ref name,
  // or the literal string "HEAD" when detached. We refuse to land on a
  // detached HEAD because the merge would be lost on the next checkout.
  const targetRaw = gitTry(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const targetBranch = targetRaw?.trim() ?? "";
  if (!targetBranch || targetBranch === "HEAD") {
    return {
      applied: false,
      reason: "project_detached",
      sourceBranch: branch,
      targetBranch: targetBranch || "",
    };
  }

  // Ancestry pre-check: if the source is already reachable from HEAD,
  // the merge would be a no-op fast-forward. Treat that as success
  // (idempotent re-apply) rather than producing an empty merge commit.
  // `git merge-base --is-ancestor` exits 0 when source ⊆ HEAD, 1
  // otherwise — we can't use `git()` because exit-1 isn't an error.
  let isAncestor = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    isAncestor = true;
  } catch {
    isAncestor = false;
  }
  if (isAncestor) {
    const head = gitTry(projectPath, ["rev-parse", "HEAD"])?.trim();
    return {
      applied: true,
      reason: "already_merged",
      sourceBranch: branch,
      targetBranch,
      mergeCommit: head,
    };
  }

  // Run the merge. `--no-ff` forces a merge commit even when a
  // fast-forward would suffice — keeps the chat's work visible as a
  // single mergeable unit in the history rather than disappearing into
  // a linear log. `--no-edit` skips the editor prompt; we supply `-m`
  // explicitly.
  try {
    git(projectPath, [
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `Merge ${branch} into ${targetBranch}`,
      branch,
    ]);
  } catch {
    // Conflict (or other merge-time failure). Capture the unmerged
    // paths BEFORE we abort — `git merge --abort` clears the index
    // back to pre-merge state.
    const conflictsOut =
      gitTry(projectPath, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
    const conflicts = conflictsOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // Best-effort abort. If `git merge --abort` itself fails (e.g. the
    // merge had already been finalised somehow, or was never started
    // because git rejected it pre-flight), the project is left in
    // whatever state git produced — which is the safest outcome short
    // of `git reset --hard`, which we MUST NOT do here because it
    // would clobber operator work.
    gitTry(projectPath, ["merge", "--abort"]);

    return {
      applied: false,
      reason: "conflict",
      sourceBranch: branch,
      targetBranch,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  const mergeCommit = gitTry(projectPath, ["rev-parse", "HEAD"])?.trim();
  return {
    applied: true,
    reason: "merged",
    sourceBranch: branch,
    targetBranch,
    mergeCommit,
  };
}

/**
 * Enumerate worktrees registered with git for `projectPath`. Used by
 * `flockctl worktree list` and orphan-sweep on boot. Parses the
 * porcelain `git worktree list --porcelain` output:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *   <blank line>
 *
 * Detached HEADs and bare worktrees are surfaced too (branch=null).
 *
 * `managed = true` flags entries whose branch matches our
 * `flockctl/<kind>-<id>` prefix — the rest are operator-created
 * worktrees we have no business touching.
 */
export function listWorktrees(projectPath: string): ListWorktreeEntry[] {
  if (!isGitWorkTree(projectPath)) return [];
  const out = gitTry(projectPath, ["worktree", "list", "--porcelain"]) ?? "";
  const blocks = out.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const entries: ListWorktreeEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        // Strip leading "refs/heads/"
        branch = ref.replace(/^refs\/heads\//, "");
      }
    }
    if (!path) continue;
    const managed = branch !== null && branch.startsWith(`${BRANCH_PREFIX}/`);
    entries.push({ path, branch, head, managed });
  }
  return entries;
}
