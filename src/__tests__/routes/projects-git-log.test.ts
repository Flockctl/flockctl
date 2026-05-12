import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";

/**
 * End-to-end tests for `GET /projects/:id/git-log` and
 * `GET /workspaces/:id/git-log`. Same shape on both surfaces — they share
 * the `makeGitRouteHandlers` factory so we exercise the project mount in
 * detail and add one workspace happy-path test to confirm the attribution
 * scope flips correctly (workspace_id set, project_id NULL).
 *
 * Branches are pinned to `main` via `--initial-branch=main` for stability
 * across git versions whose `init.defaultBranch` differs.
 */

async function initRepo(path: string): Promise<SimpleGit> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

async function makeLinearCommits(
  git: SimpleGit,
  cwd: string,
  n: number,
): Promise<string[]> {
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(cwd, "f.txt"), `rev ${i}\n`);
    await git.add("f.txt");
    await git.commit(`c ${i}`);
    const sha = (await git.revparse(["HEAD"])).trim();
    shas.unshift(sha);
  }
  return shas;
}

describe("GET /projects/:id/git-log", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-log-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/9999999/git-log");
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-log`);
    expect(res.status).toBe(422);
  });

  it("returns 422 when limit is malformed (e.g. 'abc')", async () => {
    const repo = join(tmpRoot, "malformed-limit");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-log?limit=abc`);
    expect(res.status).toBe(422);
  });

  it("returns 422 when limit > 100", async () => {
    const repo = join(tmpRoot, "limit-too-big");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-log?limit=101`);
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:not_a_repo when the path is not a git repo", async () => {
    const projPath = join(tmpRoot, "no-git-here");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-log`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_repo");
  });

  it("returns ok:true with empty commits + null nextCursor for an empty repo", async () => {
    const repo = join(tmpRoot, "empty");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-log`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commits).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("happy path: returns the documented commit shape with a populated nextCursor", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await initRepo(repo);
    const shas = await makeLinearCommits(git, repo, 5);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-log?limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commits).toHaveLength(2);
    expect(body.commits.map((c: { sha: string }) => c.sha)).toEqual(
      shas.slice(0, 2),
    );
    expect(body.nextCursor).toBe(shas[2]);
    // Each commit row carries the documented fields.
    for (const c of body.commits) {
      expect(typeof c.sha).toBe("string");
      expect(c.shortSha).toBe(c.sha.slice(0, 7));
      expect(c.author).toBe("Test");
      expect(c.email).toBe("test@example.com");
      expect(typeof c.ts).toBe("number");
      expect(typeof c.subject).toBe("string");
      expect(Array.isArray(c.parents)).toBe(true);
    }
  });

  it("paginates: cursor from page1 walks the next page", async () => {
    const repo = join(tmpRoot, "page");
    const git = await initRepo(repo);
    const shas = await makeLinearCommits(git, repo, 5);
    const id = seedProject(testDb.sqlite, { path: repo });

    const r1 = await app.request(`/projects/${id}/git-log?limit=2`);
    const b1 = await r1.json();
    const r2 = await app.request(
      `/projects/${id}/git-log?limit=2&cursor=${b1.nextCursor}`,
    );
    const b2 = await r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.commits.map((c: { sha: string }) => c.sha)).toEqual(
      shas.slice(2, 4),
    );
    expect(b2.nextCursor).toBe(shas[4]);
  });

  it("rejects an invalid cursor with ok:false / reason:bad_revision", async () => {
    const repo = join(tmpRoot, "bad-cursor-route");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-log?cursor=not-hex-content`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad_revision");
  });

  it("rejects a leading-dash branch with ok:false / reason:bad_revision", async () => {
    const repo = join(tmpRoot, "bad-branch-route");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-log?branch=${encodeURIComponent("--upload-pack=foo")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad_revision");
  });

  it("writes one git_audit_log row per call, action='log', scoped to project_id", async () => {
    const repo = join(tmpRoot, "audit-project");
    const git = await initRepo(repo);
    await makeLinearCommits(git, repo, 1);
    const id = seedProject(testDb.sqlite, { path: repo });

    const before = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    const res = await app.request(`/projects/${id}/git-log?limit=10`);
    expect(res.status).toBe(200);
    const after = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(after.length).toBe(before.length + 1);
    const row = after[after.length - 1]!;
    expect(row.action).toBe("log");
    expect(row.workspaceId).toBeNull();
    expect(row.reason).toBe("ok");
    expect(JSON.parse(row.argsJson)).toEqual({
      limit: 10,
      has_cursor: false,
      has_branch: false,
    });
  });
});

describe("GET /workspaces/:id/git-log", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-log-ws-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("happy path on a workspace mount writes audit row with workspace_id (project_id NULL)", async () => {
    const repo = join(tmpRoot, "ws-happy");
    const git = await initRepo(repo);
    const shas = await makeLinearCommits(git, repo, 2);
    const id = seedWorkspace(testDb.sqlite, { path: repo });

    const res = await app.request(`/workspaces/${id}/git-log?limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commits.map((c: { sha: string }) => c.sha)).toEqual(shas);
    expect(body.nextCursor).toBeNull();

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("log");
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.workspaceId).toBe(id);
  });
});
