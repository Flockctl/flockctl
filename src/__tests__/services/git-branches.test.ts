import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import {
  runGitBranchList,
  runGitCheckout,
  runGitBranchDelete,
} from "../../services/git-operations.js";

/**
 * Service-level tests for the three branch operations:
 *
 *   • runGitBranchList      — read-only enumeration
 *   • runGitCheckout        — switch / create branch
 *   • runGitBranchDelete    — `git branch -d|-D`
 *
 * Real on-disk repos rather than mocks: the value of these helpers is the
 * for-each-ref parser and the protected-branch / dirty-tree guardrails;
 * a mock cannot validate any of that.
 *
 * `--initial-branch=main` pins the suite's default branch so behaviour is
 * stable across git versions whose `init.defaultBranch` differs.
 */

async function initRepo(path: string): Promise<SimpleGit> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

async function commitOne(git: SimpleGit, cwd: string, marker: string): Promise<string> {
  writeFileSync(join(cwd, "f.txt"), marker);
  await git.add("f.txt");
  await git.commit(`commit ${marker}`);
  return (await git.revparse(["HEAD"])).trim();
}

describe("runGitBranchList", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-branches-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns ok:false / reason:not_a_repo when the path lacks a .git directory", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitBranchList(dir, { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("returns ok:false / reason:path_missing when the path does not exist", async () => {
    const projectId = seedProject(testDb.sqlite, {});
    const got = await runGitBranchList(join(tmpRoot, "ghost"), { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("lists local branches with current marker and zero ahead/behind for no-upstream", async () => {
    const repo = join(tmpRoot, "local-only");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await commitOne(git, repo, "y");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitBranchList(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.detached).toBe(false);
    const local = got.branches!.filter((b) => !b.isRemote);
    const names = local.map((b) => b.name).sort();
    expect(names).toEqual(["feature", "main"]);
    const main = local.find((b) => b.name === "main")!;
    expect(main.current).toBe(true);
    expect(main.upstream).toBeNull();
    expect(main.ahead).toBe(0);
    expect(main.behind).toBe(0);
    const feature = local.find((b) => b.name === "feature")!;
    expect(feature.current).toBe(false);
  });

  it("includes remote refs and parses ahead/behind from the upstream:track column", async () => {
    // Set up a fake upstream by cloning, then advancing local main one commit.
    const upstream = join(tmpRoot, "upstream-bare");
    mkdirSync(upstream, { recursive: true });
    await simpleGit(upstream).init(["--bare", "--initial-branch=main"]);

    const downstream = join(tmpRoot, "downstream");
    const seed = await initRepo(downstream);
    await commitOne(seed, downstream, "x");
    await seed.addRemote("origin", upstream);
    await seed.push(["-u", "origin", "main"]);
    await commitOne(seed, downstream, "y");
    // Now local main is 1 ahead of origin/main.
    const projectId = seedProject(testDb.sqlite, { path: downstream });

    const got = await runGitBranchList(downstream, { projectId });
    expect(got.ok).toBe(true);
    const main = got.branches!.find((b) => b.name === "main")!;
    expect(main.current).toBe(true);
    expect(main.upstream).toBe("origin/main");
    expect(main.ahead).toBe(1);
    expect(main.behind).toBe(0);
    const remote = got.branches!.find((b) => b.isRemote);
    expect(remote).toBeDefined();
    expect(remote!.name).toMatch(/^origin\//);
  });

  it("reports detached:true when HEAD is detached on a populated repo", async () => {
    const repo = join(tmpRoot, "detached");
    const git = await initRepo(repo);
    const sha = await commitOne(git, repo, "x");
    await commitOne(git, repo, "y");
    await git.checkout(sha);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitBranchList(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.detached).toBe(true);
    expect(got.branches!.some((b) => b.current)).toBe(false);
  });

  it("writes a single audit row scoped to the project, action='branch_list', argsJson='{}'", async () => {
    const repo = join(tmpRoot, "audit-ws");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    await runGitBranchList(repo, { workspaceId: wsId });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("branch_list");
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.argsJson).toBe("{}");
    expect(rows[0]!.reason).toBe("ok");
  });
});

describe("runGitCheckout", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-checkout-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects an invalid branch name (shell metacharacters) at the service boundary", async () => {
    const repo = join(tmpRoot, "bad-name");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "feature; rm -rf /",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_branch_name");
  });

  it("switches to an existing branch on a clean working tree", async () => {
    const repo = join(tmpRoot, "switch-clean");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "feature",
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.branch).toBe("feature");
    expect(got.created).toBe(false);

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("feature");
  });

  it("creates a new branch when create=true", async () => {
    const repo = join(tmpRoot, "create-branch");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "topic",
      create: true,
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.created).toBe(true);
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    expect(head).toBe("topic");
  });

  it("refuses to switch on a dirty working tree (dirty_working_tree)", async () => {
    const repo = join(tmpRoot, "dirty-refuse");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    writeFileSync(join(repo, "scratch.txt"), "uncommitted");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "feature",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("dirty_working_tree");
  });

  it("classifies an unknown branch as branch_not_found", async () => {
    const repo = join(tmpRoot, "missing-branch");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "no-such-branch",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("branch_not_found");
  });

  it("classifies create=true with an existing name as branch_already_exists", async () => {
    const repo = join(tmpRoot, "duplicate-branch");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitCheckout({
      cwd: repo,
      branch: "feature",
      create: true,
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("branch_already_exists");
  });

  it("writes an audit row with action='checkout' and counts-only argsJson", async () => {
    const repo = join(tmpRoot, "audit-checkout");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitCheckout({
      cwd: repo,
      branch: "topic",
      create: true,
      projectId,
    });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("checkout");
    const payload = JSON.parse(last.argsJson);
    expect(payload).toEqual({
      branch: "topic",
      create: true,
      has_start_point: false,
    });
  });
});

describe("runGitBranchDelete", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-delete-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects an invalid branch name at the service boundary", async () => {
    const repo = join(tmpRoot, "bad-name");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitBranchDelete({
      cwd: repo,
      branch: "bad name",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_branch_name");
  });

  it("refuses to delete protected 'main' / 'master' without force, BEFORE writing an audit row", async () => {
    const repo = join(tmpRoot, "protected");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const before = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));

    const got = await runGitBranchDelete({
      cwd: repo,
      branch: "main",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("git_protected_branch");

    const after = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    // Pre-flight refusal must NOT write an audit row — the operation never
    // reached git, so the forensic log stays untouched.
    expect(after.length).toBe(before.length);
  });

  it("cannot delete the currently checked-out branch (git_cannot_delete_current_branch)", async () => {
    const repo = join(tmpRoot, "current-branch");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitBranchDelete({
      cwd: repo,
      branch: "feature",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("git_cannot_delete_current_branch");
  });

  it("deletes a merged feature branch with force=false", async () => {
    const repo = join(tmpRoot, "delete-merged");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("merged");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitBranchDelete({
      cwd: repo,
      branch: "merged",
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.branch).toBe("merged");
  });

  it("rejects -d on an unmerged branch and accepts force=true", async () => {
    const repo = join(tmpRoot, "delete-unmerged");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await commitOne(git, repo, "y");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const fail = await runGitBranchDelete({
      cwd: repo,
      branch: "feature",
      projectId,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("not_fully_merged");

    const ok = await runGitBranchDelete({
      cwd: repo,
      branch: "feature",
      force: true,
      projectId,
    });
    expect(ok.ok).toBe(true);
  });

  it("writes an audit row with action='branch_delete' and {branch, force} payload", async () => {
    const repo = join(tmpRoot, "audit-delete");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("doomed");
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitBranchDelete({
      cwd: repo,
      branch: "doomed",
      projectId,
    });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("branch_delete");
    expect(JSON.parse(last.argsJson)).toEqual({
      branch: "doomed",
      force: false,
    });
  });
});
