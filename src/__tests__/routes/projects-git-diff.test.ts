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
 * End-to-end tests for `GET /projects/:id/git-diff` and
 * `GET /workspaces/:id/git-diff`. Both surfaces share the
 * `makeGitRouteHandlers` factory so we exercise the project mount in detail
 * and add one workspace happy-path test to confirm the attribution scope
 * flips correctly (workspace_id set, project_id NULL).
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

async function commitInitial(
  git: SimpleGit,
  cwd: string,
  filename = "f.txt",
  content = "v1\n",
): Promise<string> {
  writeFileSync(join(cwd, filename), content);
  await git.add(filename);
  await git.commit("init");
  return (await git.revparse(["HEAD"])).trim();
}

describe("GET /projects/:id/git-diff", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-diff-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/9999999/git-diff?path=f.txt");
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-diff?path=f.txt`);
    expect(res.status).toBe(422);
  });

  it("returns 422 when the path query parameter is missing", async () => {
    const repo = join(tmpRoot, "no-path-q");
    const git = await initRepo(repo);
    await commitInitial(git, repo);
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-diff`);
    expect(res.status).toBe(422);
  });

  it("returns 422 when staged is malformed", async () => {
    const repo = join(tmpRoot, "bad-staged");
    const git = await initRepo(repo);
    await commitInitial(git, repo);
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(
      `/projects/${id}/git-diff?path=f.txt&staged=yesplease`,
    );
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:not_a_repo when the path is not a git repo", async () => {
    const projPath = join(tmpRoot, "no-git-here");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-diff?path=f.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_repo");
  });

  it("happy path (working tree): returns ok:true with status:'M' and a unified diff", async () => {
    const repo = join(tmpRoot, "happy-working");
    const git = await initRepo(repo);
    await commitInitial(git, repo, "f.txt", "v1\n");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-diff?path=f.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("M");
    expect(body.patch).toMatch(/^diff --git/m);
    expect(body.patch).toMatch(/-v1/);
    expect(body.patch).toMatch(/\+v2/);
    expect(body.base).toBeNull();
    expect(body.head).toBeNull();
    expect(body.size).toBe(body.patch.length);
  });

  it("staged mode: ?staged=true returns the index-vs-HEAD diff", async () => {
    const repo = join(tmpRoot, "happy-staged");
    const git = await initRepo(repo);
    await commitInitial(git, repo, "f.txt", "v1\n");
    writeFileSync(join(repo, "f.txt"), "staged-v2\n");
    await git.add("f.txt");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-diff?path=f.txt&staged=true`,
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("M");
    expect(body.patch).toMatch(/staged-v2/);
  });

  it("between-refs mode: returns the diff between two refs and echoes them back", async () => {
    const repo = join(tmpRoot, "happy-between");
    const git = await initRepo(repo);
    const baseSha = await commitInitial(git, repo, "f.txt", "v1\n");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    await git.add("f.txt");
    await git.commit("v2");
    const headSha = (await git.revparse(["HEAD"])).trim();
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-diff?path=f.txt&base=${baseSha}&head=${headSha}`,
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("M");
    expect(body.base).toBe(baseSha);
    expect(body.head).toBe(headSha);
    expect(body.patch).toMatch(/-v1/);
    expect(body.patch).toMatch(/\+v2/);
  });

  it("rejects a leading-dash path with ok:false / reason:bad_revision", async () => {
    const repo = join(tmpRoot, "dash-path-route");
    const git = await initRepo(repo);
    await commitInitial(git, repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-diff?path=${encodeURIComponent("--upload-pack=foo")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad_revision");
  });

  it("returns ok:true / status:'unchanged' when path has no diff", async () => {
    const repo = join(tmpRoot, "unchanged-route");
    const git = await initRepo(repo);
    await commitInitial(git, repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-diff?path=f.txt`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("unchanged");
    expect(body.patch).toBe("");
  });

  it("writes one git_audit_log row per call, action='diff', scoped to project_id", async () => {
    const repo = join(tmpRoot, "audit-project");
    const git = await initRepo(repo);
    await commitInitial(git, repo, "f.txt", "v1\n");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const before = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    const res = await app.request(`/projects/${id}/git-diff?path=f.txt`);
    expect(res.status).toBe(200);
    const after = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(after.length).toBe(before.length + 1);
    const row = after[after.length - 1]!;
    expect(row.action).toBe("diff");
    expect(row.workspaceId).toBeNull();
    expect(row.reason).toBe("ok");
    const payload = JSON.parse(row.argsJson);
    expect(payload).toEqual({
      path: "f.txt",
      staged: false,
      has_base: false,
      has_head: false,
    });
  });
});

describe("GET /workspaces/:id/git-diff", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-diff-ws-route-"));

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
    await commitInitial(git, repo, "f.txt", "v1\n");
    writeFileSync(join(repo, "f.txt"), "v2\n");
    const id = seedWorkspace(testDb.sqlite, { path: repo });

    const res = await app.request(`/workspaces/${id}/git-diff?path=f.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("M");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("diff");
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.workspaceId).toBe(id);
  });
});
