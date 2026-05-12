import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { runGitShow } from "../../services/git-operations.js";

/**
 * Service-level tests for `runGitShow`. Real on-disk repos rather than
 * mocking simple-git — the entire value of this code is its interaction
 * with real git semantics (`%s` single-line subject, `--name-status -z`
 * NUL-terminated rename rows, `--numstat` binary marker `-`) and a mock
 * cannot validate any of that.
 */

async function initRepo(path: string): Promise<SimpleGit> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

async function commit(
  git: SimpleGit,
  cwd: string,
  setup: () => void,
  message: string,
): Promise<string> {
  setup();
  await git.add(".");
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
}

describe("runGitShow", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-show-svc-"));

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
    const got = await runGitShow(join(tmpRoot, "ghost"), {
      projectId,
      sha: "deadbeefdeadbeef",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("returns ok:false / reason:not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });
    const got = await runGitShow(dir, {
      projectId,
      sha: "deadbeefdeadbeef",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("rejects a junk SHA with reason:bad_revision before touching git", async () => {
    const repo = join(tmpRoot, "bad-sha");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, {
      projectId,
      sha: "not-a-hex; rm -rf /",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/sha/i);
  });

  it("rejects a SHA shorter than 7 chars with reason:bad_revision", async () => {
    const repo = join(tmpRoot, "short-sha");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: "abcd" });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("classifies an unknown ref as bad_revision via the stderr fallback", async () => {
    const repo = join(tmpRoot, "missing-sha");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "x"),
      "init",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, {
      projectId,
      // Valid hex shape but no such object in this repo.
      sha: "0000000000000000000000000000000000000000",
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("returns full commit metadata + file list for a single-file modify", async () => {
    const repo = join(tmpRoot, "modify");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "line1\nline2\n"),
      "init",
    );
    const headSha = await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "line1\nline2\nline3\n"),
      "add line3",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: headSha });
    expect(got.ok).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.commit?.sha).toBe(headSha);
    expect(got.commit?.author).toBe("Test");
    expect(got.commit?.email).toBe("test@example.com");
    expect(typeof got.commit?.ts).toBe("number");
    expect(got.commit?.ts).toBeGreaterThan(0);
    expect(got.commit?.message).toBe("add line3");
    expect(got.commit?.parents).toHaveLength(1);

    expect(got.files).toHaveLength(1);
    const f = got.files![0]!;
    expect(f.path).toBe("f.txt");
    expect(f.status).toBe("M");
    expect(f.added).toBe(1);
    expect(f.removed).toBe(0);
    expect(f.oldPath).toBeUndefined();
  });

  it("reports parents:[] for the initial commit (no parent)", async () => {
    const repo = join(tmpRoot, "initial");
    const git = await initRepo(repo);
    const initSha = await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "a.txt"), "hi\n"),
      "init",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: initSha });
    expect(got.ok).toBe(true);
    expect(got.commit?.parents).toEqual([]);
    // The initial commit's only file is added.
    expect(got.files![0]!.status).toBe("A");
  });

  it("reports parents.length>=2 for a merge commit", async () => {
    const repo = join(tmpRoot, "merge");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "main1"),
      "main1",
    );
    await git.checkoutLocalBranch("topic");
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "t.txt"), "topic"),
      "topic",
    );
    await git.checkout("main");
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "g.txt"), "main2"),
      "main2",
    );
    await git.merge(["--no-ff", "topic", "-m", "merge topic"]);
    const mergeSha = (await git.revparse(["HEAD"])).trim();
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: mergeSha });
    expect(got.ok).toBe(true);
    expect(got.commit?.parents.length).toBeGreaterThanOrEqual(2);
    expect(got.commit?.message).toBe("merge topic");
  });

  it("classifies an A row for a newly-added file with added>0 / removed=0", async () => {
    const repo = join(tmpRoot, "added");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "old.txt"), "x"),
      "init",
    );
    const headSha = await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "new.txt"), "hello\nworld\n"),
      "add new file",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: headSha });
    expect(got.ok).toBe(true);
    const f = got.files!.find((x) => x.path === "new.txt")!;
    expect(f.status).toBe("A");
    expect(f.added).toBe(2);
    expect(f.removed).toBe(0);
  });

  it("classifies a D row for a deleted file with added=0 / removed>0", async () => {
    const repo = join(tmpRoot, "deleted");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "doomed.txt"), "a\nb\nc\n"),
      "init",
    );
    const headSha = await commit(
      git,
      repo,
      () => rmSync(join(repo, "doomed.txt")),
      "remove doomed",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: headSha });
    expect(got.ok).toBe(true);
    const f = got.files!.find((x) => x.path === "doomed.txt")!;
    expect(f.status).toBe("D");
    expect(f.added).toBe(0);
    expect(f.removed).toBe(3);
  });

  it("classifies an R row for a rename with oldPath surfaced", async () => {
    const repo = join(tmpRoot, "renamed");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () =>
        writeFileSync(
          join(repo, "old-name.txt"),
          "the quick brown fox jumps over the lazy dog\n".repeat(20),
        ),
      "init",
    );
    const headSha = await commit(
      git,
      repo,
      () => renameSync(join(repo, "old-name.txt"), join(repo, "new-name.txt")),
      "rename file",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitShow(repo, { projectId, sha: headSha });
    expect(got.ok).toBe(true);
    const f = got.files![0]!;
    expect(f.status).toBe("R");
    expect(f.path).toBe("new-name.txt");
    expect(f.oldPath).toBe("old-name.txt");
  });

  it("writes a single audit row on success scoped to the project, action='show'", async () => {
    const repo = join(tmpRoot, "audit-success");
    const git = await initRepo(repo);
    const sha = await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "x"),
      "init",
    );
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitShow(repo, { projectId, sha });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("show");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    // Audit payload records ONLY the 12-char SHA prefix — never the full SHA
    // (forensic noise on long-running daemons).
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({ sha_prefix: sha.slice(0, 12) });
  });

  it("writes an audit row on failure with workspace_id scope", async () => {
    const repo = join(tmpRoot, "audit-fail");
    const git = await initRepo(repo);
    await commit(
      git,
      repo,
      () => writeFileSync(join(repo, "f.txt"), "x"),
      "init",
    );
    const wsId = seedWorkspace(testDb.sqlite, {});

    await runGitShow(repo, {
      workspaceId: wsId,
      sha: "0000000000000000000000000000000000000000",
    });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("show");
    expect(rows[0]!.projectId).toBeNull();
  });
});
