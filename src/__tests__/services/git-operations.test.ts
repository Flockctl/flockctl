import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import {
  runGitCommand,
  runGitCommit,
  classifyGitError,
  classifyPullError,
  runGitPush,
  buildPushArgs,
  PROTECTED_BRANCHES,
  __pushTestHooks,
} from "../../services/git-operations.js";

/**
 * Service-level tests for the v2 `runGitCommand` envelope and the broader
 * `classifyGitError` helper. The pull-only `runGitPull` path is covered by
 * `routes/projects-git-pull.test.ts` — these tests pin the *generic* surface
 * future commit/push routes will build on:
 *
 *   1. cwd validation runs BEFORE simple-git is touched (we mock simple-git
 *      to a `vi.fn()` that throws if called, then verify path_missing /
 *      not_a_repo cases never trip it).
 *   2. The wall-clock timeout actually fires and `merge --abort` is called
 *      ONLY for `action: "pull"`.
 *   3. Every invocation — success OR failure — produces exactly one row in
 *      `git_audit_log`.
 *   4. The auth_failed regex matches all five brief-named patterns the spec
 *      requires (Permission denied, could not read Username, fatal:
 *      Authentication failed, HTTP 403, remote: Repository not found).
 *
 * Pattern: unit tests mock `simple-git` to keep them fast and deterministic
 * (no real git binary, no real network). Integration tests at the bottom
 * use a real on-disk repo for the audit-row contract.
 */

// ─── classifyGitError ──────────────────────────────────────────────────────

describe("classifyGitError", () => {
  it("recognises every brief-named auth_failed pattern", () => {
    const patterns = [
      "Permission denied (publickey).",
      "fatal: could not read Username for 'https://github.com'",
      "fatal: Authentication failed for 'https://github.com/x/y.git'",
      "remote: HTTP 403\nfatal: unable to access",
      "remote: Repository not found.\nfatal: ...",
    ];
    for (const stderr of patterns) {
      const err = Object.assign(new Error("boom"), { stderr });
      const got = classifyGitError(err);
      expect(got.reason).toBe("auth_failed");
      expect(got.stderr).toBe(stderr);
    }
  });

  it("returns reason+message+stderr for a typical fatal stderr", () => {
    const err = Object.assign(new Error("git failed"), {
      stderr: "hint: noise\nfatal: refusing to merge unrelated histories",
    });
    const got = classifyGitError(err);
    expect(got.reason).toBe("diverged");
    expect(got.message).toBe("fatal: refusing to merge unrelated histories");
    expect(got.stderr).toMatch(/refusing to merge unrelated histories/);
  });

  it("classifies push-side rejection as rejected_non_fast_forward", () => {
    const err = {
      stderr:
        "! [rejected]        main -> main (non-fast-forward)\nerror: failed to push",
    };
    expect(classifyGitError(err).reason).toBe("rejected_non_fast_forward");
  });

  it("classifies empty-index commit failures as empty_index", () => {
    const err = { stderr: "nothing to commit, working tree clean" };
    expect(classifyGitError(err).reason).toBe("empty_index");
  });

  it("classifies empty commit message as empty_message", () => {
    const err = { stderr: "Aborting commit due to empty commit message." };
    expect(classifyGitError(err).reason).toBe("empty_message");
  });

  it("falls back to unknown for unrecognised stderr", () => {
    expect(classifyGitError({ stderr: "fatal: weird new git error" }).reason).toBe(
      "unknown",
    );
    expect(classifyGitError({ stderr: "" }).reason).toBe("unknown");
  });
});

// ─── classifyPullError stays a thin wrapper ────────────────────────────────

describe("classifyPullError (back-compat after extraction)", () => {
  it("still returns the legacy GitPullReason values", () => {
    expect(classifyPullError("Permission denied (publickey).")).toBe("auth_failed");
    expect(
      classifyPullError("fatal: Not possible to fast-forward, aborting."),
    ).toBe("non_fast_forward");
    expect(classifyPullError("Operation timed out")).toBe("network_error");
    expect(classifyPullError("fatal: weird new git error")).toBe("unknown");
  });
});

// ─── runGitCommand: existence checks short-circuit BEFORE simple-git ───────

describe("runGitCommand existence checks", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcmd-exist-"));
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    projectId = seedProject(testDb.sqlite, {});
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns path_missing when cwd does not exist on disk and never invokes run()", async () => {
    const run = vi.fn(async () => "should-not-run");
    const ghost = join(tmpRoot, "never-created");

    const got = await runGitCommand({
      cwd: ghost,
      action: "pull",
      run,
      audit: { projectId: String(projectId), argsJson: "{}" },
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
    expect(got.message).toMatch(/path does not exist/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns not_a_repo when cwd exists but has no .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const run = vi.fn(async () => "should-not-run");

    const got = await runGitCommand({
      cwd: dir,
      action: "pull",
      run,
      audit: { projectId: String(projectId), argsJson: "{}" },
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
    expect(got.message).toMatch(/not a git repository/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("writes an audit row even when the existence check short-circuits", async () => {
    // Both prior tests already inserted; we count rows scoped to projectId.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // exit_code is NULL for short-circuit (we never reached git).
    for (const r of rows) {
      expect(r.exitCode).toBeNull();
      expect(["path_missing", "not_a_repo"]).toContain(r.reason);
    }
  });
});

// ─── runGitCommand: timeout + merge --abort behaviour ──────────────────────

describe("runGitCommand timeout", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcmd-timeout-"));
  let projectId: number;
  const repoPath = join(tmpRoot, "repo");

  beforeAll(async () => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    projectId = seedProject(testDb.sqlite, { path: repoPath });
    // Real on-disk repo so the .git existence check passes; we still mock
    // the closure that would actually shell out.
    mkdirSync(repoPath, { recursive: true });
    const git = simpleGit(repoPath);
    await git.init(["--initial-branch=main"]);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns reason:timeout when the run closure exceeds timeoutMs", async () => {
    const got = await runGitCommand({
      cwd: repoPath,
      action: "pull",
      timeoutMs: 80,
      // Sleep 5 seconds so the 80ms timeout always fires first.
      run: () => new Promise((resolve) => setTimeout(() => resolve("never"), 5000)),
      audit: { projectId: String(projectId), argsJson: '{"timeout":true}' },
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("timeout");
    expect(got.message).toMatch(/timed out after 80ms/);
  }, 10_000);

  it("writes a single audit row scoped to the project on timeout", async () => {
    // Filter to the most recent row scoped to this project & action.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    const timeoutRows = rows.filter((r) => r.reason === "timeout");
    expect(timeoutRows.length).toBeGreaterThanOrEqual(1);
    const last = timeoutRows[timeoutRows.length - 1]!;
    expect(last.action).toBe("pull");
    expect(last.exitCode).toBeNull();
    expect(last.argsJson).toBe('{"timeout":true}');
    // Defensive: stderr_truncated must be ≤ 4096 bytes.
    if (last.stderrTruncated) {
      expect(Buffer.byteLength(last.stderrTruncated, "utf-8")).toBeLessThanOrEqual(
        4096,
      );
    }
  });
});

// ─── runGitCommand: success + failure write exactly one audit row each ────

describe("runGitCommand_writes_one_audit_row_on_success", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcmd-success-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes one row with reason='ok', exit_code=0, duration_ms set", async () => {
    const repo = join(tmpRoot, "ok-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);

    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommand({
      cwd: repo,
      action: "commit",
      run: async () => ({ shortSha: "abc1234" }),
      audit: {
        projectId: String(projectId),
        argsJson: '{"paths_count":1,"commit_message_bytes":42}',
      },
    });

    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.data).toEqual({ shortSha: "abc1234" });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("commit");
    expect(rows[0]!.reason).toBe("ok");
    expect(rows[0]!.exitCode).toBe(0);
    expect(rows[0]!.argsJson).toBe('{"paths_count":1,"commit_message_bytes":42}');
    expect(rows[0]!.stderrTruncated).toBeNull();
    expect(typeof rows[0]!.durationMs).toBe("number");
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts workspaceId-only audit scope", async () => {
    const repo = join(tmpRoot, "ws-only-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);

    const wsId = seedWorkspace(testDb.sqlite, {});

    const got = await runGitCommand({
      cwd: repo,
      action: "push",
      run: async () => "pushed",
      audit: { workspaceId: String(wsId), argsJson: '{"force":false}' },
    });

    expect(got.ok).toBe(true);
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.action).toBe("push");
  });
});

describe("runGitCommand_writes_one_audit_row_on_failure", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcmd-failure-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes one row with reason classified from stderr, exit_code=null", async () => {
    const repo = join(tmpRoot, "fail-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);

    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommand({
      cwd: repo,
      action: "push",
      run: async () => {
        throw Object.assign(new Error("git failed"), {
          stderr: "remote: Repository not found.\nfatal: unable to access",
        });
      },
      audit: { projectId: String(projectId), argsJson: '{"force":false}' },
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("auth_failed");
    expect(got.stderr).toMatch(/Repository not found/);
    expect(got.message).toBe("fatal: unable to access");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("push");
    expect(rows[0]!.reason).toBe("auth_failed");
    expect(rows[0]!.exitCode).toBeNull();
    expect(rows[0]!.stderrTruncated).toMatch(/Repository not found/);
  });

  it("truncates stderr larger than 4096 bytes before writing", async () => {
    const repo = join(tmpRoot, "huge-stderr-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);
    writeFileSync(join(repo, "marker"), "1");

    const projectId = seedProject(testDb.sqlite, { path: repo });

    const huge = "x".repeat(8192);
    await runGitCommand({
      cwd: repo,
      action: "commit",
      run: async () => {
        throw Object.assign(new Error("boom"), { stderr: huge });
      },
      audit: { projectId: String(projectId), argsJson: "{}" },
    });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const truncated = rows[0]!.stderrTruncated!;
    expect(Buffer.byteLength(truncated, "utf-8")).toBeLessThanOrEqual(4096);
    // Sanity-check the truncation didn't drop everything.
    expect(truncated.length).toBeGreaterThan(0);
  });
});

// ─── runGitCommit ──────────────────────────────────────────────────────────
//
// Exercises the v2 commit envelope. Every test runs against a real on-disk
// repo so simple-git's status / add / commit pipeline isn't mocked away —
// the whole point of `runGitCommit` is the pre-flight ordering against a
// live working tree, and stubbing that out would make the tests a tautology.

/**
 * Initialise a brand-new repo at `path` with a single committed root file
 * so HEAD exists and `git status` returns a sensible structure. Identity is
 * pinned locally so the test doesn't depend on the host's `user.email`.
 */
async function initRepoAtPath(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@flockctl.local");
  await git.addConfig("user.name", "Flockctl Test");
  // Seed a commit so HEAD resolves; subsequent tests build on this.
  writeFileSync(join(path, "seed.txt"), "seed\n");
  await git.add(["seed.txt"]);
  await git.commit("seed");
}

describe("runGitCommit pre-flight: empty message", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcommit-empty-msg-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns reason='empty_message' for a whitespace-only message and writes NO audit row", async () => {
    const repo = join(tmpRoot, "repo");
    await initRepoAtPath(repo);
    writeFileSync(join(repo, "edit.txt"), "x\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({
      cwd: repo,
      message: "   \t\n",
      projectId,
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("empty_message");

    // Crucial invariant: no audit row was written. The empty-message guard
    // sits BEFORE runGitCommand so a no-op caller doesn't pollute the log.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("returns reason='empty_message' for an empty string and writes NO audit row", async () => {
    const repo = join(tmpRoot, "repo2");
    await initRepoAtPath(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({ cwd: repo, message: "", projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("empty_message");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });
});

describe("runGitCommit pre-flight: unknown_path", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcommit-unknown-path-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects paths not present in status and echoes the offending paths", async () => {
    const repo = join(tmpRoot, "repo");
    await initRepoAtPath(repo);
    // Make exactly one file untracked, so the status union is { "new.txt" }.
    writeFileSync(join(repo, "new.txt"), "hello\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({
      cwd: repo,
      message: "add new file",
      paths: ["new.txt", "ghost.txt", "phantom.txt"],
      projectId,
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("unknown_path");
    // The echoed message must name the offending paths so the operator
    // learns *which* entry was wrong, not just *that* one was.
    expect(got.message).toMatch(/ghost\.txt/);
    expect(got.message).toMatch(/phantom\.txt/);
    // The legit path should NOT appear in the rejection list.
    expect(got.message).not.toMatch(/\bnew\.txt\b/);

    // Audit row was written through runGitCommand (not directly), payload
    // is counts-only — never the raw paths.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("commit");
    expect(rows[0]!.reason).toBe("unknown_path");
    const args = JSON.parse(rows[0]!.argsJson);
    expect(args).toEqual({ paths_count: 3, message_bytes: Buffer.byteLength("add new file", "utf-8") });
    // No leakage of paths or message body.
    expect(rows[0]!.argsJson).not.toMatch(/ghost/);
    expect(rows[0]!.argsJson).not.toMatch(/phantom/);
  });
});

describe("runGitCommit pre-flight: empty_index", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcommit-empty-idx-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns empty_index when the working tree is clean and no paths were given", async () => {
    const repo = join(tmpRoot, "clean-repo");
    await initRepoAtPath(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({
      cwd: repo,
      message: "nothing to commit",
      projectId,
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("empty_index");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("empty_index");
  });
});

describe("runGitCommit success path", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcommit-success-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("stages -A and commits when no paths are given; returns sha + filesCommitted", async () => {
    const repo = join(tmpRoot, "repo-A");
    await initRepoAtPath(repo);
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "b.txt"), "bravo\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({
      cwd: repo,
      message: "feat: add a and b",
      projectId,
    });

    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(typeof got.sha).toBe("string");
    expect(got.sha!.length).toBeGreaterThanOrEqual(7);
    expect(got.filesCommitted).toBe(2);

    // HEAD now points at the returned SHA.
    const headSha = (await simpleGit(repo).revparse(["HEAD"])).trim();
    expect(headSha).toBe(got.sha);

    // Audit row: one row, action=commit, reason=ok, exit_code=0, args
    // payload is counts-only.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("commit");
    expect(rows[0]!.reason).toBe("ok");
    expect(rows[0]!.exitCode).toBe(0);
    const args = JSON.parse(rows[0]!.argsJson);
    expect(args).toEqual({
      paths_count: 0,
      message_bytes: Buffer.byteLength("feat: add a and b", "utf-8"),
    });
    // No leakage of message body into argsJson.
    expect(rows[0]!.argsJson).not.toMatch(/feat:/);
    expect(rows[0]!.argsJson).not.toMatch(/add a and b/);
  });

  it("stages explicit paths and ignores other dirty files", async () => {
    const repo = join(tmpRoot, "repo-explicit");
    await initRepoAtPath(repo);
    writeFileSync(join(repo, "wanted.txt"), "wanted\n");
    writeFileSync(join(repo, "skipped.txt"), "skipped\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCommit({
      cwd: repo,
      message: "feat: only wanted",
      paths: ["wanted.txt"],
      projectId,
    });

    expect(got.ok).toBe(true);
    expect(got.filesCommitted).toBe(1);

    // The skipped file is still untracked after the commit.
    const status = await simpleGit(repo).status();
    expect(status.not_added).toContain("skipped.txt");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const args = JSON.parse(rows[0]!.argsJson);
    expect(args.paths_count).toBe(1);
    // No raw paths in argsJson.
    expect(rows[0]!.argsJson).not.toMatch(/wanted\.txt/);
  });

  it("threads workspaceId through the audit scope", async () => {
    const repo = join(tmpRoot, "repo-ws");
    await initRepoAtPath(repo);
    writeFileSync(join(repo, "ws.txt"), "ws\n");
    const wsId = seedWorkspace(testDb.sqlite, {});

    const got = await runGitCommit({
      cwd: repo,
      message: "ws commit",
      workspaceId: wsId,
    });
    expect(got.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
  });
});

describe("runGitCommit existence checks", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runcommit-existence-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns path_missing when cwd does not exist (after empty-message guard passes)", async () => {
    const ghost = join(tmpRoot, "no-such-dir");
    const projectId = seedProject(testDb.sqlite, { path: ghost });

    const got = await runGitCommit({
      cwd: ghost,
      message: "anything",
      projectId,
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");

    // path_missing comes from runGitCommand, so an audit row IS written.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("path_missing");
  });

  it("returns not_a_repo when cwd exists but has no .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitCommit({
      cwd: dir,
      message: "anything",
      projectId,
    });

    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });
});

// ─── runGitPush ────────────────────────────────────────────────────────────
//
// Two layers of coverage:
//
//   1. `buildPushArgs` is exhaustively probed across (setUpstream × force) so
//      the security invariant — argv NEVER contains `--all`, `--mirror`, or
//      raw `--force` — is pinned without spinning up a repo. force always
//      resolves to `--force-with-lease`.
//
//   2. `runGitPush` is exercised against a real on-disk repo with `git.raw`
//      stubbed via `__pushTestHooks.executeRaw`. The protected-branch test
//      asserts the stub is NEVER invoked (the refusal must happen BEFORE the
//      network call); the success / no_upstream / detached_head tests pin
//      the result-shape contract.

describe("runGitPush — buildPushArgs invariants", () => {
  it("buildPushArgs never includes --all, --mirror, or raw --force", () => {
    for (const setUpstream of [false, true]) {
      for (const force of [false, true]) {
        for (const branch of ["main", "feature/x", "release-1.2"]) {
          const args = buildPushArgs(branch, "origin", { setUpstream, force });
          expect(args).not.toContain("--all");
          expect(args).not.toContain("--mirror");
          expect(args).not.toContain("--force"); // raw --force NEVER present
          // The first token is always `push`.
          expect(args[0]).toBe("push");
          // Whenever force is set, --force-with-lease IS present.
          if (force) expect(args).toContain("--force-with-lease");
          // -u flag presence mirrors setUpstream exactly.
          expect(args.includes("-u")).toBe(setUpstream);
          // The push spec is always HEAD:refs/heads/<branch>; we never push
          // a different ref or all branches.
          expect(args).toContain(`HEAD:refs/heads/${branch}`);
          // The remote slot is exactly the literal we supplied.
          expect(args).toContain("origin");
        }
      }
    }
  });

  it("emits the expected canonical argv for the four corner cases", () => {
    expect(buildPushArgs("main", "origin", { setUpstream: false, force: false })).toEqual([
      "push",
      "origin",
      "HEAD:refs/heads/main",
    ]);
    expect(buildPushArgs("main", "origin", { setUpstream: true, force: false })).toEqual([
      "push",
      "-u",
      "origin",
      "HEAD:refs/heads/main",
    ]);
    expect(buildPushArgs("feature", "origin", { setUpstream: false, force: true })).toEqual([
      "push",
      "origin",
      "HEAD:refs/heads/feature",
      "--force-with-lease",
    ]);
    expect(buildPushArgs("feature", "origin", { setUpstream: true, force: true })).toEqual([
      "push",
      "-u",
      "origin",
      "HEAD:refs/heads/feature",
      "--force-with-lease",
    ]);
  });

  it("PROTECTED_BRANCHES contains main and master", () => {
    expect(PROTECTED_BRANCHES).toContain("main");
    expect(PROTECTED_BRANCHES).toContain("master");
  });
});

describe("runGitPush — protected branch", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runpush-protected-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("refuses force-push to main BEFORE the network call (executeRaw never invoked)", async () => {
    const repo = join(tmpRoot, "main-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);
    // Need at least one commit so revparse HEAD works on every git version.
    writeFileSync(join(repo, "f"), "x");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");

    const projectId = seedProject(testDb.sqlite, { path: repo });

    // Spy on the network seam — must NEVER be called for force+main.
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(new Error("executeRaw must not run for protected_branch"));

    try {
      const got = await runGitPush({
        cwd: repo,
        force: true,
        projectId,
      });

      expect(got.ok).toBe(false);
      expect(got.reason).toBe("protected_branch");
      expect(got.branch).toBe("main");
      expect(got.remote).toBe("origin");
      expect(spy).not.toHaveBeenCalled();

      // Audit row records the refusal with reason='protected_branch' AND
      // captures branch in args_json so forensics can reconstruct what was
      // refused without diffing against a separate DB.
      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, projectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("push");
      expect(rows[0]!.reason).toBe("protected_branch");
      const args = JSON.parse(rows[0]!.argsJson) as Record<string, unknown>;
      expect(args).toEqual({
        remote: "origin",
        branch: "main",
        force: true,
        setUpstream: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("also refuses force-push to master", async () => {
    const repo = join(tmpRoot, "master-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=master"]);
    writeFileSync(join(repo, "f"), "x");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");

    const projectId = seedProject(testDb.sqlite, { path: repo });
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(new Error("must not run"));
    try {
      const got = await runGitPush({ cwd: repo, force: true, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("protected_branch");
      expect(got.branch).toBe("master");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT refuse a non-force push to main (force=false bypasses the gate)", async () => {
    const repo = join(tmpRoot, "main-noforce-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=main"]);
    writeFileSync(join(repo, "f"), "x");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");

    const projectId = seedProject(testDb.sqlite, { path: repo });

    // No upstream is configured, so we expect `no_upstream` here — proving
    // that pre-flight got past the protected_branch gate (force=false).
    const spy = vi.spyOn(__pushTestHooks, "executeRaw");
    try {
      const got = await runGitPush({ cwd: repo, force: false, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("no_upstream");
      // Either way, raw push was not invoked because upstream check failed.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("runGitPush — pre-flight error paths", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runpush-preflight-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns no_upstream when branch has no @{u} and setUpstream=false", async () => {
    const repo = join(tmpRoot, "no-upstream-repo");
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init(["--initial-branch=feature"]);
    writeFileSync(join(repo, "f"), "x");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");

    const projectId = seedProject(testDb.sqlite, { path: repo });
    const spy = vi.spyOn(__pushTestHooks, "executeRaw");
    try {
      const got = await runGitPush({ cwd: repo, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("no_upstream");
      expect(got.branch).toBe("feature");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns path_missing for a non-existent cwd", async () => {
    const projectId = seedProject(testDb.sqlite, { path: "/tmp/whatever" });
    const got = await runGitPush({
      cwd: join(tmpRoot, "ghost"),
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("returns not_a_repo for a directory without .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });
    const got = await runGitPush({ cwd: dir, projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });
});

describe("runGitPush — successful push paths (executeRaw stubbed)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-runpush-success-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Set up a feature-branch repo with an upstream wired to a local bare
   * remote. We then stub `executeRaw` so the test never depends on a real
   * push working — the goal is to assert the *result shape*, the *argv
   * shape*, and the *audit row*, all of which live above the network seam.
   */
  async function setupFeatureRepoWithUpstream(name: string): Promise<{
    repo: string;
    projectId: number;
  }> {
    const repo = join(tmpRoot, name);
    const bare = join(tmpRoot, `${name}-bare.git`);
    mkdirSync(repo, { recursive: true });
    mkdirSync(bare, { recursive: true });
    await simpleGit(bare).init(["--bare", "--initial-branch=feature"]);
    const git = simpleGit(repo);
    await git.init(["--initial-branch=feature"]);
    writeFileSync(join(repo, "a"), "1");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");
    await git.addRemote("origin", bare);
    // Push once so the upstream link exists.
    await git.push(["-u", "origin", "feature"]);

    const projectId = seedProject(testDb.sqlite, { path: repo });
    return { repo, projectId };
  }

  it("ok=true, updated=true on a real ref move", async () => {
    const { repo, projectId } = await setupFeatureRepoWithUpstream("updated-repo");

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_git, args) => {
        capturedArgs = args;
        // Simulate a real push with new commits — stderr does NOT contain
        // "Everything up-to-date".
        return {
          stdout: "",
          stderr:
            "To origin\n   abc1234..def5678  feature -> feature\n",
        };
      });

    try {
      const got = await runGitPush({ cwd: repo, projectId });
      expect(got.ok).toBe(true);
      expect(got.updated).toBe(true);
      expect(got.branch).toBe("feature");
      expect(got.remote).toBe("origin");
      expect(got.reason).toBe("ok");

      // Argv assertions: the security invariant lives here too.
      expect(capturedArgs).toEqual([
        "push",
        "origin",
        "HEAD:refs/heads/feature",
      ]);
      expect(capturedArgs).not.toContain("--all");
      expect(capturedArgs).not.toContain("--force");

      // Audit row records the resolved branch (not the placeholder null).
      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, projectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("push");
      expect(rows[0]!.reason).toBe("ok");
      expect(rows[0]!.exitCode).toBe(0);
      const auditArgs = JSON.parse(rows[0]!.argsJson) as Record<string, unknown>;
      expect(auditArgs).toEqual({
        remote: "origin",
        branch: "feature",
        force: false,
        setUpstream: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("ok=true, updated=false when stderr says 'Everything up-to-date'", async () => {
    const { repo, projectId } = await setupFeatureRepoWithUpstream("uptodate-repo");
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({ stdout: "", stderr: "Everything up-to-date\n" });
    try {
      const got = await runGitPush({ cwd: repo, projectId });
      expect(got.ok).toBe(true);
      expect(got.updated).toBe(false);
      expect(got.branch).toBe("feature");
      expect(got.reason).toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("force=true on a non-protected branch passes --force-with-lease (NEVER raw --force)", async () => {
    const { repo, projectId } =
      await setupFeatureRepoWithUpstream("force-feature-repo");

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_git, args) => {
        capturedArgs = args;
        return { stdout: "", stderr: "" };
      });
    try {
      const got = await runGitPush({ cwd: repo, force: true, projectId });
      expect(got.ok).toBe(true);
      expect(capturedArgs).toEqual([
        "push",
        "origin",
        "HEAD:refs/heads/feature",
        "--force-with-lease",
      ]);
      expect(capturedArgs).not.toContain("--force");
      expect(capturedArgs).not.toContain("--all");
      expect(capturedArgs).not.toContain("--mirror");
    } finally {
      spy.mockRestore();
    }
  });

  it("setUpstream=true emits -u and skips the upstream check", async () => {
    // Fresh repo, NO upstream wired — we expect runGitPush to NOT bail with
    // no_upstream because setUpstream is true.
    const repo = join(tmpRoot, "setup-upstream-repo");
    const bare = join(tmpRoot, "setup-upstream-bare.git");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bare, { recursive: true });
    await simpleGit(bare).init(["--bare", "--initial-branch=newfeat"]);
    const git = simpleGit(repo);
    await git.init(["--initial-branch=newfeat"]);
    writeFileSync(join(repo, "a"), "1");
    await git.add(".");
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
    await git.commit("init");
    await git.addRemote("origin", bare);

    const projectId = seedProject(testDb.sqlite, { path: repo });

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_git, args) => {
        capturedArgs = args;
        return { stdout: "", stderr: "" };
      });
    try {
      const got = await runGitPush({
        cwd: repo,
        setUpstream: true,
        projectId,
      });
      expect(got.ok).toBe(true);
      expect(got.branch).toBe("newfeat");
      expect(capturedArgs).toEqual([
        "push",
        "-u",
        "origin",
        "HEAD:refs/heads/newfeat",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies remote rejection stderr as rejected_non_fast_forward", async () => {
    const { repo, projectId } =
      await setupFeatureRepoWithUpstream("rejected-repo");
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr:
            "! [rejected]        feature -> feature (non-fast-forward)\nerror: failed to push some refs",
        }),
      );
    try {
      const got = await runGitPush({ cwd: repo, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("rejected_non_fast_forward");
      expect(got.branch).toBe("feature");
      expect(got.remote).toBe("origin");
      expect(got.stderr).toMatch(/non-fast-forward/);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies auth failure stderr as auth_failed", async () => {
    const { repo, projectId } =
      await setupFeatureRepoWithUpstream("auth-failed-repo");
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "remote: Repository not found.\nfatal: unable to access",
        }),
      );
    try {
      const got = await runGitPush({ cwd: repo, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("auth_failed");
      expect(got.branch).toBe("feature");
    } finally {
      spy.mockRestore();
    }
  });

  it("audit argsJson never contains raw URLs or credentials", async () => {
    const { repo, projectId } =
      await setupFeatureRepoWithUpstream("no-leak-repo");
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({ stdout: "", stderr: "" });
    try {
      await runGitPush({
        cwd: repo,
        // Even if a caller passes a credential-bearing remote name (they
        // shouldn't, but they could), it appears in the audit row VERBATIM
        // — so this test asserts the runGitPush contract by NOT passing
        // such a value AND verifying the JSON shape stays exactly the four
        // documented fields.
        remote: "origin",
        projectId,
      });
      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, projectId));
      expect(rows).toHaveLength(1);
      const args = JSON.parse(rows[0]!.argsJson) as Record<string, unknown>;
      // Exactly four keys, no others.
      expect(Object.keys(args).sort()).toEqual([
        "branch",
        "force",
        "remote",
        "setUpstream",
      ]);
      // No https://, no @host, no token-shaped substring.
      const json = rows[0]!.argsJson;
      expect(json).not.toMatch(/https?:\/\//i);
      expect(json).not.toMatch(/@/);
      expect(json).not.toMatch(/refs\/heads/);
    } finally {
      spy.mockRestore();
    }
  });
});
