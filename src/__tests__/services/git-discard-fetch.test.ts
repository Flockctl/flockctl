import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import {
  runGitDiscard,
  runGitFetch,
} from "../../services/git-operations.js";

/**
 * Service-level tests for `runGitDiscard` and `runGitFetch`. We use real
 * on-disk repos rather than mocking simple-git because the entire value of
 * this code is its interaction with real git semantics — `git checkout --`
 * untracked-path stderr shape, fetch's network-error stderr classification,
 * the validation jail against `..` traversal — and a mock cannot validate
 * any of that.
 *
 * Branches are pinned to `main` via `--initial-branch=main` so the suite
 * is stable across git versions whose `init` default differs.
 */

async function initRepo(path: string): Promise<SimpleGit> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

async function initBareRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--bare", "--initial-branch=main"]);
}

describe("runGitDiscard", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-discard-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns no_paths and writes NO audit row when paths is empty", async () => {
    const repo = join(tmpRoot, "empty-paths");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, [], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("no_paths");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("rejects an absolute path with reason:invalid_path before touching git", async () => {
    const repo = join(tmpRoot, "abs-path");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, ["/etc/passwd"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_path");
    expect(got.message).toMatch(/relative/i);

    // No audit row — bad input never reaches runGitCommand.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a path containing NUL byte with reason:invalid_path", async () => {
    const repo = join(tmpRoot, "nul-path");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, ["foo\0bar"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_path");
    expect(got.message).toMatch(/nul/i);
  });

  it("rejects a `..` traversal with reason:path_outside_repo", async () => {
    const repo = join(tmpRoot, "traversal");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, ["../escape.txt"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_outside_repo");
  });

  it("rejects a non-string entry with reason:invalid_path", async () => {
    const repo = join(tmpRoot, "non-string");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    // `as unknown as string[]` to force an invalid runtime input past
    // the static type signature — this tests the per-entry `typeof !==
    // "string"` guard inside `validateDiscardPath`.
    const got = await runGitDiscard(
      repo,
      [42 as unknown as string],
      { projectId },
    );
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_path");
  });

  it("happy path: reverts a modified tracked file and writes counts-only audit row", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "original\n");
    await git.add("a.txt");
    await git.commit("init");
    // Modify the tracked file → we expect runGitDiscard to revert it.
    writeFileSync(join(repo, "a.txt"), "MODIFIED\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, ["a.txt"], { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.filesDiscarded).toBe(1);
    // File contents must be back to the committed version.
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("original\n");

    // Exactly one audit row, action='discard', counts-only payload, scoped
    // on project_id (workspace_id NULL).
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("discard");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    expect(row.workspaceId).toBeNull();
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({ paths_count: 1 });
    // Audit payload must NOT contain the raw filename.
    expect(JSON.stringify(payload)).not.toMatch(/a\.txt/);
  });

  it("untracked path classifies as unknown_path and audit row records the reason", async () => {
    const repo = join(tmpRoot, "untracked");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "tracked.txt"), "x");
    await git.add("tracked.txt");
    await git.commit("init");
    // Create an untracked file — `git checkout -- untracked.txt` will
    // emit `error: pathspec 'untracked.txt' did not match any file(s)`.
    writeFileSync(join(repo, "untracked.txt"), "y");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiscard(repo, ["untracked.txt"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("unknown_path");
    expect(got.message).toMatch(/not tracked/i);

    // The audit row records the failure (action='discard') even though
    // git rejected the operation — forensic write is unconditional.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("discard");
    expect(rows[0]!.reason).toBe("unknown_path");
  });

  it("scope: workspace-only attribution puts workspace_id, leaves project_id NULL", async () => {
    const repo = join(tmpRoot, "ws-scope");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "1");
    await git.add("f.txt");
    await git.commit("init");
    writeFileSync(join(repo, "f.txt"), "2");
    const wsId = seedWorkspace(testDb.sqlite, {});

    const got = await runGitDiscard(repo, ["f.txt"], { workspaceId: wsId });
    expect(got.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.action).toBe("discard");
  });

  it("returns not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitDiscard(dir, ["a.txt"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("returns path_missing when cwd does not exist", async () => {
    const dir = join(tmpRoot, "ghost-cwd");
    const projectId = seedProject(testDb.sqlite, {});

    const got = await runGitDiscard(dir, ["a.txt"], { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });
});

describe("runGitFetch", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-fetch-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns invalid_remote for a leading-dash remote BEFORE touching git", async () => {
    const repo = join(tmpRoot, "bad-remote");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitFetch(repo, "--upload-pack=foo", { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_remote");
    expect(got.remote).toBe("--upload-pack=foo");

    // No audit row — bad input never reaches runGitCommand.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("returns invalid_remote for a remote with whitespace", async () => {
    const repo = join(tmpRoot, "ws-remote");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitFetch(repo, "ori gin", { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_remote");
  });

  it("defaults to 'origin' when remote is omitted", async () => {
    // Set up a project clone wired to a bare remote so the default-remote
    // path actually has somewhere to fetch from.
    const remote = join(tmpRoot, "default-origin.git");
    const seeder = join(tmpRoot, "default-seeder");
    const projPath = join(tmpRoot, "default-proj");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projectId = seedProject(testDb.sqlite, { path: projPath });

    const got = await runGitFetch(projPath, undefined, { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.remote).toBe("origin");
  });

  it("happy path: fetches from origin, writes audit row with remote in payload", async () => {
    const remote = join(tmpRoot, "fetch-happy.git");
    const seeder = join(tmpRoot, "fetch-happy-seeder");
    const projPath = join(tmpRoot, "fetch-happy-proj");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    // Add a new commit on the remote via the seeder so fetch has work to do.
    writeFileSync(join(seeder, "b.txt"), "2");
    await seederGit.add("b.txt");
    await seederGit.commit("update");
    await seederGit.push("origin", "main");

    const projectId = seedProject(testDb.sqlite, { path: projPath });
    const got = await runGitFetch(projPath, "origin", { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.remote).toBe("origin");

    // The remote-tracking ref must now point at the new commit. We don't
    // assert on the SHA (depends on commit timestamps), only that the ref
    // exists and is non-empty.
    const headRef = readFileSync(
      join(projPath, ".git", "refs", "remotes", "origin", "main"),
      "utf-8",
    ).trim();
    expect(headRef).toMatch(/^[0-9a-f]{40}$/);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("fetch");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({ remote: "origin" });
  });

  it("network_error: classifies a non-routable remote URL via the pull-style stderr matcher", async () => {
    const projPath = join(tmpRoot, "network-fail");
    const git = await initRepo(projPath);
    writeFileSync(join(projPath, "a.txt"), "1");
    await git.add("a.txt");
    await git.commit("init");
    // Wire the project to an unresolvable hostname. We want the
    // "Could not resolve host" stderr class to surface as
    // `reason: network_error`.
    await git.addRemote("origin", "https://this.host.does.not.exist.invalid/repo.git");

    const projectId = seedProject(testDb.sqlite, { path: projPath });
    const got = await runGitFetch(projPath, "origin", { projectId });
    expect(got.ok).toBe(false);
    // Either the DNS resolver reports "could not resolve host" (network
    // error) or — on a system that dns-poisons .invalid into 127.0.0.1 —
    // the resulting auth_failed / unknown is acceptable. Pin the contract
    // we promise the UI: SOMETHING in {network_error, auth_failed, unknown}
    // and never `ok: true`.
    expect(["network_error", "auth_failed", "unknown"]).toContain(got.reason);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("fetch");
  });

  it("returns not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "fetch-not-a-repo");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitFetch(dir, "origin", { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("returns path_missing when cwd does not exist", async () => {
    const dir = join(tmpRoot, "fetch-ghost");
    const projectId = seedProject(testDb.sqlite, {});

    const got = await runGitFetch(dir, "origin", { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("scope: workspace-only attribution sets workspace_id, leaves project_id NULL", async () => {
    const remote = join(tmpRoot, "ws-fetch.git");
    const seeder = join(tmpRoot, "ws-fetch-seeder");
    const projPath = join(tmpRoot, "ws-fetch-proj");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");
    await simpleGit().clone(remote, projPath);

    const wsId = seedWorkspace(testDb.sqlite, {});
    const got = await runGitFetch(projPath, "origin", { workspaceId: wsId });
    expect(got.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.action).toBe("fetch");
  });
});
