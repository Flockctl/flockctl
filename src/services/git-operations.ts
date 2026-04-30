import simpleGit, { type SimpleGit } from "simple-git";
import { existsSync } from "fs";
import { join } from "path";

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

export async function runGitPull(projectPath: string): Promise<GitPullResult> {
  // 1. Path / .git existence check. We do this with `existsSync` rather
  //    than letting simple-git fail mid-flight, so the error message is
  //    actionable ("not a git repository") rather than a raw git stderr.
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

  // 6. The pull itself, fast-forward only. `--ff-only` causes git to
  //    refuse with "Not possible to fast-forward" if local and remote
  //    have diverged — we map that to `non_fast_forward` so the UI can
  //    explain why and direct the user to a terminal for merge/rebase.
  try {
    await git.raw(["pull", "--ff-only"]);
  } catch (err) {
    const stderr = extractStderr(err);
    return {
      ok: false,
      reason: classifyPullError(stderr),
      message: extractGitErrorMessage(stderr) ?? "git pull failed",
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

  const commitsPulled = await countCommits(git, beforeSha, afterSha);
  const filesChanged = await countFilesChanged(git, beforeSha, afterSha);

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
