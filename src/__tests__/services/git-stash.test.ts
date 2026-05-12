import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  runGitStashPush,
  runGitStashList,
  runGitStashPop,
  runGitStashDrop,
} from "../../services/git-operations.js";

/**
 * Service-level tests for `runGitStash{Push,List,Pop,Drop}`. We use real
 * on-disk repos rather than mocking simple-git because the entire value of
 * this code is its interaction with real git semantics — `git stash push`'s
 * "No local changes to save" stdout, `git stash pop`'s CONFLICT output, the
 * canonical `stash@{N}` ref grammar, and the audit-row counts-only payload
 * invariant. A mock cannot validate any of that.
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

/**
 * Seed: init repo, write + commit a baseline file. Returns the simple-git
 * handle so callers can layer further mutations on top.
 */
async function seedBaseline(path: string): Promise<SimpleGit> {
  const git = await initRepo(path);
  writeFileSync(join(path, "a.txt"), "v1\n");
  await git.add("a.txt");
  await git.commit("init");
  return git;
}

describe("runGitStashPush", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-push-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("happy path: stashes a modified tracked file and writes counts-only audit row", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MODIFIED\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPush(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.nothingToStash).toBe(false);
    // Working tree must be back to the committed version.
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("v1\n");
    // Stash must have one entry.
    const stashList = await git.stashList();
    expect(stashList.total).toBe(1);

    // Exactly one audit row, action='stash_push', counts-only payload,
    // scoped on project_id (workspace_id NULL).
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("stash_push");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    expect(row.workspaceId).toBeNull();
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({ has_message: false, include_untracked: false });
  });

  it("nothing_to_stash: clean working tree returns ok:true with reason='nothing_to_stash'", async () => {
    const repo = join(tmpRoot, "nothing");
    const git = await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPush(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("nothing_to_stash");
    expect(got.nothingToStash).toBe(true);
    // No stash entry created.
    const stashList = await git.stashList();
    expect(stashList.total).toBe(0);
  });

  it("includeUntracked=true stashes new untracked files via -u", async () => {
    const repo = join(tmpRoot, "untracked");
    await seedBaseline(repo);
    writeFileSync(join(repo, "new.txt"), "new\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPush(repo, {
      includeUntracked: true,
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    // The previously-untracked file should be gone from the working tree
    // (now living in the stash).
    expect(existsSync(join(repo, "new.txt"))).toBe(false);

    // Audit payload reflects the include_untracked flag.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({
      has_message: false,
      include_untracked: true,
    });
  });

  it("message body is captured by the stash but NEVER appears in the audit payload", async () => {
    const repo = join(tmpRoot, "message");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const secret = "super-secret-feature-name";
    const got = await runGitStashPush(repo, {
      message: secret,
      projectId,
    });
    expect(got.ok).toBe(true);

    // Stash subject must contain the message.
    const stashList = await git.stashList();
    expect(stashList.latest?.message ?? "").toContain(secret);

    // Audit payload must NOT.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.argsJson);
    expect(payload).toEqual({ has_message: true, include_untracked: false });
    expect(rows[0]!.argsJson).not.toContain(secret);
  });

  it("workspace-only attribution: workspace_id set, project_id NULL", async () => {
    const repo = join(tmpRoot, "ws-scope");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "v2");
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    const got = await runGitStashPush(repo, { workspaceId: wsId });
    expect(got.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.action).toBe("stash_push");
  });

  it("returns not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitStashPush(dir, { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("returns path_missing when cwd does not exist", async () => {
    const dir = join(tmpRoot, "ghost-cwd");
    const projectId = seedProject(testDb.sqlite, {});

    const got = await runGitStashPush(dir, { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });
});

describe("runGitStashList", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-list-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("empty stash returns ok:true with stashes:[] (NOT an error)", async () => {
    const repo = join(tmpRoot, "empty");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashList(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.stashes).toEqual([]);
  });

  it("happy path: lists multiple stash entries with ref/hash/date/message", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await seedBaseline(repo);
    // Two stashes.
    writeFileSync(join(repo, "a.txt"), "v2");
    await runGitStashPush(repo, { message: "first" });
    writeFileSync(join(repo, "a.txt"), "v3");
    await runGitStashPush(repo, { message: "second" });

    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitStashList(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.stashes).toHaveLength(2);
    // Most-recent stash is at index 0 (LIFO).
    expect(got.stashes![0]!.ref).toBe("stash@{0}");
    expect(got.stashes![1]!.ref).toBe("stash@{1}");
    // SHA shape sanity-check.
    expect(got.stashes![0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    // Date is ISO 8601 with offset.
    expect(got.stashes![0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Messages contain the operator-supplied bodies.
    expect(got.stashes![0]!.message).toContain("second");
    expect(got.stashes![1]!.message).toContain("first");

    // Audit row written under action='stash_list' even though it's read-only.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_list");
    expect(rows[0]!.argsJson).toBe("{}");
    // Quiet the unused-binding lint on `git` — we kept the handle to be
    // explicit about the seed but intentionally don't call it here.
    expect(typeof git.stashList).toBe("function");
  });

  it("returns not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });

    const got = await runGitStashList(dir, { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });
});

describe("runGitStashPop", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-pop-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("invalid_ref: rejects bare integer BEFORE touching git", async () => {
    const repo = join(tmpRoot, "bare-int");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({ cwd: repo, ref: "0", projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_ref");
    expect(got.message).toMatch(/canonical/i);

    // No audit row — bad input never reaches runGitCommand.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("invalid_ref: rejects named stash like 'stash@{foo}'", async () => {
    const repo = join(tmpRoot, "named");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{foo}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_ref");
  });

  it("invalid_ref: rejects metacharacter-laden refs", async () => {
    const repo = join(tmpRoot, "meta");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{0}; rm -rf /",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_ref");
  });

  it("happy path: pops a stash, restores changes, audit row records the ref", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, { message: "wip" });
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{0}",
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.ref).toBe("stash@{0}");
    // Changes are back in the working tree.
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("MOD\n");
    // Stash is empty.
    expect((await git.stashList()).total).toBe(0);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_pop");
    expect(rows[0]!.reason).toBe("ok");
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ ref: "stash@{0}" });
  });

  it("not_found: empty stash surfaces as not_found (NOT conflict)", async () => {
    const repo = join(tmpRoot, "empty-pop");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{0}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_found");

    // Audit row IS written (the operation reached git).
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_pop");
  });

  it("not_found: out-of-range index surfaces as not_found", async () => {
    const repo = join(tmpRoot, "oob");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{99}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_found");
  });

  it("git_stash_pop_conflict: pop into a dirty matching path returns the conflict reason", async () => {
    const repo = join(tmpRoot, "conflict");
    const git = await seedBaseline(repo);
    // Stash one version of a.txt …
    writeFileSync(join(repo, "a.txt"), "VARIANT-A\n");
    await runGitStashPush(repo, {});
    // … then write a CONFLICTING in-memory edit so pop runs into a merge
    // conflict on the same file.
    writeFileSync(join(repo, "a.txt"), "VARIANT-B\n");

    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitStashPop({
      cwd: repo,
      ref: "stash@{0}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("git_stash_pop_conflict");

    // The stash MUST still be on the stack — git keeps it on conflict.
    expect((await git.stashList()).total).toBe(1);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_pop");
    expect(rows[0]!.reason).not.toBe("ok");
  });
});

describe("runGitStashDrop", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-drop-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("invalid_ref: rejects non-canonical ref BEFORE touching git", async () => {
    const repo = join(tmpRoot, "bad");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashDrop({
      cwd: repo,
      ref: "stash@{}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("invalid_ref");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("happy path: drops stash@{0}, audit row records the ref", async () => {
    const repo = join(tmpRoot, "happy-drop");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashDrop({
      cwd: repo,
      ref: "stash@{0}",
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.ref).toBe("stash@{0}");
    expect((await git.stashList()).total).toBe(0);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_drop");
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ ref: "stash@{0}" });
  });

  it("not_found: dropping out-of-range entry surfaces as not_found", async () => {
    const repo = join(tmpRoot, "drop-oob");
    await seedBaseline(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitStashDrop({
      cwd: repo,
      ref: "stash@{0}",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_found");
  });

  it("workspace-only attribution: workspace_id set, project_id NULL", async () => {
    const repo = join(tmpRoot, "ws-drop");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    const got = await runGitStashDrop({
      cwd: repo,
      ref: "stash@{0}",
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
    expect(rows[0]!.action).toBe("stash_drop");
  });
});
