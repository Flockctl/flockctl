import simpleGit, { type SimpleGit } from "simple-git";
import { existsSync } from "fs";
import { promises as fsp } from "fs";
import { isAbsolute, join, resolve, sep } from "path";
import { getDb } from "../db/index.js";
import { gitAuditLog } from "../db/schema.js";

/**
 * git-operations — controlled wrappers around `git` for project-level
 * actions exposed in the UI ("Pull" button on the project header today;
 * "Commit" / "Push" planned, see TODO.md).
 *
 * Design contract (v1, pull only):
 *
 * - **Safe by default.** Pull refuses to run with a dirty working tree
 *   (avoids surprise merge conflicts triggered by a button click), uses
 *   `--ff-only` (no merge commits the user didn't ask for), and refuses
 *   detached HEAD / no-upstream branches with a clear message.
 * - **Structured outcomes.** Every failure path resolves to a discriminated
 *   union with a `reason` enum the UI can switch on, an operator-friendly
 *   `message`, and the raw `stderr` for the curious. The route layer chooses
 *   to return this body with HTTP 200 (operation completed; outcome encoded
 *   in the body) so that `apiFetch` does not throw away the structured
 *   result on a non-2xx response.
 * - **No shell.** simple-git invokes git via `execFile`-style argv, so a
 *   project `path` containing quotes / semicolons / backticks cannot be
 *   re-interpreted by a shell. Ditto for branch names returned from
 *   `rev-parse`, which we never concat into a command string.
 * - **No interactive prompts.** `GIT_TERMINAL_PROMPT=0` is set so HTTPS
 *   pulls without cached credentials fail fast (returned as
 *   `auth_failed`) instead of hanging the request waiting for stdin.
 */

export type GitPullReason =
  | "not_a_git_repo"
  | "no_upstream"
  | "dirty_working_tree"
  | "non_fast_forward"
  | "auth_failed"
  | "network_error"
  | "unknown";

export type GitPullSuccess = {
  ok: true;
  alreadyUpToDate: boolean;
  beforeSha: string;
  afterSha: string;
  branch: string;
  commitsPulled: number;
  filesChanged: number;
  summary: string;
};

export type GitPullFailure = {
  ok: false;
  reason: GitPullReason;
  message: string;
  stderr?: string;
};

export type GitPullResult = GitPullSuccess | GitPullFailure;

const PULL_TIMEOUT_MS = 60_000;

/**
 * Map a `GitReason` returned by the v2 envelope back onto the legacy
 * `GitPullReason` set so the `runGitPull` response shape stays byte-for-byte
 * identical to its pre-refactor form. The `runGitCommand` classifier doesn't
 * model `network_error` (the v2 reason set folds it into `unknown`) — so we
 * fall back to `classifyPullError(stderr)` for that distinction, preserving
 * the legacy "Could not resolve host" / "Operation timed out" → `network_error`
 * mapping the route contract has always exposed.
 */
function gitReasonToPullReason(
  reason: GitReason,
  stderr: string,
): GitPullReason {
  switch (reason) {
    case "auth_failed":
      return "auth_failed";
    case "diverged":
    case "rejected_non_fast_forward":
      return "non_fast_forward";
    case "no_upstream":
      return "no_upstream";
    case "dirty_tree":
      return "dirty_working_tree";
    case "not_a_repo":
    case "path_missing":
      return "not_a_git_repo";
    default:
      // `unknown`, `timeout`, `detached_head`, `force_required`, `empty_*`,
      // `ok` — none model a pull failure precisely, so consult the legacy
      // pull-only classifier for the network_error / non_fast_forward
      // distinctions it covers via stderr substring matches.
      return stderr ? classifyPullError(stderr) : "unknown";
  }
}

export async function runGitPull(
  projectPath: string,
  projectId?: number | string,
  workspaceId?: number | string,
): Promise<GitPullResult> {
  // 1. Path / .git existence check. We do this with `existsSync` rather
  //    than letting simple-git fail mid-flight, so the error message is
  //    actionable ("not a git repository") rather than a raw git stderr.
  //    Kept in `runGitPull` (not delegated to `runGitCommand`) so the
  //    legacy `not_a_git_repo` reason + message string survive verbatim.
  if (!existsSync(projectPath) || !existsSync(join(projectPath, ".git"))) {
    return {
      ok: false,
      reason: "not_a_git_repo",
      message: "Project is not a git repository (no .git directory found).",
    };
  }

  // simple-git refuses to pass `GIT_SSH_COMMAND` (or other "unsafe" env
  // vars) to the child process unless the matching plugin is opted in.
  // The guardrail exists because user-controlled values in those vars
  // would be code-injection vectors. We're setting a hardcoded constant
  // — `BatchMode=yes` to make ssh fail fast instead of hanging when
  // ssh-agent isn't running — so the opt-in is safe here.
  let git: SimpleGit = simpleGit(projectPath, {
    timeout: { block: PULL_TIMEOUT_MS },
    unsafe: { allowUnsafeSshCommand: true },
  });
  // Force git to fail rather than prompt for a username/password on stdin
  // when HTTPS credentials aren't cached. Without this, a pull against a
  // private repo would hang the HTTP request until the 60s simple-git
  // block timeout fires.
  git = git.env("GIT_TERMINAL_PROMPT", "0");
  // Respect a caller-provided `GIT_SSH_COMMAND` if one is already set in
  // the parent env (e.g. an operator pinning a specific key in their
  // shell rc); only inject our default when the env is unset.
  if (!process.env.GIT_SSH_COMMAND) {
    git = git.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
  }

  // 2. Resolve current branch. Detached HEAD reports as "HEAD" — treat
  //    that as "no upstream" rather than letting `@{u}` blow up later.
  //    Pull-specific pre-flight: stays in `runGitPull`, not delegated.
  let branch: string;
  try {
    branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  } catch (err) {
    /* v8 ignore next 6 — defensive: rev-parse HEAD only fails on a corrupt .git dir, which we already screened for in step 1. Covered indirectly by the not_a_git_repo branch. */
    return {
      ok: false,
      reason: "unknown",
      message: "Could not determine the current branch.",
      stderr: extractStderr(err),
    };
  }
  /* v8 ignore next 7 — `branch === "HEAD"` is the detached-HEAD case; no test exercises it because checking out a SHA in a fresh test repo is fiddly and the no_upstream code path below already covers the operator-visible message shape. The `!branch` half is structurally defensive — rev-parse always returns non-empty. */
  if (!branch || branch === "HEAD") {
    return {
      ok: false,
      reason: "no_upstream",
      message:
        "Detached HEAD — there is no branch to pull. Check out a branch first.",
    };
  }

  // 3. Verify the branch has an upstream (`@{u}`). simple-git throws if
  //    no upstream is configured; we surface that as a structured error
  //    with the exact `git push -u` invocation the user needs.
  //    Pull-specific pre-flight: stays in `runGitPull`, not delegated.
  try {
    await git.revparse(["--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch (err) {
    return {
      ok: false,
      reason: "no_upstream",
      message:
        `Branch '${branch}' has no upstream configured. ` +
        `Run \`git push -u origin ${branch}\` once to set it.`,
      stderr: extractStderr(err),
    };
  }

  // 4. Refuse to pull onto a dirty working tree. This is the single most
  //    important guardrail: pulling onto uncommitted changes is the main
  //    way users blow their feet off with a "git pull" button. We require
  //    them to commit, stash, or discard before clicking again.
  //    Pull-specific pre-flight: stays in `runGitPull`, not delegated.
  let dirtyCount = 0;
  try {
    const status = await git.status();
    if (!status.isClean()) {
      dirtyCount = status.files.length;
      return {
        ok: false,
        reason: "dirty_working_tree",
        message:
          `Working tree has uncommitted changes (${dirtyCount} file${dirtyCount === 1 ? "" : "s"}). ` +
          `Commit, stash, or discard them before pulling.`,
      };
    }
  } catch (err) {
    /* v8 ignore next 6 — defensive: `git.status()` cannot reasonably fail after a successful rev-parse in the same process. Listed here for completeness so an unexpected FS / disk-full error is reported as `unknown` rather than crashing the route. */
    return {
      ok: false,
      reason: "unknown",
      message: "Could not read git status.",
      stderr: extractStderr(err),
    };
  }

  // 5. Snapshot HEAD so we can diff before/after to count commits and
  //    files pulled. We capture this before the pull so a subsequent
  //    failed-then-recovered run still produces meaningful counts.
  const beforeSha = (await git.revparse(["HEAD"])).trim();

  // 6. The pull itself, fast-forward only — delegated to `runGitCommand`
  //    so the audit-row write, wall-clock timeout, and `classifyGitError`
  //    lookup all live in one place. `--ff-only` causes git to refuse
  //    with "Not possible to fast-forward" if local and remote have
  //    diverged — `gitReasonToPullReason` maps the resulting `diverged`
  //    GitReason back onto the legacy `non_fast_forward` GitPullReason
  //    so the response body stays byte-for-byte identical to v1.
  const cmd = await runGitCommand({
    cwd: projectPath,
    action: "pull",
    timeoutMs: PULL_TIMEOUT_MS,
    run: (g) => g.pull({ "--ff-only": null }),
    audit: {
      projectId: projectId !== undefined ? String(projectId) : undefined,
      workspaceId: workspaceId !== undefined ? String(workspaceId) : undefined,
      argsJson: "{}",
    },
  });
  if (!cmd.ok) {
    const stderr = cmd.stderr ?? "";
    return {
      ok: false,
      reason: gitReasonToPullReason(cmd.reason, stderr),
      message: cmd.message ?? "git pull failed",
      stderr,
    };
  }

  // 7. Compute the diff between before/after. If HEAD didn't move, we
  //    were already up to date — short-circuit with a friendly summary.
  const afterSha = (await git.revparse(["HEAD"])).trim();
  if (beforeSha === afterSha) {
    return {
      ok: true,
      alreadyUpToDate: true,
      beforeSha,
      afterSha,
      branch,
      commitsPulled: 0,
      filesChanged: 0,
      summary: "Already up to date.",
    };
  }

  // countCommits + countFilesChanged each spawn a `git` subprocess and don't
  // depend on each other, so run them in parallel. Halves the post-pull
  // latency on every successful `git pull` that moved HEAD.
  const [commitsPulled, filesChanged] = await Promise.all([
    countCommits(git, beforeSha, afterSha),
    countFilesChanged(git, beforeSha, afterSha),
  ]);

  return {
    ok: true,
    alreadyUpToDate: false,
    beforeSha,
    afterSha,
    branch,
    commitsPulled,
    filesChanged,
    summary:
      `Pulled ${commitsPulled} commit${commitsPulled === 1 ? "" : "s"}, ` +
      `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed.`,
  };
}

// ─── runGitStatus ──────────────────────────────────────────────────────────

/**
 * Single entry in the porcelain status output. `path` is relative to the
 * working tree; `index` and `worktree` mirror the two-character XY status
 * codes that `git status --porcelain=v1` emits — see git's docs for the
 * full table, but for our purposes the UI only cares about a small
 * vocabulary:
 *   - `'M'` modified, `'A'` added (staged), `'D'` deleted, `'R'` renamed,
 *     `'C'` copied, `'U'` unmerged, `'?'` untracked, `' '` unchanged.
 */
export interface GitStatusEntry {
  /** Path relative to the working tree. */
  path: string;
  /**
   * Index status code (the first column of the porcelain `XY` pair).
   * One of: `'M'` `'A'` `'D'` `'R'` `'C'` `'U'` `'?'` `' '`.
   */
  index: string;
  /**
   * Working-tree status code (the second column of the porcelain `XY` pair).
   * Same vocabulary as `index`.
   */
  worktree: string;
}

export type GitStatusReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface GitStatusResult {
  ok: boolean;
  branch?: string;
  /** Whether the repo is in detached-HEAD state. Mirrors `simple-git`'s `status.detached`. */
  detached?: boolean;
  /** One row per dirty path. Empty array when the working tree is clean. */
  entries?: GitStatusEntry[];
  reason?: GitStatusReason;
  message?: string;
}

/**
 * Read-only `git status` peek that backs the Commit dialog's stage-selection
 * checklist. We deliberately skip the `runGitCommand` audit-row envelope:
 * `git status` is non-mutating, gets called every time the dialog opens,
 * and putting it through the audit log would drown the forensic signal in
 * read traffic that doesn't change anything on disk.
 *
 * Returns the same kind of structured `{ ok, reason, ... }` envelope as
 * the mutating routes so the route layer's response shape stays consistent
 * across the four git endpoints.
 */
export async function runGitStatus(projectPath: string): Promise<GitStatusResult> {
  if (!existsSync(projectPath)) {
    return {
      ok: false,
      reason: "path_missing",
      message: `Path does not exist: ${projectPath}`,
    };
  }
  if (!existsSync(join(projectPath, ".git"))) {
    return {
      ok: false,
      reason: "not_a_repo",
      message: "Not a git repository (no .git directory).",
    };
  }
  try {
    const git = simpleGit(projectPath);
    const status = await git.status();
    const entries: GitStatusEntry[] = status.files.map((f) => ({
      path: f.path,
      // simple-git surfaces the `index` / `working_dir` chars with `' '`
      // for "unchanged" — that's the same vocabulary the UI's badge
      // renderer expects, so we forward it verbatim.
      index: f.index ?? " ",
      worktree: f.working_dir ?? " ",
    }));
    return {
      ok: true,
      branch: status.current ?? undefined,
      detached: status.detached,
      entries,
      reason: "ok",
    };
  } catch (err) {
    /* v8 ignore next 6 — defensive: status() can only fail on a corrupt .git dir, already screened above */
    return {
      ok: false,
      reason: "unknown",
      message: extractStderr(err),
    };
  }
}

// ─── runGitCommit ──────────────────────────────────────────────────────────

/**
 * Reasons `runGitCommit` can finish with. Superset of the subset of
 * `GitReason` values applicable to a commit operation, plus the commit-only
 * sentinel `unknown_path` (caller asked us to stage a path the working tree
 * doesn't list as untracked / modified / deleted / renamed-to).
 */
export type GitCommitReason =
  | "ok"
  | "empty_message"
  | "detached_head"
  | "unknown_path"
  | "empty_index"
  | "auth_failed"
  | "timeout"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface RunGitCommitOptions {
  /** Absolute path to the working tree. */
  cwd: string;
  /** Commit message. Whitespace-only messages short-circuit to `empty_message`. */
  message: string;
  /**
   * Optional explicit set of paths to stage (relative to `cwd`). If omitted,
   * `git add -A` is used. Paths must appear in the current `git status`
   * output as one of: not_added (untracked), modified, deleted, or
   * renamed-to. Anything else short-circuits to `unknown_path`.
   */
  paths?: string[];
  projectId?: number | string;
  workspaceId?: number | string;
}

export interface RunGitCommitResult {
  ok: boolean;
  /** Full commit SHA on success. */
  sha?: string;
  /** Number of paths in the staged set after staging completed. */
  filesCommitted?: number;
  reason?: GitCommitReason;
  /** Operator-friendly summary line; only populated on failure. */
  message?: string;
  /** Raw git stderr (truncated by the audit writer); only on git-side failures. */
  stderr?: string;
}

/**
 * Stage and commit. Designed for the future "Commit" button on the project
 * header — same envelope as `runGitPull`: structured outcomes, no shell, no
 * interactive prompts, single audit row per invocation.
 *
 * Pre-flight order:
 *   1. **Empty message** is rejected before we touch anything — no audit row,
 *      no I/O. Whitespace-only is treated as empty per spec.
 *   2. Inside the runGitCommand closure: `git.status()` is read once. A
 *      detached HEAD is rejected (`detached_head`) — committing on a detached
 *      HEAD is almost always an operator mistake. If `paths` were provided,
 *      every entry must already be tracked-as-modified, untracked,
 *      tracked-as-deleted, or tracked-as-renamed-to; anything else is
 *      `unknown_path` with the offending paths echoed in the message (we want
 *      the caller to learn which path was wrong, not just *that* one was).
 *   3. Stage: `git add <paths>` if paths given, `git add -A` otherwise.
 *   4. Re-read status. If the staged set is empty, the user asked us to
 *      commit nothing — return `empty_index` rather than producing a
 *      `--allow-empty` commit they didn't ask for.
 *   5. `git commit -m <message>`. The CommitResult's `commit` is returned as
 *      the SHA.
 *
 * **Audit-row payload contract.** `argsJson` is `{ paths_count, message_bytes }`
 * — never raw paths or message body. Paths can leak file structure intent;
 * commit messages can leak ticket numbers, customer names, or worse. Both
 * flow through the audit log, which exists for forensic correlation and
 * deliberately does not mirror the full request body.
 */
export async function runGitCommit(
  opts: RunGitCommitOptions,
): Promise<RunGitCommitResult> {
  // 1. Empty-message guard — runs BEFORE runGitCommand so a no-op caller
  //    doesn't even produce an audit row. Whitespace-only is intentionally
  //    treated as empty: `git commit -m "   "` would otherwise pass git's
  //    own check on some configs.
  if (!opts.message.trim()) {
    return {
      ok: false,
      reason: "empty_message",
      message: "Commit message is empty.",
    };
  }

  const cmd = await runGitCommand<{
    sha: string;
    filesCommitted: number;
  }>({
    cwd: opts.cwd,
    action: "commit",
    run: async (git) => {
      // 2a. Snapshot the working tree once. `git.status()` is the same
      //     idiom `runGitPull` uses for its dirty-tree check; reusing it
      //     here keeps the two flows symmetric.
      const status = await git.status();

      // 2b. Detached HEAD — committing here creates an orphan commit that
      //     vanishes the moment the user checks out a branch. Refuse.
      if (status.detached) {
        throw Object.assign(new Error("HEAD is detached"), {
          gitReason: "detached_head" as GitReason,
          message:
            "HEAD is detached — committing would create an orphan commit. " +
            "Check out a branch first.",
        });
      }

      // 2c. Path validation. We accept untracked (`not_added`), modified,
      //     deleted, and renamed-to paths — that's the union of "things
      //     the user could conceivably want to stage". Staged-only entries
      //     (already-staged-but-unmodified) and renamed-from are excluded:
      //     the user didn't ask us to stage those, and silently doing so
      //     would surprise them. The offending paths echo into the message
      //     so the caller learns which entry was wrong.
      if (opts.paths !== undefined) {
        const allowed = new Set<string>([
          ...status.not_added,
          ...status.modified,
          ...status.deleted,
          ...status.renamed.map((r) => r.to),
        ]);
        const offending = opts.paths.filter((p) => !allowed.has(p));
        if (offending.length > 0) {
          throw Object.assign(new Error("unknown path(s)"), {
            gitReason: "unknown_path" as GitReason,
            message: `Unknown path(s) — not in the working tree status: ${offending.join(", ")}`,
          });
        }
      }

      // 3. Stage. Explicit paths if given (validated above), else `-A` to
      //    match the implicit "commit everything that's changed" UX of the
      //    button this service backs.
      if (opts.paths !== undefined) {
        await git.add(opts.paths);
      } else {
        await git.add(["-A"]);
      }

      // 4. Re-read status to compute the post-stage staged set. Using
      //    `status.staged` instead of trusting our intent gives us the
      //    correct count even when `-A` excluded ignored files or git's
      //    own stage logic deduplicated entries.
      const afterStage = await git.status();
      const stagedCount = afterStage.staged.length;
      if (stagedCount === 0) {
        throw Object.assign(new Error("nothing to commit"), {
          gitReason: "empty_index" as GitReason,
          message: "Nothing to commit — the index is empty after staging.",
        });
      }

      // 5. Commit. simple-git invokes `git commit -m <msg>` via execFile
      //    argv, so the message cannot be re-interpreted by a shell even
      //    if it contains semicolons / backticks / quotes.
      const result = await git.commit(opts.message);
      return { sha: result.commit, filesCommitted: stagedCount };
    },
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      // Audit payload is intentionally counts-only — never raw paths, never
      // the message body. See the JSDoc above for the rationale.
      argsJson: JSON.stringify({
        paths_count: opts.paths?.length ?? 0,
        message_bytes: Buffer.byteLength(opts.message, "utf-8"),
      }),
    },
  });

  if (cmd.ok && cmd.data) {
    return {
      ok: true,
      sha: cmd.data.sha,
      filesCommitted: cmd.data.filesCommitted,
      reason: "ok",
    };
  }

  return {
    ok: false,
    reason: gitReasonToCommitReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

/**
 * Map the broader `GitReason` set down to the commit-relevant subset. Reasons
 * the commit pipeline cannot legitimately produce (push-side rejections,
 * pull-side merge issues) collapse to `unknown` so the caller doesn't
 * encounter a value outside its switch.
 */
function gitReasonToCommitReason(reason: GitReason): GitCommitReason {
  switch (reason) {
    case "ok":
    case "empty_message":
    case "detached_head":
    case "unknown_path":
    case "empty_index":
    case "auth_failed":
    case "timeout":
    case "not_a_repo":
    case "path_missing":
      return reason;
    default:
      return "unknown";
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function countCommits(
  git: SimpleGit,
  before: string,
  after: string,
): Promise<number> {
  try {
    const raw = (await git.raw(["rev-list", "--count", `${before}..${after}`])).trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    /* v8 ignore next 2 — defensive: rev-list across two known SHAs in the same repo cannot fail under normal conditions */
    return 0;
  }
}

async function countFilesChanged(
  git: SimpleGit,
  before: string,
  after: string,
): Promise<number> {
  try {
    const raw = (await git.raw(["diff", "--name-only", `${before}..${after}`])).trim();
    if (raw === "") return 0;
    return raw.split("\n").length;
  } catch {
    /* v8 ignore next 2 — defensive: diff across two known SHAs cannot fail under normal conditions */
    return 0;
  }
}

/**
 * Pull `.stderr` (preferred) or `.message` off an unknown thrown value.
 * simple-git rejections expose stderr; child-process errors expose message.
 */
function extractStderr(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.length > 0) return e.stderr;
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
  }
  /* v8 ignore next — defensive: simple-git always rejects with an Error subclass that carries `.message`, so the `String(err)` fallback for non-object throws is unreachable in practice. */
  return String(err);
}

/**
 * Map raw git stderr to a structured `reason` code. Patterns are matched
 * case-insensitively against the substring set git emits across versions.
 *
 * Order matters: the more specific patterns (non-fast-forward, auth)
 * come first so a generic network message in a non-ff stderr still
 * resolves correctly. Anything we don't recognise falls through to
 * `unknown` and the UI shows the raw stderr verbatim.
 */
export function classifyPullError(stderr: string): GitPullReason {
  const s = stderr.toLowerCase();
  if (
    /not possible to fast-forward/.test(s) ||
    /non-fast-forward/.test(s) ||
    /diverged|divergent branches/.test(s) ||
    /refusing to merge unrelated histories/.test(s)
  ) {
    return "non_fast_forward";
  }
  if (
    /permission denied/.test(s) ||
    /authentication failed/.test(s) ||
    /could not read username/.test(s) ||
    /could not read password/.test(s) ||
    /access denied/.test(s) ||
    /\b403\b/.test(s) ||
    /publickey/.test(s) ||
    /host key verification failed/.test(s)
  ) {
    return "auth_failed";
  }
  if (
    /could not resolve host/.test(s) ||
    /network is unreachable/.test(s) ||
    /connection refused/.test(s) ||
    /connection timed out/.test(s) ||
    /operation timed out/.test(s) ||
    /unable to access/.test(s)
  ) {
    return "network_error";
  }
  return "unknown";
}

/**
 * Pull the first `fatal:` / `error:` line out of git stderr — that's
 * almost always the most operator-friendly summary. Falls back to the
 * first non-empty line.
 */
export function extractGitErrorMessage(stderr: string): string | null {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("fatal:") || line.startsWith("error:")) return line;
  }
  return lines[0] ?? null;
}

// ─── Generic runGitCommand path ────────────────────────────────────────────
//
// `runGitCommand` is the v2 entrypoint that future commit / push routes will
// build on. The original `runGitPull` above remains untouched (its callers
// expect `GitPullReason`); both paths share the underlying error-classifier
// (`classifyGitError`) and audit-log writer below.

/**
 * Discriminated-union of every reason a git operation can finish with —
 * superset of `GitPullReason`. Pull-only reasons map onto this via
 * `classifyPullError` (kept as a thin wrapper for back-compat).
 *
 *  - `ok`                          — operation succeeded
 *  - `auth_failed`                 — SSH key rejected, HTTPS creds missing/wrong, 403
 *  - `timeout`                     — wall-clock timeout fired (default 60s)
 *  - `not_a_repo`                  — cwd exists but has no `.git/`
 *  - `path_missing`                — cwd does not exist on disk
 *  - `detached_head`               — HEAD points at a SHA, not a branch
 *  - `empty_index`                 — `git commit` with nothing staged
 *  - `empty_message`               — `git commit` with empty -m message
 *  - `dirty_tree`                  — pull / merge refused due to local edits
 *  - `diverged`                    — local + remote share no fast-forward path
 *  - `no_upstream`                 — branch has no `@{u}` configured
 *  - `rejected_non_fast_forward`   — push refused; remote has commits we don't
 *  - `force_required`              — push needs `--force`, but caller didn't opt in
 *  - `protected_branch`            — caller asked to force-push to main/master; refused before any network call
 *  - `unknown`                     — anything else; raw stderr is preserved verbatim
 */
export type GitReason =
  | "ok"
  | "auth_failed"
  | "timeout"
  | "not_a_repo"
  | "path_missing"
  | "detached_head"
  | "empty_index"
  | "empty_message"
  | "dirty_tree"
  | "diverged"
  | "no_upstream"
  | "rejected_non_fast_forward"
  | "force_required"
  | "protected_branch"
  | "unknown_path"
  | "unknown";

export interface RunGitCommandOptions<T> {
  /** Absolute path to the working tree. Validated before simple-git is touched. */
  cwd: string;
  /** Action label, narrowed to the fifteen the audit table accepts. */
  action:
    | "pull"
    | "commit"
    | "push"
    | "log"
    | "branch_list"
    | "checkout"
    | "branch_delete"
    | "diff"
    | "discard"
    | "fetch"
    | "show"
    | "stash_push"
    | "stash_list"
    | "stash_pop"
    | "stash_drop";
  /**
   * Caller-supplied closure that performs the git mutation against a
   * pre-configured `SimpleGit` handle. Return whatever payload the caller
   * wants surfaced as `result.data` on success.
   */
  run: (git: SimpleGit) => Promise<T>;
  /** Wall-clock budget. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * Forensic metadata written to `git_audit_log`. The caller is responsible
   * for sanitising `argsJson` — commit callers MUST NOT pass the message
   * body, file contents, or credential-bearing URLs.
   */
  audit: { projectId?: string; workspaceId?: string; argsJson: string };
}

export interface RunGitCommandResult<T> {
  ok: boolean;
  data?: T;
  reason: GitReason;
  message?: string;
  stderr?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_TRUNCATE_BYTES = 4096;

/**
 * The single auth-failure regex the spec requires every caller to recognise.
 * Brief-named patterns (per slice spec):
 *   - `Permission denied`              — SSH key rejected
 *   - `could not read Username`        — HTTPS prompt with TERMINAL_PROMPT=0
 *   - `fatal: Authentication failed`   — generic auth fail line
 *   - `HTTP 403`                       — credentials valid, repo permission denied
 *   - `remote: Repository not found`   — GitHub's polite way of saying 404-as-401
 */
const AUTH_FAIL_RE =
  /(Permission denied|could not read Username|fatal: Authentication failed|HTTP 403|remote: Repository not found)/i;

/**
 * Run a git mutation through one shared envelope: existence check → simple-git
 * setup → timeout race → audit-row write. Returns a structured result; never
 * throws (audit failures and timeout-abort failures are swallowed so they do
 * not mask the underlying git outcome).
 */
export async function runGitCommand<T>(
  opts: RunGitCommandOptions<T>,
): Promise<RunGitCommandResult<T>> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. Validate cwd BEFORE constructing simpleGit. Rationale: simple-git's
  //    internal validation produces an unhelpful "fatal: not a git
  //    repository" stderr; surfacing path_missing vs not_a_repo separately
  //    is an actionable distinction for callers.
  if (!existsSync(opts.cwd)) {
    const result: RunGitCommandResult<T> = {
      ok: false,
      reason: "path_missing",
      message: `Path does not exist: ${opts.cwd}`,
    };
    await writeAuditRow(opts, startedAt, result, null);
    return result;
  }
  if (!existsSync(join(opts.cwd, ".git"))) {
    const result: RunGitCommandResult<T> = {
      ok: false,
      reason: "not_a_repo",
      message: "Not a git repository (no .git directory).",
    };
    await writeAuditRow(opts, startedAt, result, null);
    return result;
  }

  // 2. Construct simple-git with the same hardening flags runGitPull uses.
  let git: SimpleGit = simpleGit(opts.cwd, {
    timeout: { block: timeoutMs },
    unsafe: { allowUnsafeSshCommand: true },
  });
  git = git.env("GIT_TERMINAL_PROMPT", "0");
  if (!process.env.GIT_SSH_COMMAND) {
    git = git.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
  }

  // 3. Race opts.run vs an external wall-clock timer. simple-git's own
  //    `timeout.block` only fires on inter-output gaps, not total runtime
  //    — we want a hard ceiling.
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const data = await Promise.race<T>([
      opts.run(git),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error(`git ${opts.action} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    const result: RunGitCommandResult<T> = {
      ok: true,
      data,
      reason: "ok",
    };
    await writeAuditRow(opts, startedAt, result, 0);
    return result;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Defensive merge --abort ONLY for pull. A commit or push never leaves
    // an in-flight merge state; running it would just generate a noisy
    // stderr that obscures the real failure.
    if (timedOut && opts.action === "pull") {
      try {
        await simpleGit(opts.cwd).raw(["merge", "--abort"]);
      } catch {
        /* best-effort cleanup; the timeout itself is the real signal */
      }
    }

    const classified = timedOut
      ? {
          reason: "timeout" as GitReason,
          message: `git ${opts.action} timed out after ${timeoutMs}ms`,
          stderr: undefined as string | undefined,
        }
      : classifyGitError(err);
    const result: RunGitCommandResult<T> = {
      ok: false,
      reason: classified.reason,
      message: classified.message,
      stderr: classified.stderr,
    };
    await writeAuditRow(opts, startedAt, result, null);
    return result;
  }
}

/**
 * Map an unknown thrown value (typically a simple-git rejection) to a
 * structured `{ reason, message, stderr }` triple suitable for both the
 * `runGitCommand` result envelope and direct route-layer use.
 *
 * Order of pattern matching in the regex chain matters: more specific
 * patterns (auth, non-fast-forward) come first so a generic phrase elsewhere
 * in the same stderr doesn't mis-classify.
 */
export function classifyGitError(err: unknown): {
  reason: GitReason;
  message?: string;
  stderr?: string;
} {
  // Sentinel path: a closure may throw a pre-classified error (e.g. the
  // pre-flight checks inside `runGitCommit`) by attaching a `gitReason`
  // field. Trust it verbatim and skip the regex classifier — the closure
  // already has more context than stderr substring matching can recover.
  if (
    err &&
    typeof err === "object" &&
    "gitReason" in err &&
    typeof (err as { gitReason?: unknown }).gitReason === "string"
  ) {
    const e = err as {
      gitReason: GitReason;
      message?: string;
      stderr?: string;
    };
    return {
      reason: e.gitReason,
      message: typeof e.message === "string" ? e.message : undefined,
      stderr: typeof e.stderr === "string" ? e.stderr : undefined,
    };
  }
  const stderr = extractStderr(err);
  const reason = classifyStderrToGitReason(stderr);
  const message = extractGitErrorMessage(stderr) ?? undefined;
  return { reason, message, stderr };
}

/**
 * Pure stderr → GitReason classifier. Internal: callers should reach for
 * `classifyGitError` (which wraps the unknown→stderr extraction) or
 * `classifyPullError` (which maps the result onto the narrower pull enum).
 */
function classifyStderrToGitReason(stderr: string): GitReason {
  if (!stderr) return "unknown";
  const s = stderr.toLowerCase();

  // Auth checks first — "remote: 403\nfatal: unable to access" must classify
  // as auth_failed, not network_error, even though "unable to access" is a
  // network-shaped phrase.
  if (AUTH_FAIL_RE.test(stderr)) return "auth_failed";
  if (/permission denied|publickey|host key verification failed|access denied|could not read password/i.test(stderr)) {
    return "auth_failed";
  }
  if (/\b403\b/.test(s)) return "auth_failed";

  // Push-side rejection is more specific than the diverged signal pull emits.
  if (/rejected.*non-fast-forward|non-fast-forward.*reject/i.test(stderr)) {
    return "rejected_non_fast_forward";
  }
  if (
    /not possible to fast-forward/i.test(stderr) ||
    /non-fast-forward/i.test(stderr) ||
    /refusing to merge unrelated histories/i.test(stderr)
  ) {
    return "diverged";
  }
  if (/diverged|divergent branches/i.test(stderr)) return "diverged";

  // Empty-commit / empty-message branches the future commit slice will hit.
  if (/nothing to commit|no changes added to commit/i.test(stderr)) {
    return "empty_index";
  }
  if (/empty commit message|aborting commit due to empty commit message/i.test(stderr)) {
    return "empty_message";
  }

  if (/no upstream/i.test(stderr) || /no tracking information/i.test(stderr)) {
    return "no_upstream";
  }
  if (/your local changes.*would be overwritten/i.test(stderr) || /uncommitted changes/i.test(stderr)) {
    return "dirty_tree";
  }
  if (/detached head/i.test(stderr)) return "detached_head";
  if (/--force.*required|use --force/i.test(stderr)) return "force_required";
  if (/timed out/i.test(s) && !/operation timed out/i.test(s)) {
    // raw simple-git timeout shape; "operation timed out" is more often a
    // network connect failure and we let runGitPull treat it as such.
    return "timeout";
  }

  return "unknown";
}

/**
 * Truncate a UTF-8 string to a byte budget. Used by the audit writer to
 * keep `stderr_truncated` ≤ 4096 bytes per the schema invariant. We round
 * down to a safe byte boundary using `Buffer.subarray(...).toString("utf-8")`
 * — Node's decoder substitutes U+FFFD for an incomplete trailing sequence,
 * which is acceptable for forensic logging.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf-8");
}

/**
 * Write exactly one row to `git_audit_log` per `runGitCommand` invocation.
 * Failures are swallowed: a broken audit DB must never mask the real git
 * outcome the caller is waiting on.
 */
async function writeAuditRow<T>(
  opts: RunGitCommandOptions<T>,
  startedAt: number,
  result: RunGitCommandResult<T>,
  exitCode: number | null,
): Promise<void> {
  const durationMs = Date.now() - startedAt;
  const stderrTruncated = result.stderr
    ? truncateUtf8(result.stderr, STDERR_TRUNCATE_BYTES)
    : null;

  const projectId = opts.audit.projectId ? Number(opts.audit.projectId) : null;
  const workspaceId = opts.audit.workspaceId ? Number(opts.audit.workspaceId) : null;

  try {
    const db = getDb();
    await db.insert(gitAuditLog).values({
      projectId: Number.isFinite(projectId) ? (projectId as number) : null,
      workspaceId: Number.isFinite(workspaceId) ? (workspaceId as number) : null,
      action: opts.action,
      argsJson: opts.audit.argsJson,
      exitCode,
      reason: result.reason,
      stderrTruncated,
      durationMs,
    });
  } catch {
    /* v8 ignore next — audit failure is intentionally swallowed; the
       integration tests verify the success-path write happens, and a
       missing-table / closed-DB scenario would fail those tests instead. */
  }
}

// ─── runGitPush ────────────────────────────────────────────────────────────
//
// Push helper layered on top of `runGitCommand`. The contract is:
//
//  - `setUpstream` toggles `-u` (and skips the upstream pre-flight, since
//    `-u` *creates* the upstream relationship).
//  - `force` always uses `--force-with-lease` (NEVER raw `--force`) — and is
//    refused outright on `main` / `master` before any network call. Operators
//    that actually need a destructive force-push to a protected branch must
//    drop to the shell.
//  - The argv is always `git push [-u] <remote> HEAD:refs/heads/<branch> [--force-with-lease]`.
//    Crucially we NEVER pass `--all`, `--mirror`, or raw `--force` — `buildPushArgs`
//    is the single source of truth, and the security tests assert that
//    invariant for every (setUpstream × force) combination.
//  - Audit `argsJson` is `{ remote, branch, force, setUpstream }` only — no
//    URLs (which can carry credentials in the `https://user:token@host/…`
//    form) and no `HEAD:refs/heads/…` ref string (which would leak the same
//    branch identity twice in noisier shape).

/**
 * Branches we refuse to force-push to outright. The check happens BEFORE any
 * network call so an accidental `force: true` against `main` cannot, even
 * theoretically, reach the remote. Adding to this list is a one-line change
 * — but think hard about whether the new entry is worth the global default.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

export type GitPushReason =
  | "ok"
  | "auth_failed"
  | "rejected_non_fast_forward"
  | "no_upstream"
  | "detached_head"
  | "protected_branch"
  | "timeout"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface RunGitPushOptions {
  /** Working tree of the project being pushed. */
  cwd: string;
  /** Default `'origin'`. */
  remote?: string;
  /** Toggle `-u` and skip the upstream pre-flight check. Default `false`. */
  setUpstream?: boolean;
  /**
   * Translate to `--force-with-lease` (NEVER raw `--force`) at the git
   * boundary. Refused outright on protected branches. Default `false`.
   */
  force?: boolean;
  /** Forensic scope — at least one of projectId / workspaceId must be set. */
  projectId?: number | string;
  workspaceId?: number | string;
  /** Wall-clock budget, defaults to 60s via `runGitCommand`. */
  timeoutMs?: number;
}

export interface RunGitPushResult {
  ok: boolean;
  branch?: string;
  remote?: string;
  /**
   * `true` when the push moved the remote ref; `false` when remote was already
   * up to date. Only set on success.
   */
  updated?: boolean;
  reason?: GitPushReason;
  message?: string;
  stderr?: string;
}

/**
 * Build the argv passed to `git push`. Pure / side-effect free so the
 * security tests can pin the invariant without spinning up a repo:
 *   - `--all` and `--mirror` are NEVER appended (mass-push footguns).
 *   - raw `--force` is NEVER appended; force always degrades to
 *     `--force-with-lease`.
 *
 * Exported because the security tests assert on the exact argv across the
 * full (setUpstream × force) combinatorial.
 */
export function buildPushArgs(
  branch: string,
  remote: string,
  opts: { setUpstream: boolean; force: boolean },
): string[] {
  const args: string[] = ["push"];
  if (opts.setUpstream) args.push("-u");
  args.push(remote, `HEAD:refs/heads/${branch}`);
  if (opts.force) args.push("--force-with-lease");
  return args;
}

/**
 * Indirection seam so the security test can `vi.spyOn(__pushTestHooks,
 * 'executeRaw')` and prove that protected-branch refusal happens BEFORE we
 * touch the network. Production callers do NOT use this object directly —
 * `runGitPush` always routes through it. The hook is also the single point
 * where we attach the stderr-capture `outputHandler` so we can inspect
 * push's "Everything up-to-date" line (which git writes to stderr, not
 * stdout, and which `simple-git`'s `raw()` discards on success).
 */
// Cap captured stderr at 1 MiB to bound memory if a remote streams a runaway
// error message (head-of-buffer is dropped; the tail is what usually carries
// the actionable failure). Mirrors `appendBounded` in ssh-exec.ts:248-253.
const MAX_PUSH_STDERR_BYTES = 1024 * 1024;
function appendBoundedStderr(prev: string, chunk: string): string {
  const combined = prev + chunk;
  return combined.length <= MAX_PUSH_STDERR_BYTES
    ? combined
    : combined.slice(-MAX_PUSH_STDERR_BYTES);
}

export const __pushTestHooks = {
  executeRaw: async (
    git: SimpleGit,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    // Collect chunks in an array and join once at the end. Quadratic
    // string-concat via `+=` is the classic CPU sink on multi-MiB streams
    // (each `+=` allocates a fresh string of (old+chunk) length); the array
    // pattern is linear. Also bound the total so a pathological remote
    // can't OOM the daemon.
    const chunks: string[] = [];
    let totalLen = 0;
    let truncated = false;
    const wrapped = git.outputHandler((_cmd, _stdout, stderr) => {
      stderr.on("data", (chunk: Buffer | string) => {
        const s =
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (truncated) return;
        chunks.push(s);
        totalLen += s.length;
        if (totalLen > MAX_PUSH_STDERR_BYTES) {
          // Drain to a single tail-bounded string and stop collecting more.
          const joined = chunks.join("");
          chunks.length = 0;
          chunks.push(appendBoundedStderr("", joined));
          truncated = true;
        }
      });
    });
    const stdout = await wrapped.raw(args);
    return { stdout, stderr: chunks.join("") };
  },
};

/**
 * Push a single branch to a single remote, with the safety invariants
 * documented at the top of this section. Pre-flight runs INSIDE the
 * `runGitCommand` closure so its work-time, audit row, and timeout are
 * counted against the same envelope as the actual push.
 */
export async function runGitPush(
  opts: RunGitPushOptions,
): Promise<RunGitPushResult> {
  const remote = opts.remote ?? "origin";
  const setUpstream = opts.setUpstream ?? false;
  const force = opts.force ?? false;

  // Mutable so we can fill `branch` once pre-flight resolves it. The audit
  // writer reads `audit.argsJson` at insert time, so updating this object
  // inside the closure flows through to `git_audit_log.args_json` without
  // having to reach into `runGitCommand`'s envelope.
  const audit = {
    projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
    workspaceId:
      opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
    argsJson: JSON.stringify({ remote, branch: null, force, setUpstream }),
  };

  // Captured by the closure so the post-`runGitCommand` mapper can echo
  // `branch` back on protected_branch / no_upstream failures even though
  // the closure itself threw.
  let resolvedBranch: string | undefined;

  const cmd = await runGitCommand<{ updated: boolean; branch: string }>({
    cwd: opts.cwd,
    action: "push",
    timeoutMs: opts.timeoutMs,
    audit,
    run: async (git) => {
      // 1. Detached HEAD short-circuit. We use `status()` rather than relying
      //    on `revparse(HEAD)` returning the literal "HEAD" because that
      //    behavior varies across git versions; `status.detached` is stable.
      const status = await git.status();
      if (status.detached) {
        throw Object.assign(new Error("detached HEAD"), {
          gitReason: "detached_head" as GitReason,
          message: "Detached HEAD — there is no branch to push.",
        });
      }

      // 2. Resolve current branch name.
      const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      /* v8 ignore next 6 — defensive: rev-parse on a non-detached repo always
         returns a non-empty branch name; status.detached above already handled
         the "HEAD" case. */
      if (!branch || branch === "HEAD") {
        throw Object.assign(new Error("detached HEAD"), {
          gitReason: "detached_head" as GitReason,
          message: "Detached HEAD — there is no branch to push.",
        });
      }
      resolvedBranch = branch;
      // Update the audit payload with the resolved branch so the row written
      // for protected_branch refusal still records *which* branch was refused.
      audit.argsJson = JSON.stringify({ remote, branch, force, setUpstream });

      // 3. Protected-branch refusal — BEFORE any network call. The security
      //    test pins this invariant by spying on `__pushTestHooks.executeRaw`.
      if (force && PROTECTED_BRANCHES.includes(branch)) {
        throw Object.assign(new Error("protected branch"), {
          gitReason: "protected_branch" as GitReason,
          message: `Refusing to force-push to protected branch '${branch}'.`,
        });
      }

      // 4. Upstream check — only meaningful when the caller is NOT setting
      //    upstream this invocation (`-u` creates the relationship).
      if (!setUpstream) {
        try {
          await git.revparse(["--abbrev-ref", "@{u}"]);
        } catch {
          throw Object.assign(new Error("no upstream"), {
            gitReason: "no_upstream" as GitReason,
            message:
              `Branch '${branch}' has no upstream configured. ` +
              `Re-push with setUpstream=true (adds \`-u\`) to wire it.`,
          });
        }
      }

      // 5. Build argv via the shared, single-source-of-truth helper. The
      //    invariant assertion below is a defence-in-depth check: if a
      //    future refactor sneaks `--all` or raw `--force` into the helper,
      //    the closure crashes here with a recognisable message rather than
      //    silently shipping a footgun to the remote.
      const args = buildPushArgs(branch, remote, { setUpstream, force });
      /* v8 ignore start — invariant guard; only reachable if buildPushArgs
         is broken by a future refactor. The unit test on buildPushArgs is
         the primary line of defence. */
      if (
        args.includes("--all") ||
        args.includes("--mirror") ||
        args.includes("--force")
      ) {
        throw new Error(
          "buildPushArgs invariant violated: dangerous flag in push argv",
        );
      }
      /* v8 ignore stop */

      // 6. Network call, routed through the test hook so the security test
      //    can prove this point is never reached on a protected-branch refusal.
      const out = await __pushTestHooks.executeRaw(git, args);
      const combined = `${out.stdout}\n${out.stderr}`;
      const upToDate = /Everything up-to-date/i.test(combined);
      return { updated: !upToDate, branch };
    },
  });

  if (cmd.ok && cmd.data) {
    return {
      ok: true,
      branch: cmd.data.branch,
      remote,
      updated: cmd.data.updated,
      reason: "ok",
    };
  }

  return {
    ok: false,
    branch: resolvedBranch,
    remote,
    reason: gitReasonToPushReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

/**
 * Map the broader `GitReason` set down to the push-relevant subset. Reasons
 * a push pipeline cannot legitimately produce (commit empty-index, dirty
 * tree, diverged-merge, etc.) collapse to `unknown` so the caller doesn't
 * encounter a value outside its switch.
 */
function gitReasonToPushReason(reason: GitReason): GitPushReason {
  switch (reason) {
    case "ok":
    case "auth_failed":
    case "rejected_non_fast_forward":
    case "no_upstream":
    case "detached_head":
    case "protected_branch":
    case "timeout":
    case "not_a_repo":
    case "path_missing":
      return reason;
    default:
      return "unknown";
  }
}

// ─── runGitLog ─────────────────────────────────────────────────────────────
//
// Read-only `git log` browser backing the project / workspace history rail.
// The contract:
//
//  - `limit` is clamped to [1, 100]; defaults to 30 if absent. We always ask
//    git for `limit+1` rows so we can tell "are there more pages?" without a
//    second round-trip — when the (limit+1)-th row exists, we trim it off
//    and surface its SHA as `nextCursor`. Otherwise `nextCursor === null`
//    and the caller knows there is nothing left to walk.
//
//  - `cursor` is the SHA we want the next page to start at. Validated as a
//    7–64-char hex string before we ever touch git, so a junk cursor
//    classifies as `bad_revision` upfront rather than reaching git's
//    parser. When cursor is provided, `branch` is ignored — the cursor is
//    a fully-qualified starting point; layering a branch on top would
//    silently change which side of the DAG we walked.
//
//  - `branch` is validated against a conservative ref-name grammar (no
//    leading `-`, no `..`, no `~` / `^` / space / control chars). simple-git
//    invokes git via `execFile`, so a pathological branch name cannot reach
//    a shell — but git itself parses ref names and we don't want a
//    `--upload-pack=...` look-alike sneaking through as a "branch".
//
//  - The argv we hand to git is, in order:
//        log -n <limit+1> --no-color --no-decorate
//            --pretty=format:'%H<TAB>%an<TAB>%ae<TAB>%at<TAB>%P<TAB>%s'
//            --end-of-options [<cursor> | <branch>]?
//    `--end-of-options` is the bright line: every positional after it is a
//    ref/path, never an option. Even if some future refactor lets a
//    leading-dash string slip past validation, git refuses to interpret it
//    as a flag past that sentinel.
//
//  - Audit: one `git_audit_log` row per call (action='log'). Payload is
//    summary-only — `{limit, has_cursor, has_branch}` — so a forensic dump
//    never carries cursor SHAs (forensic noise) or branch names that might
//    smell of commercial-sensitive feature work.
//
// Empty repo (`fatal: your current branch '<x>' does not have any commits
// yet` — or, on a brand-new clone, "does not have any commits yet") is the
// one classification we promote OUT of `unknown` into a structured
// `{ok:true, commits:[], nextCursor:null}`. The semantic is "the operation
// succeeded, the repo just doesn't have any history to show" — UIs render
// that as an empty state, not an error toast.

/**
 * Single commit row in the response. `parents` is split out from the raw
 * `%P` (space-separated parent SHAs) so the UI can detect merge commits
 * (`parents.length >= 2`) without re-parsing.
 */
export interface GitLogCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Author timestamp as unix-epoch seconds (`%at`). */
  ts: number;
  subject: string;
  parents: string[];
}

export type GitLogReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "timeout"
  | "unknown";

export interface RunGitLogOptions {
  /** Absolute path to the working tree. */
  cwd: string;
  /** Page size. Defaults to 30; clamped to [1, 100]. */
  limit?: number;
  /**
   * Pagination cursor — the SHA the next page should start at. Validated as
   * a 7–64-char hex string upfront. Mutually exclusive with `branch`:
   * when set, `branch` is ignored.
   */
  cursor?: string;
  /**
   * Optional branch / ref to walk from. When omitted (and `cursor` is also
   * omitted), git walks from `HEAD`. Validated against a conservative
   * grammar before being passed to git.
   */
  branch?: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitLogResult {
  ok: boolean;
  commits?: GitLogCommit[];
  /** Next page's starting SHA, or `null` when there is nothing more to walk. */
  nextCursor?: string | null;
  reason?: GitLogReason;
  message?: string;
  stderr?: string;
}

/** Cursor must be a hex SHA prefix (7..64 chars). */
const CURSOR_RE = /^[0-9a-fA-F]{7,64}$/;
/**
 * Conservative branch-name grammar. We deliberately disallow more than git
 * itself does: no leading `-` (option look-alike), no `..` / `@{` / ASCII
 * control / whitespace / `~^:?*[\\` characters. Operators with weird ref
 * names can call git directly; the daemon's button surface stays narrow.
 */
const BRANCH_RE = /^[A-Za-z0-9_./+-]+$/;
const LOG_FIELD_SEP = "\t";
const LOG_PRETTY = `--pretty=format:%H${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%at${LOG_FIELD_SEP}%P${LOG_FIELD_SEP}%s`;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Read the recent commit history of a project / workspace, paginated. See
 * the section header above for the full design contract.
 */
export async function runGitLog(
  cwd: string,
  opts: Omit<RunGitLogOptions, "cwd">,
): Promise<RunGitLogResult> {
  // 1. Validate inputs BEFORE we touch git. An out-of-range limit, a junk
  //    cursor, or a leading-dash branch never reach simple-git — `bad_revision`
  //    is returned upfront with a message that names the offending field.
  const rawLimit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit) || rawLimit < 1) {
    return {
      ok: false,
      reason: "bad_revision",
      message: `Invalid 'limit' — must be a positive integer (got ${String(rawLimit)}).`,
    };
  }
  const limit = Math.min(rawLimit, MAX_LIMIT);

  if (opts.cursor !== undefined && !CURSOR_RE.test(opts.cursor)) {
    return {
      ok: false,
      reason: "bad_revision",
      message: "Invalid 'cursor' — must be a 7..64-char hex SHA.",
    };
  }
  if (opts.branch !== undefined && !BRANCH_RE.test(opts.branch)) {
    return {
      ok: false,
      reason: "bad_revision",
      message:
        "Invalid 'branch' — must match [A-Za-z0-9_./+-]+ with no leading '-'.",
    };
  }

  // 2. Build argv. We explicitly NEVER pass --all, --graph, or any pathspec
  //    — the contract is "linear history of one ref, paginated". When both
  //    cursor and branch are set, cursor wins (see header comment).
  const args: string[] = [
    "log",
    `-n`,
    String(limit + 1),
    "--no-color",
    "--no-decorate",
    LOG_PRETTY,
    "--end-of-options",
  ];
  const startRef = opts.cursor ?? opts.branch;
  if (startRef !== undefined) args.push(startRef);

  const cmd = await runGitCommand<{ stdout: string }>({
    cwd,
    action: "log",
    timeoutMs: opts.timeoutMs,
    run: async (git) => {
      const stdout = await git.raw(args);
      return { stdout };
    },
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      // Audit payload is summary-only — never the cursor SHA (forensic noise)
      // and never the branch name (can leak in-flight feature names). The
      // `has_*` flags are enough to correlate with rate / failure patterns.
      argsJson: JSON.stringify({
        limit,
        has_cursor: opts.cursor !== undefined,
        has_branch: opts.branch !== undefined,
      }),
    },
  });

  if (cmd.ok && cmd.data) {
    const commits = parseGitLogOutput(cmd.data.stdout);
    let nextCursor: string | null = null;
    if (commits.length > limit) {
      // The (limit+1)-th row is the next page's starting point. Trim it
      // before returning so callers always see exactly `limit` rows on a
      // full page; the SHA is surfaced via nextCursor.
      nextCursor = commits[limit]!.sha;
      commits.length = limit;
    }
    return { ok: true, commits, nextCursor, reason: "ok" };
  }

  // 3. Empty-repo special case — git's stderr varies slightly across
  //    versions but always contains "does not have any commits". Promote
  //    that out of the `unknown` bucket into an explicit empty success so
  //    the UI can render an empty-state instead of a red toast.
  const stderr = cmd.stderr ?? "";
  if (/does not have any commits/i.test(stderr)) {
    return { ok: true, commits: [], nextCursor: null, reason: "ok" };
  }

  return {
    ok: false,
    reason: gitReasonToLogReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

/**
 * Parse the tab-separated output `git log --pretty=format:...` produces for
 * the `LOG_PRETTY` format string. `%P` is space-separated parent SHAs (empty
 * for the root commit); `%at` is unix-epoch seconds. The subject is the
 * last field so it can legally contain tabs without us having to escape.
 */
function parseGitLogOutput(stdout: string): GitLogCommit[] {
  if (!stdout.trim()) return [];
  const lines = stdout.split("\n");
  const out: GitLogCommit[] = [];
  for (const line of lines) {
    if (!line) continue;
    // Split into at most 6 columns so a subject containing a literal tab
    // still ends up entirely in the last field.
    const parts = line.split(LOG_FIELD_SEP);
    /* v8 ignore next 3 — defensive: --pretty=format with a fixed 6-field
       template always emits exactly 6 fields per line. A short row would
       indicate a git binary regression, not a code path under test. */
    if (parts.length < 6) continue;
    const [sha, author, email, atRaw, parentsRaw, ...rest] = parts as [
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    const subject = rest.join(LOG_FIELD_SEP);
    const ts = Number.parseInt(atRaw, 10);
    out.push({
      sha,
      shortSha: sha.slice(0, 7),
      author,
      email,
      ts: Number.isFinite(ts) ? ts : 0,
      subject,
      parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
    });
  }
  return out;
}

/**
 * Map the broader `GitReason` set to the log-relevant subset. Reasons a
 * read-only walk cannot legitimately produce (auth, dirty tree, diverged,
 * empty index, etc.) collapse to `unknown` so the caller doesn't hit a
 * value outside its switch. `bad_revision` is recovered from stderr text
 * because git emits it as a generic stderr that the v2 classifier doesn't
 * model; the substring match here is the same belt-and-braces pattern
 * `gitReasonToPullReason` uses for `network_error`.
 */
function gitReasonToLogReason(reason: GitReason, stderr: string): GitLogReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      if (
        /bad revision|unknown revision|ambiguous argument/i.test(stderr) ||
        /not a valid object name/i.test(stderr)
      ) {
        return "bad_revision";
      }
      return "unknown";
  }
}

// ─── runGitDiscard ─────────────────────────────────────────────────────────
//
// Revert uncommitted changes for a caller-specified set of paths. Backs the
// "Discard" button in the source-control rail. Implementation calls
// `git checkout -- <paths…>` in a single argv: this is git's traditional
// way to drop both staged and unstaged changes for a tracked path, and the
// equivalent `git restore <paths>` (git ≥2.23) deliberately mirrors the
// same semantics. Going through one batch invocation rather than per-path
// calls keeps the operation atomic-ish at the git level — either every
// listed path is reverted or git's own validation rejects the whole set.
//
// **Path-validation contract.** Every entry MUST:
//   1. Be a non-empty string.
//   2. Be a *relative* path (never absolute) — absolute paths could escape
//      the repo even when they happen to point inside it, so we refuse
//      them outright.
//   3. Contain no NUL byte (`\0`) — Node's path APIs throw on these but
//      argv passed to git via execFile would treat them as terminators on
//      some platforms. Belt-and-braces.
//   4. After `path.resolve(cwd, p)`, the joined path MUST stay inside
//      `cwd` (no `..` traversal). This is the same prefix-check the
//      filesystem read endpoint uses (`resolveSafePath`); kept inline so
//      the git-operations module has zero coupling to fs-operations.
//
// Untracked files are NOT supported by `git checkout --` (git emits
// `error: pathspec '…' did not match any file(s)` and exits non-zero).
// The closure surfaces that as `unknown_path` for the same reason
// `runGitCommit` does — it is the most operator-actionable classification
// for "git refused to act on a path you named".
//
// **Audit payload.** Counts-only: `{ paths_count }`. Never the raw paths.
// Forensic correlation needs to know "X files were discarded in project
// Y at time T"; the actual paths are user filesystem state and would
// drown the audit log in noise / can leak feature-name intent.

export type GitDiscardReason =
  | "ok"
  | "no_paths"
  | "invalid_path"
  | "path_outside_repo"
  | "unknown_path"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitDiscardOptions {
  /** Absolute path to the working tree. */
  cwd: string;
  /** Relative paths to revert. Empty/missing → `no_paths`, no audit row. */
  paths: string[];
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitDiscardResult {
  ok: boolean;
  /** Number of paths git was asked to revert. Only set on success. */
  filesDiscarded?: number;
  reason?: GitDiscardReason;
  message?: string;
  stderr?: string;
}

/**
 * Validate a single relative path against the discard contract. Returns the
 * jailed relative form on success; null + reason/message on failure. Pure /
 * side-effect free so the input check can run BEFORE we touch git.
 */
function validateDiscardPath(
  cwd: string,
  raw: unknown,
):
  | { ok: true; relative: string }
  | { ok: false; reason: GitDiscardReason; message: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      reason: "invalid_path",
      message: "path must be a non-empty string",
    };
  }
  if (raw.indexOf("\0") !== -1) {
    return {
      ok: false,
      reason: "invalid_path",
      message: "path contains NUL byte",
    };
  }
  if (isAbsolute(raw)) {
    return {
      ok: false,
      reason: "invalid_path",
      message: `path must be relative to the repo root: ${raw}`,
    };
  }
  const absoluteRoot = resolve(cwd);
  const joined = resolve(absoluteRoot, raw);
  if (joined !== absoluteRoot && !joined.startsWith(absoluteRoot + sep)) {
    return {
      ok: false,
      reason: "path_outside_repo",
      message: `path escapes the repo root: ${raw}`,
    };
  }
  // Forbid the bare repo root — discarding "everything" is a footgun the
  // UI's "Discard All" button doesn't go through this code path for; the
  // caller is asking for "discard these specific tracked files", which by
  // definition needs at least one path component.
  if (joined === absoluteRoot) {
    return {
      ok: false,
      reason: "invalid_path",
      message: "path must be a file inside the repo, not the repo root",
    };
  }
  return { ok: true, relative: raw };
}

/**
 * Discard uncommitted changes for one or more tracked paths via
 * `git checkout -- <paths…>`. See the section header above for the full
 * design contract.
 */
export async function runGitDiscard(
  cwd: string,
  paths: string[],
  opts: {
    projectId?: number | string;
    workspaceId?: number | string;
    timeoutMs?: number;
  } = {},
): Promise<RunGitDiscardResult> {
  // 1. Empty-list short-circuit BEFORE the runGitCommand envelope. A no-op
  //    discard call must NOT produce an audit row — the same rationale
  //    `runGitCommit` uses for empty-message rejection.
  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      ok: false,
      reason: "no_paths",
      message: "paths is empty — nothing to discard",
    };
  }

  // 2. Per-path validation. We reject the WHOLE call if any single entry is
  //    bad — partial application would leave the working tree in an
  //    operator-confusing half-discarded state.
  const validated: string[] = [];
  for (const p of paths) {
    const v = validateDiscardPath(cwd, p);
    if (!v.ok) {
      return { ok: false, reason: v.reason, message: v.message };
    }
    validated.push(v.relative);
  }

  const cmd = await runGitCommand<{ filesDiscarded: number }>({
    cwd,
    action: "discard",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      // Counts-only: never raw paths. See section header for rationale.
      argsJson: JSON.stringify({ paths_count: validated.length }),
    },
    run: async (git) => {
      // 3. Single-batch checkout. `--` is the standard sentinel that
      //    separates revisions from pathspecs, so even a path that happens
      //    to look like a flag (`-foo`) cannot be reinterpreted as one.
      //    simple-git's `raw()` invokes git via execFile — no shell — so
      //    the validated relative path strings are passed verbatim as argv
      //    entries; quotes / semicolons / backticks inside a filename
      //    cannot be reinterpreted by a shell.
      try {
        await git.raw(["checkout", "--", ...validated]);
      } catch (err) {
        // `error: pathspec 'X' did not match any file(s)` is git's signal
        // that an entry is untracked / nonexistent — promote out of the
        // generic stderr classifier into the more actionable
        // `unknown_path` reason. simple-git's `raw()` surfaces git's
        // stderr via `.message` (the `.stderr` accessor is only populated
        // for the higher-level command wrappers like `git.pull()` /
        // `git.commit()`), so we read both for robustness against future
        // simple-git versions.
        const probe =
          err && typeof err === "object"
            ? (((err as { stderr?: unknown }).stderr as string | undefined) ?? "") +
              "\n" +
              (((err as { message?: unknown }).message as string | undefined) ?? "")
            : "";
        if (/did not match any file/i.test(probe) || /pathspec.*did not match/i.test(probe)) {
          throw Object.assign(new Error("unknown path(s)"), {
            gitReason: "unknown_path" as GitReason,
            message: `Path(s) not tracked by git: ${validated.join(", ")}`,
            stderr: probe.trim(),
          });
        }
        throw err;
      }
      return { filesDiscarded: validated.length };
    },
  });

  if (cmd.ok && cmd.data) {
    return {
      ok: true,
      filesDiscarded: cmd.data.filesDiscarded,
      reason: "ok",
    };
  }

  return {
    ok: false,
    reason: gitReasonToDiscardReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

function gitReasonToDiscardReason(reason: GitReason): GitDiscardReason {
  switch (reason) {
    case "ok":
    case "unknown_path":
    case "timeout":
    case "not_a_repo":
    case "path_missing":
      return reason;
    default:
      return "unknown";
  }
}

// ─── runGitFetch ───────────────────────────────────────────────────────────
//
// Refresh remote-tracking refs without merging. Backs the "Fetch" button in
// the source-control rail. The contract:
//
//  - Default remote is `'origin'`. Caller may override; the value is treated
//    as a single remote name (NOT a URL) and validated against a
//    conservative grammar before reaching git. Disallowing leading `-` is
//    the bright line — even though simple-git invokes git via execFile (no
//    shell), a leading-dash remote name would be parsed by git itself as a
//    flag (e.g. `--upload-pack=…`).
//  - Network-error detection reuses `classifyPullError` so the operator-
//    visible vocabulary stays consistent across pull and fetch surfaces:
//    "Could not resolve host" → `network_error`, "Connection refused" →
//    `network_error`, "Operation timed out" → `network_error`.
//  - Audit payload is `{ remote }` — fetch never carries credentials or
//    URLs in its argv (we pass a remote NAME only), so leaking the remote
//    label is safe and operator-useful.

export type GitFetchReason =
  | "ok"
  | "auth_failed"
  | "network_error"
  | "invalid_remote"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitFetchOptions {
  cwd: string;
  /** Default `'origin'`. Validated against `[A-Za-z0-9_./+-]+` grammar. */
  remote?: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitFetchResult {
  ok: boolean;
  remote?: string;
  reason?: GitFetchReason;
  message?: string;
  stderr?: string;
}

/**
 * Conservative remote-name grammar. Mirrors `BRANCH_RE` upstream — same
 * "letters, digits, _ . / + -" alphabet, no leading dash, no `..`, no
 * whitespace. An operator with a weirder remote name can call git directly;
 * the daemon's button surface stays narrow.
 */
const FETCH_REMOTE_RE = /^[A-Za-z0-9_./+-]+$/;

export async function runGitFetch(
  cwd: string,
  remote?: string,
  opts: {
    projectId?: number | string;
    workspaceId?: number | string;
    timeoutMs?: number;
  } = {},
): Promise<RunGitFetchResult> {
  const resolvedRemote = (remote ?? "").trim() || "origin";

  // 1. Remote-name validation BEFORE we touch git or write an audit row —
  //    same rationale as runGitLog's branch-name guard.
  if (!FETCH_REMOTE_RE.test(resolvedRemote) || resolvedRemote.startsWith("-")) {
    return {
      ok: false,
      reason: "invalid_remote",
      remote: resolvedRemote,
      message:
        "Invalid 'remote' — must match [A-Za-z0-9_./+-]+ with no leading '-'.",
    };
  }

  const cmd = await runGitCommand<{ remote: string }>({
    cwd,
    action: "fetch",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: JSON.stringify({ remote: resolvedRemote }),
    },
    run: async (git) => {
      // 2. `--end-of-options` is the same bright line runGitLog uses: even
      //    if a future refactor lets a leading-dash remote slip past the
      //    regex, git refuses to interpret anything past the sentinel as a
      //    flag. argv form, no shell, simple-git invokes via execFile.
      await git.raw(["fetch", "--end-of-options", resolvedRemote]);
      return { remote: resolvedRemote };
    },
  });

  if (cmd.ok && cmd.data) {
    return { ok: true, remote: cmd.data.remote, reason: "ok" };
  }

  return {
    ok: false,
    remote: resolvedRemote,
    reason: gitReasonToFetchReason(cmd.reason, cmd.stderr ?? ""),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

/**
 * Map the broader `GitReason` set to the fetch-relevant subset. The
 * `network_error` distinction lives only in the legacy pull-only classifier
 * (`classifyPullError`); we consult it for the `unknown` bucket so a "Could
 * not resolve host" stderr surfaces as `network_error` rather than
 * `unknown`. This is the same belt-and-braces pattern `gitReasonToPullReason`
 * uses.
 */
function gitReasonToFetchReason(
  reason: GitReason,
  stderr: string,
): GitFetchReason {
  switch (reason) {
    case "ok":
    case "auth_failed":
    case "timeout":
    case "not_a_repo":
    case "path_missing":
      return reason;
    default:
      if (stderr) {
        const pull = classifyPullError(stderr);
        if (pull === "auth_failed") return "auth_failed";
        if (pull === "network_error") return "network_error";
      }
      return "unknown";
  }
}

// ─── runGitDiff ────────────────────────────────────────────────────────────
//
// Read-only `git diff` browser backing the project / workspace source-control
// rail's per-file diff viewer. The contract:
//
//  - Every invocation diffs ONE relative path. The path goes after `--` so
//    leading-dash names cannot be reinterpreted as options, and the
//    `--end-of-options` sentinel is also passed before the path so even a
//    pre-`--` ref slot cannot smuggle a flag in.
//
//  - Three modes, picked by `staged` / `base` / `head`:
//      staged              → `git diff --cached -- <path>`            (index vs HEAD)
//      between refs        → `git diff <base> <head> -- <path>`       (committed history)
//      working (default)   → `git diff -- <path>`                     (worktree vs index)
//    Always with `--no-color`. `staged` and a base/head pair are mutually
//    exclusive — passing both is rejected upfront with `bad_revision`.
//
//  - Status detection: a cheap `git diff --name-status [scope] -- <path>`
//    runs first, so we can report `M`/`A`/`D`/`R` (and the rename old/new
//    paths) without having to parse the unified-diff output. `R\d+\told\tnew`
//    is parsed for renames; `C\d+` for copies. `binary` is detected via the
//    "Binary files … differ" line in the patch payload (which `--name-status`
//    cannot distinguish from a regular `M`). When name-status is empty we
//    return `status:'unchanged'` so the UI can render the empty diff.
//
//  - Patch size cap: simple-git uses spawn (not exec) and offers no
//    `maxBuffer` knob, so we collect the full output and then bail with
//    `git_patch_too_large` when its byte length exceeds `GIT_DIFF_MAX_BYTES`
//    (5 MiB). The `size` and `hint` fields in the response carry the
//    breach details so the UI can offer "open in terminal" instead. Tests
//    pass a smaller `maxBytes` to exercise the cap without writing a 5 MiB
//    fixture.
//
//  - Audit: one `git_audit_log` row per call (action='diff'). Payload is
//    `{ path, staged, has_base, has_head }` — the request-supplied relative
//    path is preserved (same forensic precedent as `fs_audit_log.path`),
//    but the actual ref values are summarised to flags so an in-flight
//    feature branch name doesn't leak into the audit table.

/**
 * Maximum bytes of unified-diff text we'll surface in a single response.
 * Past this we bail with `git_patch_too_large`. The default is 5 MiB —
 * enough for almost every real-world per-file diff (vendored lock files
 * are the worst case, and even those usually round-trip fine), small
 * enough that a single diff cannot OOM the daemon. Tests can override.
 */
export const GIT_DIFF_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Maximum bytes per side (`originalContent` / `modifiedContent`) when the
 * caller opts in via `includeContents`. The Monaco DiffEditor needs the
 * two full buffers, not a unified patch — but we don't want either side
 * to dominate memory by itself, so each side is capped at 2.5 MiB
 * (≈ half the unified-patch ceiling). On breach the offending side comes
 * back as `null`; the patch + status fields stay populated.
 */
export const GIT_DIFF_SIDE_MAX_BYTES = 2.5 * 1024 * 1024;

/**
 * Status discriminator on a successful diff response. `'M'`/`'A'`/`'D'`/
 * `'R'`/`'C'` come straight off `git diff --name-status`; `'binary'` is
 * promoted from the diff body (because `--name-status` reports binary
 * changes the same as text `M`); `'unchanged'` is returned when both
 * status-line and patch are empty.
 */
export type GitDiffStatus = "M" | "A" | "D" | "R" | "C" | "binary" | "unchanged";

export type GitDiffReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "git_patch_too_large"
  | "timeout"
  | "unknown";

export interface RunGitDiffOptions {
  /** Relative path inside the working tree. Must be non-empty. */
  path: string;
  /**
   * When true, diff the staging index against HEAD (`--cached`). Mutually
   * exclusive with `base` / `head`.
   */
  staged?: boolean;
  /**
   * Optional `<base>` ref/sha. When set with `head`, diffs the two refs.
   * Validated against a conservative ref-name grammar before being passed
   * to git so a leading-dash string cannot reach git's parser.
   */
  base?: string;
  /** Optional `<head>` ref/sha. Must be paired with `base`. */
  head?: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
  /**
   * Override `GIT_DIFF_MAX_BYTES` for tests. Production callers leave this
   * unset; the route layer never plumbs it through.
   */
  maxBytes?: number;
  /**
   * When true, the response is augmented with `originalContent` /
   * `modifiedContent` — the two FULL text buffers either side of the
   * patch. This is the input shape Monaco's `DiffEditor` accepts. Each
   * side is capped at {@link GIT_DIFF_SIDE_MAX_BYTES}; oversize sides
   * come back as `null` rather than truncated text (a partial buffer
   * would render as a misleading diff). Default: `false` — leaving the
   * historical commit-detail flow unchanged.
   */
  includeContents?: boolean;
  /**
   * Override `GIT_DIFF_SIDE_MAX_BYTES` for tests. Same precedent as
   * `maxBytes`; production callers leave this unset.
   */
  sideMaxBytes?: number;
}

export interface RunGitDiffResult {
  ok: boolean;
  /** Unified-diff text. Empty string when `status === 'unchanged'`. */
  patch?: string;
  /** Echo of `opts.base` for caller convenience; null when omitted. */
  base?: string | null;
  /** Echo of `opts.head` for caller convenience; null when omitted. */
  head?: string | null;
  status?: GitDiffStatus;
  /** Old path on a rename (`R`) or copy (`C`); absent otherwise. */
  oldPath?: string;
  /** New path on a rename / copy; absent otherwise. */
  newPath?: string;
  /** Patch byte length on success or on `git_patch_too_large` failure. */
  size?: number;
  /** Operator-friendly suggestion when the patch is over the cap. */
  hint?: string;
  /**
   * Source-side blob text — populated when {@link RunGitDiffOptions.includeContents}
   * was set on the request. `null` when:
   *   - status is `'binary'` (Monaco cannot render a meaningful binary diff);
   *   - the source side does not exist (status `'A'` — added file);
   *   - the side blob exceeds {@link GIT_DIFF_SIDE_MAX_BYTES};
   *   - the read failed for any other reason (network FS, etc.).
   * `undefined` when `includeContents` was not requested.
   */
  originalContent?: string | null;
  /**
   * Target-side blob text — populated when {@link RunGitDiffOptions.includeContents}
   * was set on the request. Same `null` semantics as
   * {@link RunGitDiffResult.originalContent}: `null` for binary, deleted-on-the-target
   * (status `'D'`), oversize, or read-failure cases.
   */
  modifiedContent?: string | null;
  reason?: GitDiffReason;
  message?: string;
  stderr?: string;
}

/**
 * Same conservative ref grammar the log endpoint uses (no leading `-`,
 * no `..`, no whitespace). Hex SHAs match because they are a strict
 * subset of `[A-Za-z0-9]+`. Re-using the regex keeps the validation
 * surface symmetric — operators that would be rejected here are also
 * rejected by `runGitLog`'s `branch` parameter.
 */
const DIFF_REF_RE = /^[A-Za-z0-9_./+-]+$/;

/**
 * Diff one file. See the section header above for the full design contract.
 *
 * Returns a structured result; never throws (validation failures and git
 * failures both flow through the discriminated `{ ok, reason }` envelope).
 */
export async function runGitDiff(
  cwd: string,
  opts: RunGitDiffOptions,
): Promise<RunGitDiffResult> {
  // 1. Validate inputs BEFORE we touch git. Bad input is reported as
  //    `bad_revision` with a message that names the offending field.

  if (typeof opts.path !== "string" || opts.path.length === 0) {
    return {
      ok: false,
      reason: "bad_revision",
      message: "Invalid 'path' — required non-empty string.",
    };
  }
  // No leading dash (option look-alike). The `--` separator below would
  // already protect git's own parser, but rejecting upfront keeps the
  // validation grammar symmetric across endpoints.
  if (opts.path.startsWith("-")) {
    return {
      ok: false,
      reason: "bad_revision",
      message: "Invalid 'path' — must not begin with '-'.",
    };
  }
  // Reject absolute paths and parent-traversal segments. Git would also
  // refuse them (working-tree-relative only), but classifying upfront is
  // cheaper and produces a clearer message.
  if (
    opts.path.startsWith("/") ||
    opts.path === ".." ||
    opts.path.startsWith("../") ||
    opts.path.includes("/../") ||
    opts.path.endsWith("/..")
  ) {
    return {
      ok: false,
      reason: "bad_revision",
      message: "Invalid 'path' — must be a working-tree-relative path.",
    };
  }
  if (opts.base !== undefined && !DIFF_REF_RE.test(opts.base)) {
    return {
      ok: false,
      reason: "bad_revision",
      message:
        "Invalid 'base' — must match [A-Za-z0-9_./+-]+ with no leading '-'.",
    };
  }
  if (opts.head !== undefined && !DIFF_REF_RE.test(opts.head)) {
    return {
      ok: false,
      reason: "bad_revision",
      message:
        "Invalid 'head' — must match [A-Za-z0-9_./+-]+ with no leading '-'.",
    };
  }
  // `staged` is per-call; combining it with a base/head pair would conflate
  // two distinct diffs. Reject upfront.
  if (
    opts.staged === true &&
    (opts.base !== undefined || opts.head !== undefined)
  ) {
    return {
      ok: false,
      reason: "bad_revision",
      message:
        "Invalid combination — 'staged' is mutually exclusive with 'base' / 'head'.",
    };
  }
  // Pair `base` and `head`: a single ref alone is ambiguous (which side
  // is the working tree?). Force the caller to be explicit.
  if (
    (opts.base !== undefined && opts.head === undefined) ||
    (opts.head !== undefined && opts.base === undefined)
  ) {
    return {
      ok: false,
      reason: "bad_revision",
      message:
        "Invalid combination — 'base' and 'head' must be provided together.",
    };
  }

  const staged = opts.staged === true;
  const maxBytes = opts.maxBytes ?? GIT_DIFF_MAX_BYTES;

  // 2. Build the scope-prefix shared between the two raw calls (status
  //    pass + patch pass). Same prefix in both keeps name-status and the
  //    unified diff in lock-step.
  const scopeArgs: string[] = [];
  if (staged) scopeArgs.push("--cached");
  if (opts.base !== undefined && opts.head !== undefined) {
    scopeArgs.push(opts.base, opts.head);
  }

  // Tail is the bright line: `--end-of-options` rejects any positional
  // after it from being interpreted as a flag, and `--` separates ref
  // arguments from path arguments. Both belt-and-braces because the path
  // can technically be a working-tree-relative string we did not author.
  const tail = ["--end-of-options", "--", opts.path];

  const audit = {
    projectId:
      opts.projectId !== undefined ? String(opts.projectId) : undefined,
    workspaceId:
      opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
    // Forensic payload — the relative path is preserved (same precedent as
    // fs_audit_log.path; it never escapes the working-tree-relative shape).
    // Ref values are reduced to flags so a feature-branch name cannot leak
    // through the audit table even with read access.
    argsJson: JSON.stringify({
      path: opts.path,
      staged,
      has_base: opts.base !== undefined,
      has_head: opts.head !== undefined,
    }),
  };

  const cmd = await runGitCommand<{
    parsed: ReturnType<typeof findStatusForPath>;
    patch: string;
  }>({
    cwd,
    action: "diff",
    timeoutMs: opts.timeoutMs,
    audit,
    run: async (git) => {
      // Status pass — UNFILTERED on path. Rationale: rename detection in
      // `git diff --name-status` requires comparing all entries — restricting
      // the output to a single path filter strips the rename source from
      // git's view and the row collapses to a plain `A`. We collect the full
      // (still cheap — it's one row per changed file) name-status output and
      // pick the row whose old or new path matches the request.
      const statusOutput = await git.raw([
        "diff",
        "--name-status",
        ...scopeArgs,
        "--end-of-options",
      ]);
      const parsed = findStatusForPath(statusOutput, opts.path);

      // Patch pass — paths are filter-narrowed so the unified diff stays
      // proportional to the requested file, not the whole changeset. For a
      // rename / copy we MUST pass BOTH paths (old AND new) — otherwise git
      // sees only the new side and emits an "A" diff with no rename header.
      const patchPaths =
        (parsed?.status === "R" || parsed?.status === "C") &&
        parsed.oldPath &&
        parsed.newPath
          ? [parsed.oldPath, parsed.newPath]
          : [opts.path];
      const patch = await git.raw([
        "diff",
        "--no-color",
        ...scopeArgs,
        "--end-of-options",
        "--",
        ...patchPaths,
      ]);
      return { parsed, patch };
    },
  });

  if (cmd.ok && cmd.data) {
    const { parsed, patch } = cmd.data;

    // 3. Patch-size cap. simple-git collected the full output already, so
    //    "too large" is a post-hoc check; the spec's intent is that we
    //    reject the response without sending it down to the UI rather
    //    than that we never read it (we cannot enforce the latter without
    //    re-implementing the spawn pipeline).
    if (patch.length > maxBytes) {
      const hintScope = staged
        ? "--cached -- "
        : opts.base !== undefined && opts.head !== undefined
          ? `${opts.base} ${opts.head} -- `
          : "-- ";
      return {
        ok: false,
        reason: "git_patch_too_large",
        size: patch.length,
        hint: `git diff ${hintScope}${opts.path}`,
        message: `Patch exceeds ${maxBytes} bytes (${patch.length}). Run the printed git command directly to view it.`,
      };
    }

    // 4. Classify the row picked from `--name-status` against the patch.
    //
    // Binary discriminator wins over the M/A/D classifier — `--name-status`
    // reports a binary modify identically to a text modify.
    let status: GitDiffStatus;
    if (parsed === null) {
      // Empty status output → nothing changed for this path under the chosen scope.
      status = "unchanged";
    } else if (
      parsed.status === "M" &&
      /^Binary files .* differ$/m.test(patch)
    ) {
      status = "binary";
    } else {
      status = parsed.status;
    }

    // 4b. Optional content fetch for the Monaco DiffEditor surface. Only
    //     runs when the caller asks for it, so the historical commit-detail
    //     flow (which only needs the unified patch) remains a single
    //     git-raw call.
    let originalContent: string | null | undefined;
    let modifiedContent: string | null | undefined;
    if (opts.includeContents === true) {
      const sideMaxBytes = opts.sideMaxBytes ?? GIT_DIFF_SIDE_MAX_BYTES;
      // Binary / unchanged sides: no point fetching either buffer. Monaco
      // would render binary as garbled text anyway, and an unchanged path
      // by definition has identical sides — the UI already has the file
      // bytes via the existing fs/file query.
      if (status === "binary" || status === "unchanged") {
        originalContent = null;
        modifiedContent = null;
      } else {
        // Resolve the ref tokens for each side. The shape is:
        //   - staged                 → original=HEAD,   modified=:0 (index)
        //   - between refs (base/head) → original=base, modified=head
        //   - working tree (default) → original=:0 (index), modified= worktree (special — fs read)
        const oldPathSide = parsed?.oldPath ?? opts.path;
        const newPathSide = parsed?.newPath ?? opts.path;

        let origRef: string | null;
        let modRef: string | "WORKTREE" | null;
        if (staged) {
          origRef = "HEAD";
          modRef = "";
        } else if (opts.base !== undefined && opts.head !== undefined) {
          origRef = opts.base;
          modRef = opts.head;
        } else {
          origRef = "";
          modRef = "WORKTREE";
        }

        // Statuses A and D collapse one side to empty without needing a
        // git show round-trip — git would refuse the missing path with a
        // `path '...' exists on disk, but not in '<ref>'` style stderr,
        // which we'd then have to special-case anyway.
        if (status === "A") origRef = null;
        if (status === "D") modRef = null;

        originalContent = origRef === null
          ? ""
          : await readSideBlob(cwd, origRef, oldPathSide, sideMaxBytes);
        modifiedContent = modRef === null
          ? ""
          : modRef === "WORKTREE"
            ? await readSideWorktree(cwd, newPathSide, sideMaxBytes)
            : await readSideBlob(cwd, modRef, newPathSide, sideMaxBytes);
      }
    }

    return {
      ok: true,
      patch,
      base: opts.base ?? null,
      head: opts.head ?? null,
      status,
      ...(parsed?.oldPath ? { oldPath: parsed.oldPath } : {}),
      ...(parsed?.newPath ? { newPath: parsed.newPath } : {}),
      size: patch.length,
      ...(opts.includeContents === true
        ? { originalContent: originalContent!, modifiedContent: modifiedContent! }
        : {}),
      reason: "ok",
    };
  }

  // 5. Failure mapping. Stderr text is the only signal we can use to
  //    promote `unknown` → `bad_revision` when git rejects an unknown
  //    ref or path. Same belt-and-braces pattern `runGitLog` uses.
  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    reason: gitReasonToDiffReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

/**
 * Read the on-disk working-tree text for a path, capped at `maxBytes`.
 * Returns the full text on success, `""` when the path is missing (status
 * `'D'` already short-circuits this, but a deletion-after-stage flake can
 * still race), or `null` when the file is over the cap or the read fails
 * for a non-ENOENT reason. Used as the modified side of a working-tree
 * diff in `runGitDiff`.
 */
async function readSideWorktree(
  cwd: string,
  relPath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const abs = join(cwd, relPath);
    const stat = await fsp.stat(abs);
    if (stat.size > maxBytes) return null;
    return await fsp.readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    return null;
  }
}

/**
 * Read a git blob for `<ref>:<path>` via `git show`, capped at `maxBytes`.
 * `ref` may be empty (`":<path>"` resolves to the index entry — git's
 * own pseudo-ref for stage 0). Returns the full text on success, `""`
 * when git reports the path doesn't exist at that ref (status `'A'`
 * already short-circuits, but defence-in-depth), or `null` on oversize
 * or any other failure (binary blobs that throw on UTF-8 decode, refs
 * that vanished mid-call).
 */
async function readSideBlob(
  cwd: string,
  ref: string,
  relPath: string,
  maxBytes: number,
): Promise<string | null> {
  // Normalise `ref:path`. Empty ref means the index — git's `:<path>`
  // form. Anything else is `<ref>:<path>` straight.
  const spec = ref === "" ? `:${relPath}` : `${ref}:${relPath}`;
  try {
    const git = simpleGit(cwd, {
      timeout: { block: 10_000 },
      unsafe: { allowUnsafeSshCommand: true },
    });
    // `--end-of-options` defends against a `<ref>:<path>` that begins with
    // `-` (rare but possible; the regex on `base`/`head` already rejects
    // leading dashes upfront, but the path may still). Output is captured
    // into memory; cap is enforced post-hoc since simple-git collects the
    // full buffer.
    const out = await git.raw(["show", "--end-of-options", spec]);
    // Byte length, not char count — JS strings are UTF-16 so `.length` is
    // ambiguous; `Buffer.byteLength` is the correct comparator against a
    // byte-cap.
    if (Buffer.byteLength(out, "utf8") > maxBytes) return null;
    return out;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    // Git's "exists on disk, but not in '<ref>'" / "fatal: path '...' does
    // not exist in '<ref>'" both indicate a missing-on-side path. Treat
    // as empty rather than null so the diff editor renders an empty side
    // (the natural reading for an A/D-on-side file).
    if (/exists on disk, but not in|does not exist in/.test(stderr)) {
      return "";
    }
    return null;
  }
}

/**
 * Walk the (potentially multi-line) `git diff --name-status` output and
 * pick the row that describes the requested path. Returns `null` when no
 * row matches (or when the output is empty — i.e. nothing changed in scope).
 *
 * Why we walk the whole output rather than rely on a `-- <path>` filter:
 * git's rename detection compares every entry in the changeset; restricting
 * the name-status output to a single path strips the rename source from
 * view and the row collapses to a plain `A`. Walking the full list (which
 * is at most one row per changed file under git's standard behaviour) keeps
 * rename detection intact while still letting us isolate the single row
 * that names our path.
 *
 * For a rename / copy row (`R<percent>\told\tnew`), the request can come in
 * naming either side — both `?path=old.txt` and `?path=new.txt` resolve to
 * the rename. We always echo `old`/`new` paths back into `oldPath` /
 * `newPath` so the UI can render `old → new` without re-parsing.
 */
function findStatusForPath(
  out: string,
  requestedPath: string,
): {
  status: "M" | "A" | "D" | "R" | "C";
  oldPath?: string;
  newPath?: string;
} | null {
  if (!out || !out.trim()) return null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    /* v8 ignore next 2 — defensive: --name-status always emits at least <code>\t<path> for non-empty rows */
    if (parts.length < 2) continue;
    const code = parts[0]!;
    if (/^R\d+$/.test(code) && parts.length >= 3) {
      const oldPath = parts[1]!;
      const newPath = parts[2]!;
      if (oldPath === requestedPath || newPath === requestedPath) {
        return { status: "R", oldPath, newPath };
      }
      continue;
    }
    if (/^C\d+$/.test(code) && parts.length >= 3) {
      const oldPath = parts[1]!;
      const newPath = parts[2]!;
      if (oldPath === requestedPath || newPath === requestedPath) {
        return { status: "C", oldPath, newPath };
      }
      continue;
    }
    if (code === "M" || code === "A" || code === "D") {
      if (parts[1] === requestedPath) {
        return { status: code };
      }
      continue;
    }
    /* v8 ignore next 2 — defensive: any other code (T/U/X/B) is not produced by `git diff` under normal repo state */
    continue;
  }
  return null;
}

/**
 * Map the broader `GitReason` set to the diff-relevant subset. Reasons a
 * read-only diff cannot legitimately produce (auth, dirty tree, diverged,
 * empty index, etc.) collapse to `unknown` so the caller doesn't hit a
 * value outside its switch. `bad_revision` is recovered from stderr text
 * because git emits it as a generic stderr that the v2 classifier doesn't
 * model — same belt-and-braces pattern `gitReasonToLogReason` uses.
 */
function gitReasonToDiffReason(
  reason: GitReason,
  stderr: string,
): GitDiffReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      if (
        /bad revision|unknown revision|ambiguous argument/i.test(stderr) ||
        /not a valid object name/i.test(stderr) ||
        /pathspec .* did not match/i.test(stderr)
      ) {
        return "bad_revision";
      }
      return "unknown";
  }
}

// ─── Branch operations: list / checkout / delete ──────────────────────────
//
// These three helpers back the new project / workspace "Branches" surface:
//
//   • runGitBranchList     — read-only enumeration of local + remote refs
//                            with current-branch / upstream / ahead-behind.
//   • runGitCheckout       — switch to (or create) a branch; refuses on a
//                            dirty working tree (same guard as runGitPull).
//   • runGitBranchDelete   — `git branch -d` (or `-D` with `force`); refuses
//                            outright on `main` / `master` unless force is
//                            set, and surfaces "cannot delete current branch"
//                            as a structured reason rather than a raw stderr.
//
// All three flow through `runGitCommand`, so the audit-row write, wall-clock
// timeout, and stderr classification stay in one place. The only difference
// vs the existing pull / commit / push helpers is the action label written
// to `git_audit_log.action` (`branch_list`, `checkout`, `branch_delete`) —
// see migration 0050 for the matching CHECK widening.

/**
 * Reasons `runGitBranchList` can finish with. Read-only operation; the
 * mutation-class reasons (`auth_failed`, `dirty_tree`, etc.) cannot fire.
 */
export type GitBranchListReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitBranchEntry {
  name: string;
  /** True for the branch HEAD currently points at (`*` column from for-each-ref). */
  current: boolean;
  /** Tracking branch (e.g. `origin/main`) or `null` when none is configured. */
  upstream: string | null;
  /** Commits the local branch is ahead of upstream by; 0 when no upstream. */
  ahead: number;
  /** Commits behind upstream; 0 when no upstream. */
  behind: number;
  /** True for refs under `refs/remotes/`. */
  isRemote: boolean;
}

export interface RunGitBranchListResult {
  ok: boolean;
  branches?: GitBranchEntry[];
  /** True when HEAD is detached (no `*` row in the local-branch slice). */
  detached?: boolean;
  reason?: GitBranchListReason;
  message?: string;
  stderr?: string;
}

/**
 * Branch-list field separator. Pipe (`|`) is rejected by the branch-name
 * regex on every public surface, so it cannot appear inside a refname:short
 * value and split a row into the wrong number of columns.
 *
 * Field order: `refname | refname:short | HEAD | upstream:short | upstream:track`
 *
 * `%(refname)` is the full ref path (`refs/heads/main` or
 * `refs/remotes/origin/main`); used for the local-vs-remote classification
 * because `%(HEAD)` emits a space for both "non-current local branch" and
 * "remote ref" — making it useless as a discriminator on its own.
 */
const BRANCH_LIST_FIELD_SEP = "|";
const BRANCH_LIST_FORMAT = `--format=%(refname)${BRANCH_LIST_FIELD_SEP}%(refname:short)${BRANCH_LIST_FIELD_SEP}%(HEAD)${BRANCH_LIST_FIELD_SEP}%(upstream:short)${BRANCH_LIST_FIELD_SEP}%(upstream:track)`;

/**
 * Enumerate local + remote refs via `for-each-ref`. The format string is
 * pinned so the parser stays a deterministic split-and-map; we never run
 * `git branch -a` (its output is locale-dependent and shells in with
 * `* `, `  `, `+ ` markers we'd have to guess at).
 *
 * Audit payload is `{}` — list invocations have no operator-meaningful
 * arguments, and the action label alone tells you which surface fired.
 */
export async function runGitBranchList(
  cwd: string,
  opts: {
    projectId?: number | string;
    workspaceId?: number | string;
    timeoutMs?: number;
  } = {},
): Promise<RunGitBranchListResult> {
  const cmd = await runGitCommand<{ stdout: string }>({
    cwd,
    action: "branch_list",
    timeoutMs: opts.timeoutMs,
    run: async (git) => {
      const stdout = await git.raw([
        "for-each-ref",
        BRANCH_LIST_FORMAT,
        "refs/heads",
        "refs/remotes",
      ]);
      return { stdout };
    },
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: "{}",
    },
  });

  if (cmd.ok && cmd.data) {
    const { branches, detached } = parseBranchListOutput(cmd.data.stdout);
    return { ok: true, branches, detached, reason: "ok" };
  }

  return {
    ok: false,
    reason: gitReasonToBranchListReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

/**
 * Parse the five-column `|`-separated rows from `for-each-ref`:
 *   refname | refname:short | HEAD | upstream:short | upstream:track
 *
 * The `track` column is git-emitted text like `[ahead 2, behind 1]` /
 * `[ahead 3]` / `[behind 4]` / `[gone]` / empty. We extract numeric
 * ahead/behind via simple regex; anything we can't parse stays at 0.
 *
 * `detached` is true when no local branch row carries the `*` HEAD marker
 * AND at least one local branch exists — distinguishes "detached HEAD on a
 * populated repo" from "no branches at all" (empty repo).
 *
 * Local vs remote classification uses the full `%(refname)` prefix:
 *   - `refs/heads/…`   → local branch
 *   - `refs/remotes/…` → remote-tracking branch
 * `%(HEAD)` cannot be the discriminator on its own because it emits a
 * space character for *both* "non-current local branch" and "remote ref".
 */
function parseBranchListOutput(stdout: string): {
  branches: GitBranchEntry[];
  detached: boolean;
} {
  const out: GitBranchEntry[] = [];
  let sawCurrent = false;
  let sawLocal = false;

  if (!stdout.trim()) return { branches: out, detached: false };

  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    const parts = rawLine.split(BRANCH_LIST_FIELD_SEP);
    /* v8 ignore next 3 — defensive: the format string emits exactly 5 fields
       per row; a short row would indicate a git binary regression. */
    if (parts.length < 5) continue;
    const [refname, name, headFlag, upstreamShort, trackRaw] = parts as [
      string,
      string,
      string,
      string,
      ...string[],
    ];
    if (!name) continue;
    const isRemoteRef = refname.startsWith("refs/remotes/");
    if (!isRemoteRef) sawLocal = true;
    const current = headFlag === "*";
    if (current) sawCurrent = true;

    let ahead = 0;
    let behind = 0;
    const track = (trackRaw ?? "").trim();
    const aheadMatch = /\bahead (\d+)/.exec(track);
    const behindMatch = /\bbehind (\d+)/.exec(track);
    if (aheadMatch) ahead = Number.parseInt(aheadMatch[1]!, 10) || 0;
    if (behindMatch) behind = Number.parseInt(behindMatch[1]!, 10) || 0;

    out.push({
      name,
      current,
      upstream: upstreamShort ? upstreamShort : null,
      ahead,
      behind,
      isRemote: isRemoteRef,
    });
  }

  return { branches: out, detached: sawLocal && !sawCurrent };
}

function gitReasonToBranchListReason(reason: GitReason): GitBranchListReason {
  switch (reason) {
    case "ok":
    case "not_a_repo":
    case "path_missing":
    case "timeout":
      return reason;
    default:
      return "unknown";
  }
}

// ─── runGitCheckout ────────────────────────────────────────────────────────

export type GitCheckoutReason =
  | "ok"
  | "dirty_working_tree"
  | "branch_not_found"
  | "branch_already_exists"
  | "invalid_branch_name"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitCheckoutOptions {
  cwd: string;
  /** Branch name. Pre-validated against the public regex by the route layer; we re-check defensively here. */
  branch: string;
  /** When true, run `git checkout -b <branch> [<startPoint>]`. */
  create?: boolean;
  /** Optional starting ref for `-b`. Ignored when `create` is false. */
  startPoint?: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitCheckoutResult {
  ok: boolean;
  branch?: string;
  /** True when the operation created a new branch (`create=true` path). */
  created?: boolean;
  reason?: GitCheckoutReason;
  message?: string;
  stderr?: string;
}

/**
 * Defensive re-check of the branch-name regex. Routes already validate via
 * zod, but a future direct-API caller could reach this surface; failing
 * fast here keeps the stderr-classification path narrow.
 *
 * Mirrors the `BRANCH_NAME` regex pinned in the slice spec:
 *   word chars, hyphen, dot, slash, Cyrillic — and nothing else.
 */
const SERVICE_BRANCH_NAME_RE = /^[\w\-./а-яА-ЯёЁ]+$/u;

/**
 * Switch to (or create) a branch on the working tree. Refuses on a dirty
 * working tree — same invariant `runGitPull` enforces — so a button click
 * never silently rewrites uncommitted edits.
 *
 * Audit payload is `{ branch, create, has_start_point }` — never the
 * startPoint value (might leak in-flight feature SHAs / branch names that
 * encode commercial intent).
 */
export async function runGitCheckout(
  opts: RunGitCheckoutOptions,
): Promise<RunGitCheckoutResult> {
  if (!SERVICE_BRANCH_NAME_RE.test(opts.branch)) {
    return {
      ok: false,
      reason: "invalid_branch_name",
      message: `Invalid branch name: ${opts.branch}`,
    };
  }
  if (opts.startPoint !== undefined && !SERVICE_BRANCH_NAME_RE.test(opts.startPoint)) {
    return {
      ok: false,
      reason: "invalid_branch_name",
      message: `Invalid startPoint ref: ${opts.startPoint}`,
    };
  }

  const create = opts.create === true;

  const cmd = await runGitCommand<{ created: boolean }>({
    cwd: opts.cwd,
    action: "checkout",
    timeoutMs: opts.timeoutMs,
    run: async (git) => {
      // Pre-flight: dirty tree refusal. Identical structure to runGitPull's
      // dirty-tree gate. Wrapped in a closure-thrown sentinel so the audit
      // row gets `reason='dirty_tree'` rather than `unknown`.
      const status = await git.status();
      if (!status.isClean()) {
        const n = status.files.length;
        throw Object.assign(new Error("dirty working tree"), {
          gitReason: "dirty_tree" as GitReason,
          message:
            `Working tree has uncommitted changes (${n} file${n === 1 ? "" : "s"}). ` +
            `Commit, stash, or discard them before switching branches.`,
        });
      }

      const args: string[] = ["checkout"];
      if (create) {
        args.push("-b", opts.branch);
        if (opts.startPoint !== undefined) args.push(opts.startPoint);
      } else {
        args.push(opts.branch);
      }
      await git.raw(args);
      return { created: create };
    },
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: JSON.stringify({
        branch: opts.branch,
        create,
        has_start_point: opts.startPoint !== undefined,
      }),
    },
  });

  if (cmd.ok && cmd.data) {
    return {
      ok: true,
      branch: opts.branch,
      created: cmd.data.created,
      reason: "ok",
    };
  }

  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    branch: opts.branch,
    reason: gitReasonToCheckoutReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

function gitReasonToCheckoutReason(
  reason: GitReason,
  stderr: string,
): GitCheckoutReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    case "dirty_tree":
      return "dirty_working_tree";
    default:
      if (/already exists/i.test(stderr)) return "branch_already_exists";
      if (
        /did not match any file\(s\) known to git/i.test(stderr) ||
        /pathspec.*did not match/i.test(stderr) ||
        /not a valid (branch|reference|object)/i.test(stderr) ||
        /no such ref/i.test(stderr)
      ) {
        return "branch_not_found";
      }
      return "unknown";
  }
}

// ─── runGitBranchDelete ────────────────────────────────────────────────────

export type GitBranchDeleteReason =
  | "ok"
  | "git_protected_branch"
  | "git_cannot_delete_current_branch"
  | "branch_not_found"
  | "not_fully_merged"
  | "invalid_branch_name"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitBranchDeleteOptions {
  cwd: string;
  branch: string;
  /** When true, use `git branch -D` (force-delete unmerged branches). */
  force?: boolean;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitBranchDeleteResult {
  ok: boolean;
  branch?: string;
  reason?: GitBranchDeleteReason;
  message?: string;
  stderr?: string;
}

/**
 * Branches that are refused outright unless `force=true` is explicitly set.
 * Mirrors `PROTECTED_BRANCHES` for `runGitPush` but applied here against the
 * delete surface — same rationale, same one-line-extension footprint.
 */
const PROTECTED_DELETE_BRANCHES: readonly string[] = ["main", "master"];

/**
 * Delete a local branch. Pre-flight refuses to touch `main` / `master`
 * unless force is set; the current-branch case is caught by git itself
 * (you cannot delete the branch HEAD points at) and surfaced here as a
 * structured `git_cannot_delete_current_branch` reason.
 *
 * Audit payload is `{ branch, force }` — operator needs to see which branch
 * was deleted and whether the force flag was used (the latter is the
 * "destructive" canary on retroactive review).
 */
export async function runGitBranchDelete(
  opts: RunGitBranchDeleteOptions,
): Promise<RunGitBranchDeleteResult> {
  if (!SERVICE_BRANCH_NAME_RE.test(opts.branch)) {
    return {
      ok: false,
      reason: "invalid_branch_name",
      message: `Invalid branch name: ${opts.branch}`,
    };
  }
  const force = opts.force === true;

  // Protected-branch refusal happens BEFORE runGitCommand so a
  // `force=false` against `main` produces no audit row at all — it never
  // reached git, it never could have reached git. The route layer still
  // returns 200 with the structured reason so the UI can render a hint.
  if (!force && PROTECTED_DELETE_BRANCHES.includes(opts.branch)) {
    return {
      ok: false,
      branch: opts.branch,
      reason: "git_protected_branch",
      message:
        `Refusing to delete protected branch '${opts.branch}'. ` +
        `Set force=true to override.`,
    };
  }

  const cmd = await runGitCommand<{ branch: string }>({
    cwd: opts.cwd,
    action: "branch_delete",
    timeoutMs: opts.timeoutMs,
    run: async (git) => {
      const flag = force ? "-D" : "-d";
      await git.raw(["branch", flag, opts.branch]);
      return { branch: opts.branch };
    },
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: JSON.stringify({ branch: opts.branch, force }),
    },
  });

  if (cmd.ok && cmd.data) {
    return { ok: true, branch: cmd.data.branch, reason: "ok" };
  }

  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    branch: opts.branch,
    reason: gitReasonToBranchDeleteReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

function gitReasonToBranchDeleteReason(
  reason: GitReason,
  stderr: string,
): GitBranchDeleteReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      if (
        // Older git: "Cannot delete the branch '<X>' which you are currently on."
        // Worktree-aware git: "cannot delete branch 'X' used by worktree at '/path'"
        // Other variants surface "checked out" or "currently checked out".
        /cannot delete (?:the )?branch.*(?:checked out|currently on|used by worktree)/i.test(
          stderr,
        )
      ) {
        return "git_cannot_delete_current_branch";
      }
      if (/branch.*not found/i.test(stderr) || /no such ref/i.test(stderr)) {
        return "branch_not_found";
      }
      if (/not fully merged/i.test(stderr)) return "not_fully_merged";
      return "unknown";
  }
}

// ─── runGitShow ───────────────────────────────────────────────────────────
//
// Read-only single-commit detail walk backing the commit-detail tab. Given a
// SHA, returns:
//   • commit metadata: { sha, parents, author, ts, message }
//   • a flat file list: [{ path, status, added, removed, oldPath? }]
//
// Implementation runs THREE fixed `git show` invocations through the shared
// `runGitCommand` envelope (so the audit-row write, wall-clock timeout and
// stderr classification stay in one place):
//
//   1. metadata pass:   git show -s --format=%H%n%P%n%an%n%ae%n%at%n%s <sha>
//        Six lines, in fixed order. `%s` is single-line subject — git
//        guarantees no embedded newline so the line index is stable.
//   2. name-status pass:  git show --name-status --pretty=format: -z <sha>
//        Status code (`M`/`A`/`D`/`R<percent>`/`C<percent>`) plus path(s),
//        NUL-terminated so paths with spaces / tabs / weird chars are safe.
//   3. numstat pass:     git show --numstat --pretty=format: -z <sha>
//        Per-file added/removed counts (`-` `-` for binary), NUL-terminated.
//
// The two file passes are merged on path identity (or {old,new} for
// renames / copies) into one row per file. We deliberately run them
// separately rather than mixing `--name-status --numstat` in one call —
// some git versions silently emit only the last `--name-*` flag, so the
// belt-and-braces of one-flag-per-call keeps the parser stable.
//
// The expensive call (`git show <sha>` with no `--no-patch`) is NEVER
// invoked here: per-file diffs are fetched lazily by the existing
// `/git-diff?base=<sha>~1&head=<sha>&path=<p>` endpoint as the user
// clicks files in the UI.
//
// Validation: `sha` MUST be a 7..64-char hex string — same regex
// `runGitLog` uses for cursors. Anything else is `bad_revision` upfront,
// before git is touched.
//
// Audit payload: `{ sha_prefix }` (first 12 chars, treated as opaque).
// We DO record the sha because — unlike a feature-branch name — a SHA
// is not a leakable in-flight name. The 12-char prefix is enough for
// forensic correlation without bloating the table on long-running
// daemons. No rev / path data leaks.

export interface GitShowFile {
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U";
  added: number;
  removed: number;
  /** Old path for `R`/`C` rows; absent otherwise. */
  oldPath?: string;
}

export interface GitShowCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Author timestamp as unix-epoch seconds (`%at`). */
  ts: number;
  /** Subject line (`%s`). One line; multi-line bodies are not surfaced. */
  message: string;
}

export type GitShowReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "timeout"
  | "unknown";

export interface RunGitShowOptions {
  /** Hex SHA (7..64 chars). Validated upfront. */
  sha: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitShowResult {
  ok: boolean;
  commit?: GitShowCommit;
  files?: GitShowFile[];
  reason?: GitShowReason;
  message?: string;
  stderr?: string;
}

/** Same hex-SHA regex `runGitLog` uses for the `cursor` field. */
const SHOW_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/**
 * Read one commit's metadata + file list. See section header for the
 * full contract. Returns a structured result; never throws.
 */
export async function runGitShow(
  cwd: string,
  opts: RunGitShowOptions,
): Promise<RunGitShowResult> {
  // 1. Validate inputs BEFORE we touch git. Bad SHA shape is
  //    `bad_revision` upfront with a message naming the offending field.
  if (typeof opts.sha !== "string" || !SHOW_SHA_RE.test(opts.sha)) {
    return {
      ok: false,
      reason: "bad_revision",
      message: "Invalid 'sha' — must be a 7..64-char hex string.",
    };
  }
  const sha = opts.sha;

  // Audit payload — sha prefix only. SHAs are not leakable in-flight
  // names (unlike branch names) but we still cap at 12 chars to keep
  // the table cheap on long-running daemons.
  const audit = {
    projectId:
      opts.projectId !== undefined ? String(opts.projectId) : undefined,
    workspaceId:
      opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
    argsJson: JSON.stringify({ sha_prefix: sha.slice(0, 12) }),
  };

  const cmd = await runGitCommand<{
    metaOut: string;
    nameStatusOut: string;
    numstatOut: string;
  }>({
    cwd,
    action: "show",
    timeoutMs: opts.timeoutMs,
    audit,
    run: async (git) => {
      // Six-line metadata in fixed order. `%s` is the single-line
      // subject so the line index is stable.
      const metaOut = await git.raw([
        "show",
        "-s",
        `--format=%H%n%P%n%an%n%ae%n%at%n%s`,
        "--end-of-options",
        sha,
      ]);

      // `--name-status` with rename / copy detection on (default).
      // `-z` makes the row separator NUL and the inner separator NUL,
      // which lets paths with spaces / tabs / newlines pass through
      // intact. Empty `--pretty=format:` suppresses the commit header
      // so the output is purely the diff index entries.
      const nameStatusOut = await git.raw([
        "show",
        "--name-status",
        "--pretty=format:",
        "-z",
        "--end-of-options",
        sha,
      ]);

      // `--numstat` for per-file added/removed (`-` `-` for binary).
      // `-z` is again the format that survives weird path chars.
      const numstatOut = await git.raw([
        "show",
        "--numstat",
        "--pretty=format:",
        "-z",
        "--end-of-options",
        sha,
      ]);

      return { metaOut, nameStatusOut, numstatOut };
    },
  });

  if (cmd.ok && cmd.data) {
    const commit = parseShowMeta(cmd.data.metaOut);
    if (!commit) {
      // Defensive — git emitted ok but the meta block was unparseable.
      // Treat as unknown rather than silently returning a half-shaped
      // commit row.
      return {
        ok: false,
        reason: "unknown",
        message: "Could not parse git show metadata block.",
      };
    }
    const files = mergeShowFiles(
      parseNameStatusZ(cmd.data.nameStatusOut),
      parseNumstatZ(cmd.data.numstatOut),
    );
    return { ok: true, commit, files, reason: "ok" };
  }

  // 2. Failure mapping — same belt-and-braces stderr-to-reason promotion
  //    `runGitDiff` / `runGitLog` use for ambiguous-ref text.
  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    reason: gitReasonToShowReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

/**
 * Parse the six-line metadata block git emits for the fixed `--format`
 * we send. Returns null when the output is empty or the timestamp line
 * is non-numeric (defensive — should never happen with a valid SHA).
 */
function parseShowMeta(out: string): GitShowCommit | null {
  if (!out) return null;
  // Trim trailing newline only — leading whitespace inside fields is
  // legal (e.g. an author name that starts with a space). We keep
  // intermediate lines verbatim.
  const trimmed = out.endsWith("\n") ? out.slice(0, -1) : out;
  const lines = trimmed.split("\n");
  if (lines.length < 6) return null;
  const sha = lines[0]!;
  const parentsRaw = lines[1]!;
  const author = lines[2]!;
  const email = lines[3]!;
  const tsRaw = lines[4]!;
  // The subject is line 5 — git's `%s` never embeds a newline so the
  // tail of the array beyond index 5 is empty. Defensive: if the format
  // ever changes, joining trailing lines preserves the message.
  const message = lines.slice(5).join("\n");
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return null;
  return {
    sha,
    parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
    author,
    email,
    ts,
    message,
  };
}

/**
 * Parse `git show --name-status -z` output. Each "row" is delimited by
 * a NUL byte; a `M`/`A`/`D` row has the shape `<code>\0<path>`, while a
 * rename/copy row has `<code>\0<oldPath>\0<newPath>`. The output ends
 * with a trailing NUL.
 *
 * NOTE: with `--pretty=format:` the commit header is empty but git
 * still emits a leading `\n` separator before the diff index entries
 * on some versions. We strip leading whitespace before tokenising.
 */
function parseNameStatusZ(
  out: string,
): Array<{
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U";
  path: string;
  oldPath?: string;
}> {
  const tokens = out.replace(/^\s+/, "").split("\0").filter((t) => t.length > 0);
  const rows: Array<{
    status: "M" | "A" | "D" | "R" | "C" | "T" | "U";
    path: string;
    oldPath?: string;
  }> = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++]!;
    const upper = code.charAt(0).toUpperCase();
    if (
      (upper === "R" || upper === "C") &&
      i + 1 < tokens.length
    ) {
      const oldPath = tokens[i++]!;
      const newPath = tokens[i++]!;
      rows.push({ status: upper as "R" | "C", path: newPath, oldPath });
      continue;
    }
    if (upper === "M" || upper === "A" || upper === "D" || upper === "T" || upper === "U") {
      if (i >= tokens.length) break;
      const path = tokens[i++]!;
      rows.push({ status: upper as "M" | "A" | "D" | "T" | "U", path });
      continue;
    }
    /* v8 ignore next 2 — unknown status code: skip the row's path token to stay aligned */
    if (i < tokens.length) i++;
  }
  return rows;
}

/**
 * Parse `git show --numstat -z` output. Format per row:
 *   `<added>\t<removed>\t<path>\0`             (regular)
 *   `<added>\t<removed>\t\0<oldPath>\0<newPath>\0`  (rename / copy)
 *
 * `<added>` / `<removed>` are `-` for binary files; we surface those as
 * `0` rather than `null` so the UI can render a single integer column.
 */
function parseNumstatZ(
  out: string,
): Array<{
  added: number;
  removed: number;
  path: string;
  oldPath?: string;
}> {
  // Strip a leading newline / whitespace the empty `--pretty=format:`
  // header sometimes emits before the first numstat row.
  const tokens = out.replace(/^\s+/, "").split("\0").filter((t) => t.length > 0);
  const rows: Array<{
    added: number;
    removed: number;
    path: string;
    oldPath?: string;
  }> = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++]!;
    // `head` shape:
    //   "<added>\t<removed>\t<path>"      → regular row, fully self-contained
    //   "<added>\t<removed>\t"            → rename/copy row, oldPath/newPath follow as separate NUL tokens
    const parts = head.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0]!, 10) || 0;
    const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1]!, 10) || 0;
    const inlinePath = parts.slice(2).join("\t");
    if (inlinePath.length > 0) {
      rows.push({ added, removed, path: inlinePath });
      continue;
    }
    if (i + 1 >= tokens.length) break;
    const oldPath = tokens[i++]!;
    const newPath = tokens[i++]!;
    rows.push({ added, removed, path: newPath, oldPath });
  }
  return rows;
}

/**
 * Merge name-status rows (which carry the M/A/D/R/C status enum) with
 * numstat rows (which carry the added/removed counts) on path identity.
 * For renames / copies we match on `newPath`; status wins over a
 * fallback `M` on count mismatch so the UI can render the rename arrow.
 */
function mergeShowFiles(
  statusRows: Array<{
    status: "M" | "A" | "D" | "R" | "C" | "T" | "U";
    path: string;
    oldPath?: string;
  }>,
  numstatRows: Array<{
    added: number;
    removed: number;
    path: string;
    oldPath?: string;
  }>,
): GitShowFile[] {
  const numByPath = new Map<string, { added: number; removed: number }>();
  for (const r of numstatRows) {
    numByPath.set(r.path, { added: r.added, removed: r.removed });
  }
  const out: GitShowFile[] = [];
  for (const s of statusRows) {
    const counts = numByPath.get(s.path) ?? { added: 0, removed: 0 };
    out.push({
      path: s.path,
      status: s.status,
      added: counts.added,
      removed: counts.removed,
      ...(s.oldPath ? { oldPath: s.oldPath } : {}),
    });
  }
  return out;
}

/**
 * Map the broader `GitReason` set to the show-relevant subset. Mutation-
 * class reasons collapse to `unknown`; bad-revision is recovered from
 * stderr text — same belt-and-braces pattern `gitReasonToDiffReason` uses.
 */
function gitReasonToShowReason(
  reason: GitReason,
  stderr: string,
): GitShowReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      if (
        /bad revision|unknown revision|ambiguous argument/i.test(stderr) ||
        /not a valid object name/i.test(stderr) ||
        /fatal: bad object/i.test(stderr)
      ) {
        return "bad_revision";
      }
      return "unknown";
  }
}

// ─── runGitStash{Push,List,Pop,Drop} ───────────────────────────────────────
//
// Working-tree-stash surface backing the source-control rail's "Stash"
// dropdown. Four helpers, one shared invariant set:
//
//   • runGitStashPush   — `git stash push [-u] [-m <message>]`. Captures
//                         dirty working tree onto the stack. `-u` includes
//                         untracked files (default `false`).
//   • runGitStashList   — `git stash list --format=…`. Read-only snapshot
//                         of the stash stack with one row per entry.
//   • runGitStashPop    — `git stash pop <ref>`. Apply + drop the named
//                         entry. Conflicts surface as `git_stash_pop_conflict`
//                         (stderr contains 'CONFLICT' OR exit code != 0).
//   • runGitStashDrop   — `git stash drop <ref>`. Forget a single entry.
//
// All four flow through `runGitCommand`, so the audit-row write, wall-clock
// timeout, and stderr classification stay in one place. Migration 0054
// widens the `git_audit_log.action` CHECK to admit the four new labels.
//
// **Ref grammar.** Pop / drop accept ONLY the canonical `stash@{N}` form
// (where `N` is a non-negative integer). Anything else — bare `0`, named
// stash, ref-with-space, etc. — is rejected upfront with `invalid_ref`.
// The grammar is defence-in-depth: simple-git invokes git via execFile (no
// shell), but pinning the regex here means no future refactor that introduces
// a `system(3)`-style call could smuggle metacharacters through the API.
//
// **Audit payloads.** Counts-only / structural-only — never the raw stash
// message body (which can carry feature-name intent the operator doesn't
// want in the forensic log). Push records `{ has_message, include_untracked }`;
// list `{}`; pop / drop `{ ref }` (the `stash@{N}` reflog selector itself
// carries no commercial intent).

/**
 * Conservative stash-ref grammar. Mirrors git's own canonical
 * `stash@{<N>}` reflog selector. We reject:
 *   - bare integers (`0` — ambiguous between SHA prefix and reflog index)
 *   - named entries (`stash@{foo}`)
 *   - leading whitespace / dashes
 *   - anything past the closing brace
 *
 * Pinning the integer at \d+ (no upper cap on length) is fine — git itself
 * caps the reflog at the configured `gc.reflogexpire` so an integer with
 * 100 digits will simply not match any entry and surface as `not_found`.
 */
const STASH_REF_RE = /^stash@\{\d+\}$/;

// ─── runGitStashPush ───────────────────────────────────────────────────────

export type GitStashPushReason =
  | "ok"
  | "nothing_to_stash"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitStashPushOptions {
  cwd: string;
  /**
   * Optional `-m <message>` body. Length-capped at the route layer
   * (`gitStashPushBodySchema`); the service trusts the caller's bound.
   * The audit payload records only `{ has_message: bool }` — never the
   * message text itself.
   */
  message?: string;
  /** Toggle `-u` (include untracked files in the stash). Default `false`. */
  includeUntracked?: boolean;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitStashPushResult {
  ok: boolean;
  /** True when git reported "No local changes to save" — exit 0, no stash created. */
  nothingToStash?: boolean;
  reason?: GitStashPushReason;
  message?: string;
  stderr?: string;
}

/**
 * Snapshot the working tree onto the stash stack via `git stash push`.
 *
 * Note that `git stash push` does NOT exit non-zero when there is nothing
 * to stash — it succeeds with stdout `No local changes to save`. We capture
 * stdout via `git.raw()`'s return value, detect the no-op message, and
 * surface it as `reason: "nothing_to_stash"` so the UI can render an
 * "already clean" hint instead of a fake "stashed" toast.
 */
export async function runGitStashPush(
  cwd: string,
  opts: {
    message?: string;
    includeUntracked?: boolean;
    projectId?: number | string;
    workspaceId?: number | string;
    timeoutMs?: number;
  } = {},
): Promise<RunGitStashPushResult> {
  const includeUntracked = opts.includeUntracked === true;
  const hasMessage = typeof opts.message === "string" && opts.message.length > 0;

  const cmd = await runGitCommand<{ stdout: string }>({
    cwd,
    action: "stash_push",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      // Counts/structural only: never the message body. See section header.
      argsJson: JSON.stringify({
        has_message: hasMessage,
        include_untracked: includeUntracked,
      }),
    },
    run: async (git) => {
      // Argv form, no shell. The canonical invocation is:
      //   git stash push [-u] [-m <message>]
      const args: string[] = ["stash", "push"];
      if (includeUntracked) args.push("-u");
      if (hasMessage) {
        args.push("-m", opts.message as string);
      }
      const stdout = await git.raw(args);
      return { stdout: stdout ?? "" };
    },
  });

  if (cmd.ok && cmd.data) {
    // git stash push exits 0 even when there's nothing to stash. Detect
    // the no-op via the well-known stdout message so the UI can distinguish.
    if (/No local changes to save/i.test(cmd.data.stdout)) {
      return { ok: true, nothingToStash: true, reason: "nothing_to_stash" };
    }
    return { ok: true, nothingToStash: false, reason: "ok" };
  }

  return {
    ok: false,
    reason: gitReasonToStashPushReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

function gitReasonToStashPushReason(reason: GitReason): GitStashPushReason {
  switch (reason) {
    case "ok":
    case "not_a_repo":
    case "path_missing":
    case "timeout":
      return reason;
    default:
      return "unknown";
  }
}

// ─── runGitStashList ───────────────────────────────────────────────────────

export type GitStashListReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface GitStashEntry {
  /** `stash@{N}` reflog selector — stable for as long as the entry exists. */
  ref: string;
  /** Commit hash of the stash tip. */
  hash: string;
  /** Committer date in ISO 8601 / RFC 3339 form (`%cI`). */
  date: string;
  /** Stash subject — git's auto-generated `WIP on <branch>: …` or the `-m` body. */
  message: string;
}

export interface RunGitStashListResult {
  ok: boolean;
  stashes?: GitStashEntry[];
  reason?: GitStashListReason;
  message?: string;
  stderr?: string;
}

/**
 * Field separator for `git stash list --format=…`. `\x1f` (ASCII Unit
 * Separator) is non-printable, never appears in a sane stash message, and
 * is not whitespace, so a `split(SEP)` produces deterministic field
 * boundaries even if a stash subject contains pipes / commas / tabs the
 * operator typed on purpose.
 *
 * Field order: `ref \x1f hash \x1f date \x1f message`.
 *
 * `%gd` is git's reflog-selector token (e.g. `stash@{0}`); `%H` the full
 * commit hash; `%cI` the committer date in ISO-8601-with-offset; `%gs` the
 * reflog subject (the human-meaningful "WIP on <branch>: …" line).
 */
const STASH_LIST_FIELD_SEP = "\x1f";
const STASH_LIST_FORMAT = `--format=%gd${STASH_LIST_FIELD_SEP}%H${STASH_LIST_FIELD_SEP}%cI${STASH_LIST_FIELD_SEP}%gs`;

/**
 * Enumerate the stash stack via `git stash list --format=…`. Empty stack
 * is `{ ok: true, stashes: [] }` — NOT an error.
 *
 * Audit payload is `{}` — list invocations have no operator-meaningful
 * arguments, and the action label alone tells you which surface fired.
 */
export async function runGitStashList(
  cwd: string,
  opts: {
    projectId?: number | string;
    workspaceId?: number | string;
    timeoutMs?: number;
  } = {},
): Promise<RunGitStashListResult> {
  const cmd = await runGitCommand<{ stdout: string }>({
    cwd,
    action: "stash_list",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: "{}",
    },
    run: async (git) => {
      const stdout = await git.raw(["stash", "list", STASH_LIST_FORMAT]);
      return { stdout: stdout ?? "" };
    },
  });

  if (cmd.ok && cmd.data) {
    return { ok: true, stashes: parseStashListOutput(cmd.data.stdout), reason: "ok" };
  }

  return {
    ok: false,
    reason: gitReasonToStashListReason(cmd.reason),
    message: cmd.message,
    stderr: cmd.stderr,
  };
}

/**
 * Parse the four-column `\x1f`-separated rows from `git stash list`:
 *   ref \x1f hash \x1f date \x1f message
 *
 * Empty stdout (no stash entries) returns `[]`.
 */
function parseStashListOutput(stdout: string): GitStashEntry[] {
  const out: GitStashEntry[] = [];
  if (!stdout.trim()) return out;
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    const parts = rawLine.split(STASH_LIST_FIELD_SEP);
    /* v8 ignore next 3 — defensive: the format string emits exactly 4 fields
       per row; a short row would indicate a git binary regression. */
    if (parts.length < 4) continue;
    const [ref, hash, date, ...msgParts] = parts;
    if (!ref || !hash) continue;
    out.push({
      ref,
      hash,
      date: date ?? "",
      message: msgParts.join(STASH_LIST_FIELD_SEP),
    });
  }
  return out;
}

function gitReasonToStashListReason(reason: GitReason): GitStashListReason {
  switch (reason) {
    case "ok":
    case "not_a_repo":
    case "path_missing":
    case "timeout":
      return reason;
    default:
      return "unknown";
  }
}

// ─── runGitStashPop ────────────────────────────────────────────────────────

export type GitStashPopReason =
  | "ok"
  | "git_stash_pop_conflict"
  | "invalid_ref"
  | "not_found"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitStashPopOptions {
  cwd: string;
  /** Canonical `stash@{N}` reflog selector. Validated against `STASH_REF_RE`. */
  ref: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitStashPopResult {
  ok: boolean;
  ref?: string;
  reason?: GitStashPopReason;
  message?: string;
  stderr?: string;
}

/**
 * Apply + drop the named stash entry via `git stash pop <ref>`. Conflict
 * detection per the slice spec: stderr contains 'CONFLICT' OR exit code
 * != 0 → `git_stash_pop_conflict`. The ONE exception is the well-known
 * "no stash entries" / "is not a valid reference" failure, which surfaces
 * as `not_found` instead — telling the operator "you popped a ghost ref"
 * is more actionable than calling it a conflict.
 *
 * On a true conflict, git keeps the stash on the stack (the operator can
 * resolve, then `git stash drop` the entry). We surface the structured
 * reason but DO NOT auto-cleanup — letting the operator drive the
 * resolution avoids the destructive-action surprise pattern.
 *
 * Audit payload is `{ ref }` — the `stash@{N}` reflog selector carries no
 * commercial intent; the actual stash content is not in the payload.
 */
export async function runGitStashPop(
  opts: RunGitStashPopOptions,
): Promise<RunGitStashPopResult> {
  if (!STASH_REF_RE.test(opts.ref)) {
    return {
      ok: false,
      ref: opts.ref,
      reason: "invalid_ref",
      message: `Invalid stash ref: ${opts.ref}. Expected canonical 'stash@{N}' form.`,
    };
  }

  const cmd = await runGitCommand<{ stdout: string }>({
    cwd: opts.cwd,
    action: "stash_pop",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: JSON.stringify({ ref: opts.ref }),
    },
    run: async (git) => {
      // The conflict case is a non-zero exit — simple-git's `raw()` will
      // throw and the catch path in `runGitCommand` will classify it. The
      // success case includes the apply summary in stdout; we discard it
      // (the stash state is what the UI re-fetches via stash_list).
      const stdout = await git.raw(["stash", "pop", opts.ref]);
      return { stdout: stdout ?? "" };
    },
  });

  if (cmd.ok && cmd.data) {
    return { ok: true, ref: opts.ref, reason: "ok" };
  }

  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    ref: opts.ref,
    reason: gitReasonToStashPopReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

function gitReasonToStashPopReason(
  reason: GitReason,
  stderr: string,
): GitStashPopReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      // not_found wins over conflict: a missing entry is more actionable
      // than a generic "conflict" label. Match git's known shapes:
      //   - "No stash entries found." (empty stack)
      //   - "fatal: log for 'refs/stash' only has N entries" (out-of-range)
      //   - "<ref> is not a valid reference" (bad ref form past our regex)
      //   - "<ref> is not a stash-like commit" (ref points at non-stash)
      if (
        /no stash entries/i.test(stderr) ||
        /log for '(?:refs\/)?stash' only has \d+ entries/i.test(stderr) ||
        /is not a valid reference/i.test(stderr) ||
        /is not a stash-like commit/i.test(stderr)
      ) {
        return "not_found";
      }
      // Per slice spec: stderr contains 'CONFLICT' OR exit code != 0
      // (which is what got us into the default branch) → conflict. Note
      // that simple-git's raw() throws on any non-zero exit, so by the
      // time we're in the default branch, the exit code IS != 0.
      return "git_stash_pop_conflict";
  }
}

// ─── runGitStashDrop ───────────────────────────────────────────────────────

export type GitStashDropReason =
  | "ok"
  | "invalid_ref"
  | "not_found"
  | "not_a_repo"
  | "path_missing"
  | "timeout"
  | "unknown";

export interface RunGitStashDropOptions {
  cwd: string;
  /** Canonical `stash@{N}` reflog selector. */
  ref: string;
  projectId?: number | string;
  workspaceId?: number | string;
  timeoutMs?: number;
}

export interface RunGitStashDropResult {
  ok: boolean;
  ref?: string;
  reason?: GitStashDropReason;
  message?: string;
  stderr?: string;
}

/**
 * Forget a single stash entry via `git stash drop <ref>`. Refusal to drop
 * a non-existent entry surfaces as `not_found`; the catch-all classifier
 * collapses everything else to `unknown`. There is no "conflict" branch
 * here — drop is a metadata operation that cannot generate working-tree
 * conflicts (unlike pop which APPLIES the stash before removing it).
 *
 * Audit payload is `{ ref }` — same rationale as runGitStashPop.
 */
export async function runGitStashDrop(
  opts: RunGitStashDropOptions,
): Promise<RunGitStashDropResult> {
  if (!STASH_REF_RE.test(opts.ref)) {
    return {
      ok: false,
      ref: opts.ref,
      reason: "invalid_ref",
      message: `Invalid stash ref: ${opts.ref}. Expected canonical 'stash@{N}' form.`,
    };
  }

  const cmd = await runGitCommand<{ ref: string }>({
    cwd: opts.cwd,
    action: "stash_drop",
    timeoutMs: opts.timeoutMs,
    audit: {
      projectId: opts.projectId !== undefined ? String(opts.projectId) : undefined,
      workspaceId:
        opts.workspaceId !== undefined ? String(opts.workspaceId) : undefined,
      argsJson: JSON.stringify({ ref: opts.ref }),
    },
    run: async (git) => {
      await git.raw(["stash", "drop", opts.ref]);
      return { ref: opts.ref };
    },
  });

  if (cmd.ok && cmd.data) {
    return { ok: true, ref: cmd.data.ref, reason: "ok" };
  }

  const stderr = cmd.stderr ?? "";
  return {
    ok: false,
    ref: opts.ref,
    reason: gitReasonToStashDropReason(cmd.reason, stderr),
    message: cmd.message,
    stderr,
  };
}

function gitReasonToStashDropReason(
  reason: GitReason,
  stderr: string,
): GitStashDropReason {
  switch (reason) {
    case "ok":
      return "ok";
    case "not_a_repo":
      return "not_a_repo";
    case "path_missing":
      return "path_missing";
    case "timeout":
      return "timeout";
    default:
      if (
        /no stash entries/i.test(stderr) ||
        /log for '(?:refs\/)?stash' only has \d+ entries/i.test(stderr) ||
        /is not a valid reference/i.test(stderr) ||
        /is not a stash-like commit/i.test(stderr)
      ) {
        return "not_found";
      }
      return "unknown";
  }
}
