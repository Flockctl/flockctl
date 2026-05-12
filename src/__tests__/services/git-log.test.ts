import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { runGitLog } from "../../services/git-operations.js";

/**
 * Service-level tests for `runGitLog`. We use real on-disk repos rather
 * than mocking simple-git because the entire value of this code is its
 * interaction with real git semantics (`%P` parent format, `--end-of-options`
 * sentinel, "does not have any commits" empty-repo stderr) — a mock cannot
 * validate any of that.
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

/** Make `n` linear commits with deterministic content. Returns SHAs in
 *  reverse-chronological order (newest first) — same order `git log` emits. */
async function makeLinearCommits(
  git: SimpleGit,
  cwd: string,
  n: number,
): Promise<string[]> {
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(cwd, "f.txt"), `rev ${i}\n`);
    await git.add("f.txt");
    await git.commit(`commit ${i}`);
    const sha = (await git.revparse(["HEAD"])).trim();
    shas.unshift(sha); // newest first
  }
  return shas;
}

describe("runGitLog", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-log-svc-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns ok:false / reason:path_missing when cwd does not exist", async () => {
    const projectId = seedProject(testDb.sqlite, {});
    const got = await runGitLog(join(tmpRoot, "ghost"), { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("returns ok:false / reason:not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });
    const got = await runGitLog(dir, { projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("returns empty commits + null nextCursor for an empty repo (no commits yet)", async () => {
    const repo = join(tmpRoot, "empty-repo");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitLog(repo, { projectId });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.commits).toEqual([]);
    expect(got.nextCursor).toBeNull();
  });

  it("returns the full history when count <= limit and nextCursor=null", async () => {
    const repo = join(tmpRoot, "small-repo");
    const git = await initRepo(repo);
    const shas = await makeLinearCommits(git, repo, 3);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, { projectId, limit: 30 });
    expect(got.ok).toBe(true);
    expect(got.commits?.map((c) => c.sha)).toEqual(shas);
    expect(got.nextCursor).toBeNull();
    // Each commit row carries the documented fields.
    for (const c of got.commits!) {
      expect(c.shortSha).toBe(c.sha.slice(0, 7));
      expect(c.author).toBe("Test");
      expect(c.email).toBe("test@example.com");
      expect(typeof c.ts).toBe("number");
      expect(c.ts).toBeGreaterThan(0);
      expect(typeof c.subject).toBe("string");
      expect(Array.isArray(c.parents)).toBe(true);
    }
    // The root commit has zero parents; later commits have exactly one.
    expect(got.commits![got.commits!.length - 1]!.parents).toEqual([]);
    expect(got.commits![0]!.parents).toHaveLength(1);
  });

  it("paginates: limit cuts the response, nextCursor advances the next page", async () => {
    const repo = join(tmpRoot, "page-repo");
    const git = await initRepo(repo);
    const shas = await makeLinearCommits(git, repo, 7);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const page1 = await runGitLog(repo, { projectId, limit: 3 });
    expect(page1.ok).toBe(true);
    expect(page1.commits).toHaveLength(3);
    expect(page1.commits!.map((c) => c.sha)).toEqual(shas.slice(0, 3));
    expect(page1.nextCursor).toBe(shas[3]);

    const page2 = await runGitLog(repo, {
      projectId,
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.ok).toBe(true);
    expect(page2.commits!.map((c) => c.sha)).toEqual(shas.slice(3, 6));
    expect(page2.nextCursor).toBe(shas[6]);

    const page3 = await runGitLog(repo, {
      projectId,
      limit: 3,
      cursor: page2.nextCursor!,
    });
    expect(page3.ok).toBe(true);
    expect(page3.commits!.map((c) => c.sha)).toEqual([shas[6]]);
    expect(page3.nextCursor).toBeNull();
  });

  it("rejects a junk cursor with reason:bad_revision before touching git", async () => {
    const repo = join(tmpRoot, "bad-cursor");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, {
      projectId,
      cursor: "not-a-hex-sha; rm -rf /",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/cursor/i);
  });

  it("rejects a leading-dash branch with reason:bad_revision", async () => {
    const repo = join(tmpRoot, "bad-branch");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, {
      projectId,
      branch: "--upload-pack=foo",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/branch/i);
  });

  it("classifies an unknown ref as bad_revision via the stderr fallback", async () => {
    const repo = join(tmpRoot, "missing-ref");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, {
      projectId,
      branch: "no-such-branch-here",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("walks a non-default branch when branch=<name> is set", async () => {
    const repo = join(tmpRoot, "branch-walk");
    const git = await initRepo(repo);
    const mainShas = await makeLinearCommits(git, repo, 2);
    await git.checkoutLocalBranch("feature");
    writeFileSync(join(repo, "feature.txt"), "x");
    await git.add("feature.txt");
    await git.commit("feature commit");
    const featureSha = (await git.revparse(["HEAD"])).trim();
    await git.checkout("main");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, { projectId, branch: "feature" });
    expect(got.ok).toBe(true);
    // feature has 3 commits: the new one + the 2 main commits it diverged from.
    expect(got.commits!.map((c) => c.sha)).toEqual([
      featureSha,
      ...mainShas,
    ]);
  });

  it("reports parents.length>=2 for a merge commit", async () => {
    const repo = join(tmpRoot, "merge-repo");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    await git.checkoutLocalBranch("topic");
    writeFileSync(join(repo, "t.txt"), "topic");
    await git.add("t.txt");
    await git.commit("topic commit");
    await git.checkout("main");
    writeFileSync(join(repo, "m.txt"), "main2");
    await git.add("m.txt");
    await git.commit("main2");
    await git.merge(["--no-ff", "topic", "-m", "merge topic"]);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, { projectId, limit: 5 });
    expect(got.ok).toBe(true);
    const merge = got.commits!.find((c) => c.subject === "merge topic");
    expect(merge).toBeDefined();
    expect(merge!.parents.length).toBeGreaterThanOrEqual(2);
  });

  it("writes a single audit row on success scoped to the project, action='log'", async () => {
    const repo = join(tmpRoot, "audit-success");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitLog(repo, { projectId, limit: 5, branch: "main" });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("log");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    // Audit payload must NOT include the branch name or any cursor SHA —
    // forensic noise / leakable in-flight feature names. Only summary flags.
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({ limit: 5, has_cursor: false, has_branch: true });
    expect(JSON.stringify(payload)).not.toMatch(/main/);
  });

  it("writes an audit row even on bad_revision (stderr-classified failure)", async () => {
    const repo = join(tmpRoot, "audit-bad-rev");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const wsId = seedWorkspace(testDb.sqlite, {});

    await runGitLog(repo, { workspaceId: wsId, branch: "no-such-branch" });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("log");
    expect(rows[0]!.projectId).toBeNull();
    // The audit row's `reason` mirrors the v2 GitReason enum — bad_revision
    // is recovered from stderr text in the route mapper, so the row itself
    // records the raw reason that runGitCommand classified (typically
    // "unknown" for ambiguous refs). Either is acceptable; we just want
    // to confirm a row was written.
    expect(typeof rows[0]!.reason).toBe("string");
  });

  it("clamps limit > MAX_LIMIT (100) without rejecting the request", async () => {
    const repo = join(tmpRoot, "limit-clamp");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 3);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitLog(repo, { projectId, limit: 1000 });
    expect(got.ok).toBe(true);
    // Audit payload reflects the clamped limit, not the request's 1000.
    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    const last = rows[rows.length - 1]!;
    expect(JSON.parse(last.argsJson).limit).toBe(100);
  });

  it("rejects non-positive / non-integer limits as bad_revision", async () => {
    const repo = join(tmpRoot, "bad-limit");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    for (const bad of [0, -1, 1.5, NaN]) {
      const got = await runGitLog(repo, { projectId, limit: bad });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("bad_revision");
      expect(got.message).toMatch(/limit/i);
    }
  });
});
