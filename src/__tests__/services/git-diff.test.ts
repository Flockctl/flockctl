import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { runGitDiff, GIT_DIFF_MAX_BYTES } from "../../services/git-operations.js";

/**
 * Service-level tests for `runGitDiff`. We use real on-disk repos rather
 * than mocking simple-git because the entire value of this code is its
 * interaction with real git semantics (`--cached`, `--name-status`'s
 * R<percent>\told\tnew rename rows, `Binary files … differ`, the empty-output
 * "unchanged" branch). A mock cannot validate any of that.
 *
 * Branches are pinned to `main` via `--initial-branch=main` so the suite
 * stays stable across git versions whose `init.defaultBranch` differs.
 */

async function initRepo(path: string): Promise<SimpleGit> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

describe("runGitDiff", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-diff-svc-"));

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
    const got = await runGitDiff(join(tmpRoot, "ghost"), {
      path: "f.txt",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("path_missing");
  });

  it("returns ok:false / reason:not_a_repo when cwd has no .git/", async () => {
    const dir = join(tmpRoot, "no-git");
    mkdirSync(dir, { recursive: true });
    const projectId = seedProject(testDb.sqlite, { path: dir });
    const got = await runGitDiff(dir, { path: "f.txt", projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("not_a_repo");
  });

  it("rejects an empty / missing path with reason:bad_revision before touching git", async () => {
    const repo = join(tmpRoot, "empty-path");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitDiff(repo, { path: "", projectId });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/path/i);
  });

  it("rejects a leading-dash path with reason:bad_revision", async () => {
    const repo = join(tmpRoot, "dash-path");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitDiff(repo, {
      path: "--upload-pack=foo",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("rejects a path-traversal path with reason:bad_revision", async () => {
    const repo = join(tmpRoot, "traversal-path");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    for (const bad of ["..", "../etc/passwd", "/abs/path", "a/../b"]) {
      const got = await runGitDiff(repo, { path: bad, projectId });
      expect(got.ok).toBe(false);
      expect(got.reason).toBe("bad_revision");
    }
  });

  it("rejects a leading-dash base/head with reason:bad_revision", async () => {
    const repo = join(tmpRoot, "dash-base");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitDiff(repo, {
      path: "f.txt",
      base: "--exec=foo",
      head: "main",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/base/i);
  });

  it("rejects staged combined with base/head as bad_revision", async () => {
    const repo = join(tmpRoot, "staged-and-refs");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitDiff(repo, {
      path: "f.txt",
      staged: true,
      base: "main",
      head: "HEAD",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
    expect(got.message).toMatch(/staged/i);
  });

  it("rejects a single-sided base or head as bad_revision", async () => {
    const repo = join(tmpRoot, "single-ref");
    await initRepo(repo);
    const projectId = seedProject(testDb.sqlite, { path: repo });
    const got = await runGitDiff(repo, {
      path: "f.txt",
      base: "main",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("returns ok:true with status:'unchanged' for an unmodified path", async () => {
    const repo = join(tmpRoot, "unchanged");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "hello\n");
    await git.add("f.txt");
    await git.commit("init");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, { path: "f.txt", projectId });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("unchanged");
    expect(got.patch).toBe("");
    expect(got.size).toBe(0);
    expect(got.base).toBeNull();
    expect(got.head).toBeNull();
  });

  it("returns ok:true with status:'M' for a modified working-tree file", async () => {
    const repo = join(tmpRoot, "modified");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "v1\n");
    await git.add("f.txt");
    await git.commit("init");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, { path: "f.txt", projectId });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("M");
    expect(got.patch).toMatch(/^diff --git/m);
    expect(got.patch).toMatch(/-v1/);
    expect(got.patch).toMatch(/\+v2/);
    expect(got.patch).not.toMatch(/\[/); // no ANSI color codes
    expect(got.size).toBe(got.patch!.length);
  });

  it("returns status:'A' for a newly-staged file when staged=true", async () => {
    const repo = join(tmpRoot, "added-staged");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "first.txt"), "first\n");
    await git.add("first.txt");
    await git.commit("init");
    writeFileSync(join(repo, "new.txt"), "added\n");
    await git.add("new.txt");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, {
      path: "new.txt",
      staged: true,
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("A");
    expect(got.patch).toMatch(/new file mode/);
  });

  it("returns status:'D' when a file is deleted in the working tree", async () => {
    const repo = join(tmpRoot, "deleted");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "to be removed\n");
    await git.add("f.txt");
    await git.commit("init");
    rmSync(join(repo, "f.txt"));
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, { path: "f.txt", projectId });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("D");
    expect(got.patch).toMatch(/deleted file mode/);
  });

  it("returns status:'R' with oldPath / newPath for a staged rename", async () => {
    const repo = join(tmpRoot, "renamed");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "old.txt"), "stable contents that survive a rename\n");
    await git.add("old.txt");
    await git.commit("init");
    // simple-git wraps `git mv` for renames.
    await git.mv("old.txt", "new.txt");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    // Diff staged: --name-status returns `R100\told.txt\tnew.txt`.
    const got = await runGitDiff(repo, {
      path: "new.txt",
      staged: true,
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("R");
    expect(got.oldPath).toBe("old.txt");
    expect(got.newPath).toBe("new.txt");
  });

  it("detects binary diffs and returns status:'binary'", async () => {
    const repo = join(tmpRoot, "binary");
    const git = await initRepo(repo);
    // Commit a NUL-byte file (git classifies as binary).
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    await git.add("blob.bin");
    await git.commit("init");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([9, 8, 0, 7, 6]));
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, { path: "blob.bin", projectId });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("binary");
    expect(got.patch).toMatch(/Binary files/);
  });

  it("diffs between two refs when base/head are provided", async () => {
    const repo = join(tmpRoot, "between-refs");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "v1\n");
    await git.add("f.txt");
    await git.commit("init");
    const baseSha = (await git.revparse(["HEAD"])).trim();
    writeFileSync(join(repo, "f.txt"), "v2\n");
    await git.add("f.txt");
    await git.commit("v2");
    const headSha = (await git.revparse(["HEAD"])).trim();
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, {
      path: "f.txt",
      base: baseSha,
      head: headSha,
      projectId,
    });
    expect(got.ok).toBe(true);
    expect(got.status).toBe("M");
    expect(got.base).toBe(baseSha);
    expect(got.head).toBe(headSha);
    expect(got.patch).toMatch(/-v1/);
    expect(got.patch).toMatch(/\+v2/);
  });

  it("classifies an unknown ref as bad_revision via the stderr fallback", async () => {
    const repo = join(tmpRoot, "missing-ref");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "x\n");
    await git.add("f.txt");
    await git.commit("init");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, {
      path: "f.txt",
      base: "no-such-ref",
      head: "main",
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("bad_revision");
  });

  it("returns ok:false / reason:git_patch_too_large with size + hint when patch exceeds maxBytes", async () => {
    const repo = join(tmpRoot, "too-large");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "big.txt"), "v1\n".repeat(100));
    await git.add("big.txt");
    await git.commit("init");
    // Modify so the diff has plenty of content
    writeFileSync(join(repo, "big.txt"), "v2\n".repeat(100));
    const projectId = seedProject(testDb.sqlite, { path: repo });

    const got = await runGitDiff(repo, {
      path: "big.txt",
      maxBytes: 16, // tiny so any diff overflows
      projectId,
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("git_patch_too_large");
    expect(got.size).toBeGreaterThan(16);
    expect(got.hint).toMatch(/git diff/);
    expect(got.hint).toMatch(/big\.txt/);
  });

  it("exposes a 5 MiB default cap via GIT_DIFF_MAX_BYTES", () => {
    expect(GIT_DIFF_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("writes a single audit row on success scoped to the project, action='diff'", async () => {
    const repo = join(tmpRoot, "audit-success");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "v1\n");
    await git.add("f.txt");
    await git.commit("init");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitDiff(repo, { path: "f.txt", projectId });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("diff");
    expect(row.reason).toBe("ok");
    expect(row.exitCode).toBe(0);
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({
      path: "f.txt",
      staged: false,
      has_base: false,
      has_head: false,
    });
  });

  it("writes an audit row on workspace scope when only workspaceId is provided", async () => {
    const repo = join(tmpRoot, "audit-ws");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "v1\n");
    await git.add("f.txt");
    await git.commit("init");
    const wsId = seedWorkspace(testDb.sqlite, {});

    await runGitDiff(repo, {
      path: "f.txt",
      staged: true,
      workspaceId: wsId,
    });

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("diff");
    expect(rows[0]!.projectId).toBeNull();
    const payload = JSON.parse(rows[0]!.argsJson);
    expect(payload.staged).toBe(true);
  });

  it("does NOT leak ref values into args_json — only summary flags", async () => {
    const repo = join(tmpRoot, "audit-no-leak");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "f.txt"), "v1\n");
    await git.add("f.txt");
    await git.commit("init");
    const baseSha = (await git.revparse(["HEAD"])).trim();
    writeFileSync(join(repo, "f.txt"), "v2\n");
    await git.add("f.txt");
    await git.commit("v2");
    const headSha = (await git.revparse(["HEAD"])).trim();
    const projectId = seedProject(testDb.sqlite, { path: repo });

    await runGitDiff(repo, {
      path: "secret/path.txt",
      base: baseSha,
      head: headSha,
      projectId,
    }).catch(() => undefined);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, projectId));
    const last = rows[rows.length - 1]!;
    const payload = JSON.parse(last.argsJson);
    expect(payload.has_base).toBe(true);
    expect(payload.has_head).toBe(true);
    // The path is preserved (forensic precedent: fs_audit_log.path), but
    // the SHAs are summarised — the audit row must not echo them back.
    expect(JSON.stringify(payload)).not.toContain(baseSha);
    expect(JSON.stringify(payload)).not.toContain(headSha);
  });
});
