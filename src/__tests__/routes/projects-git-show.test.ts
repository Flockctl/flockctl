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
 * End-to-end tests for `GET /projects/:id/git-show` and
 * `GET /workspaces/:id/git-show`. Same shape on both surfaces — they
 * share the `makeGitRouteHandlers` factory so we exercise the project
 * mount in detail and add one workspace happy-path test to confirm the
 * attribution scope flips correctly (workspace_id set, project_id NULL).
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
  await git.commit("init commit");
  return (await git.revparse(["HEAD"])).trim();
}

describe("GET /projects/:id/git-show", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-show-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request(
      "/projects/9999999/git-show?sha=abcdef0123456789abcdef0123456789abcdef01",
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(
      `/projects/${id}/git-show?sha=abcdef0123456789abcdef0123456789abcdef01`,
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when sha is missing", async () => {
    const repo = join(tmpRoot, "missing-sha-arg");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-show`);
    expect(res.status).toBe(422);
  });

  it("returns 422 when sha is shorter than 7 chars", async () => {
    const repo = join(tmpRoot, "short-sha-arg");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-show?sha=abcd`);
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:not_a_repo when the path is not a git repo", async () => {
    const projPath = join(tmpRoot, "no-git-here");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/git-show?sha=abcdef0123456789abcdef0123456789abcdef01`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_repo");
  });

  it("happy path: returns the documented commit + files shape for a single-file commit", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await initRepo(repo);
    const sha = await commitInitial(git, repo, "hello.txt", "hello\nworld\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-show?sha=${sha}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.commit).toBeDefined();
    expect(body.commit.sha).toBe(sha);
    expect(body.commit.parents).toEqual([]);
    expect(body.commit.author).toBe("Test");
    expect(typeof body.commit.ts).toBe("number");
    expect(body.commit.message).toBe("init commit");

    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      path: "hello.txt",
      status: "A",
      added: 2,
      removed: 0,
    });
  });

  it("workspace-scoped happy path attributes the audit row to workspace_id (project_id NULL)", async () => {
    const repo = join(tmpRoot, "ws-happy");
    const git = await initRepo(repo);
    const sha = await commitInitial(git, repo, "f.txt", "x");
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    const res = await app.request(`/workspaces/${wsId}/git-show?sha=${sha}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("show");
    expect(last.projectId).toBeNull();
  });

  it("classifies an unknown SHA as bad_revision (200 + ok:false)", async () => {
    const repo = join(tmpRoot, "bad-rev");
    const git = await initRepo(repo);
    await commitInitial(git, repo, "f.txt", "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(
      `/projects/${id}/git-show?sha=0000000000000000000000000000000000000000`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad_revision");
  });
});
