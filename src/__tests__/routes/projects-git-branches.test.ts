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
 * Route-level tests for the three branch endpoints. Same factory as the
 * service tests, but exercised through `app.request(...)` so we lock in:
 *
 *   - HTTP-200-with-discriminated-body shape (errors NEVER come back as 4xx
 *     when the operation reached git — the body's `ok` is the source of truth).
 *   - 404 / 422 only fire BEFORE git ran (missing entity, missing path,
 *     malformed body, malformed branch name).
 *   - Audit-row attribution flips correctly between the project and
 *     workspace mounts (project_id vs workspace_id).
 *
 * Branches pinned to `main` for stability across git versions.
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

describe("GET /projects/:id/git-branches", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-branches-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/9999999/git-branches");
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-branches`);
    expect(res.status).toBe(422);
  });

  it("returns 200 with ok:true and the local branch list", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-branches`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.detached).toBe(false);
    const local = body.branches.filter((b: { isRemote: boolean }) => !b.isRemote);
    const names = local.map((b: { name: string }) => b.name).sort();
    expect(names).toEqual(["feature", "main"]);
    const main = local.find((b: { name: string }) => b.name === "main");
    expect(main.current).toBe(true);
  });

  it("workspace mount writes an audit row scoped to workspace_id (project_id NULL)", async () => {
    const repo = join(tmpRoot, "ws-audit");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedWorkspace(testDb.sqlite, { path: repo });

    const res = await app.request(`/workspaces/${id}/git-branches`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("branch_list");
    expect(rows[0]!.projectId).toBeNull();
  });
});

describe("POST /projects/:id/git-checkout", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-checkout-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/9999999/git-checkout", {
      method: "POST",
      body: JSON.stringify({ branch: "main" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when body is empty (missing required `branch`)", async () => {
    const repo = join(tmpRoot, "empty-body");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when branch contains shell metacharacters", async () => {
    const repo = join(tmpRoot, "bad-name");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({ branch: "feature; rm -rf /" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when body has unknown fields (.strict() canary)", async () => {
    const repo = join(tmpRoot, "strict-body");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({ branch: "main", forceCreate: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
  });

  it("happy path: switches to an existing branch and writes an audit row", async () => {
    const repo = join(tmpRoot, "happy-checkout");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({ branch: "feature" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.branch).toBe("feature");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("checkout");
    expect(last.workspaceId).toBeNull();
  });

  it("create=true creates a new branch and reports created:true", async () => {
    const repo = join(tmpRoot, "happy-create");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({ branch: "topic", create: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
  });

  it("dirty tree: returns ok:false / reason:dirty_working_tree (not 4xx)", async () => {
    const repo = join(tmpRoot, "dirty");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature");
    await git.checkout("main");
    writeFileSync(join(repo, "scratch.txt"), "oops");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-checkout`, {
      method: "POST",
      body: JSON.stringify({ branch: "feature" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("dirty_working_tree");
  });
});

describe("DELETE /projects/:id/git-branches/:name", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-bdel-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/9999999/git-branches/feature", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when the URL-decoded :name fails the BRANCH_NAME regex", async () => {
    const repo = join(tmpRoot, "bad-name-url");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    // `feature; rm -rf /` URL-encoded contains characters outside the
    // public regex (semicolon, space). The handler re-validates the
    // decoded value.
    const res = await app.request(
      `/projects/${id}/git-branches/${encodeURIComponent("feature; rm -rf /")}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(422);
  });

  it("happy path: deletes a merged feature branch and writes a single audit row", async () => {
    const repo = join(tmpRoot, "happy-delete");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("merged");
    await git.checkout("main");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-branches/merged`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    const last = rows[rows.length - 1]!;
    expect(last.action).toBe("branch_delete");
    expect(JSON.parse(last.argsJson)).toEqual({ branch: "merged", force: false });
  });

  it("supports slash-bearing branch names via the :name{.+} wildcard", async () => {
    const repo = join(tmpRoot, "slash-name");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("feature/foo");
    await git.checkout("main");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-branches/feature/foo`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.branch).toBe("feature/foo");
  });

  it("refuses 'main' without force=true (git_protected_branch) and writes NO audit row", async () => {
    const repo = join(tmpRoot, "protected");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    const id = seedProject(testDb.sqlite, { path: repo });

    const before = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));

    const res = await app.request(`/projects/${id}/git-branches/main`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("git_protected_branch");

    const after = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(after.length).toBe(before.length);
  });

  it("returns 422 when body is malformed JSON with unknown fields (.strict() canary)", async () => {
    const repo = join(tmpRoot, "strict-delete-body");
    const git = await initRepo(repo);
    await commitOne(git, repo, "x");
    await git.checkoutLocalBranch("merged");
    await git.checkout("main");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-branches/merged`, {
      method: "DELETE",
      body: JSON.stringify({ force: false, hard: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
  });
});
