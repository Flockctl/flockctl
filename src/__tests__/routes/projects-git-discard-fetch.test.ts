import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";

/**
 * End-to-end tests for `POST /projects/:id/git-discard`,
 * `POST /workspaces/:id/git-discard`, `POST /projects/:id/git-fetch`, and
 * `POST /workspaces/:id/git-fetch`. Sibling of `projects-git-pull.test.ts`
 * — the same approach: spin up real git repos in temp dirs (with paired
 * bare-repo "remotes" wired via `addRemote("origin", …)`) so the routes
 * exercise the full pre-flight → service → audit-row pipeline against
 * a live working tree.
 *
 * Branches are pinned to `main` via `--initial-branch=main` so the suite
 * is stable across git versions whose `init` default differs.
 */

async function initRepo(path: string) {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  return git;
}

async function initBareRepo(path: string) {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--bare", "--initial-branch=main"]);
  return git;
}

describe("POST /projects/:id/git-discard", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-discard-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-discard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when body is missing paths", async () => {
    const repo = join(tmpRoot, "missing-paths");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when paths is empty", async () => {
    const repo = join(tmpRoot, "empty-paths-route");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects unknown body fields (.strict() canary)", async () => {
    // Future refactor that accidentally adds a `force` or `recursive` field
    // gets caught by .strict() on the body schema before the request even
    // reaches the service layer.
    const repo = join(tmpRoot, "strict-canary");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["a.txt"], force: true }),
    });
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:invalid_path for absolute paths in body", async () => {
    const repo = join(tmpRoot, "abs-path-route");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["/etc/passwd"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid_path");
  });

  it("happy path: reverts a tracked file and writes one audit row", async () => {
    const repo = join(tmpRoot, "happy-route");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "v1\n");
    await git.add("a.txt");
    await git.commit("init");
    writeFileSync(join(repo, "a.txt"), "MOD\n");

    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.filesDiscarded).toBe(1);
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("v1\n");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("discard");
    expect(rows[0]!.projectId).toBe(id);
    expect(rows[0]!.workspaceId).toBeNull();
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ paths_count: 1 });
  });

  it("workspace route variant attributes the audit row to workspace_id", async () => {
    const repo = join(tmpRoot, "ws-discard");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "v1");
    await git.add("a.txt");
    await git.commit("init");
    writeFileSync(join(repo, "a.txt"), "v2");

    const wsId = seedWorkspace(testDb.sqlite, { path: repo });
    const res = await app.request(`/workspaces/${wsId}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["a.txt"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.action).toBe("discard");
  });

  it("reports unknown_path when an entry isn't tracked", async () => {
    const repo = join(tmpRoot, "unknown-route");
    const git = await initRepo(repo);
    writeFileSync(join(repo, "tracked.txt"), "x");
    await git.add("tracked.txt");
    await git.commit("init");
    writeFileSync(join(repo, "untracked.txt"), "y");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["untracked.txt"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unknown_path");
  });
});

describe("POST /projects/:id/git-fetch", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-fetch-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 on unknown body fields (.strict() canary)", async () => {
    const repo = join(tmpRoot, "fetch-strict");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "origin", all: true }),
    });
    expect(res.status).toBe(422);
  });

  it("happy path: fetches from origin (default), records action='fetch'", async () => {
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
    // Empty body → defaults to remote='origin'.
    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.remote).toBe("origin");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("fetch");
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ remote: "origin" });
  });

  it("returns ok:false / reason:invalid_remote for a leading-dash remote", async () => {
    const repo = join(tmpRoot, "fetch-bad-remote");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "--upload-pack=foo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid_remote");
  });

  it("network_error: classifies an unresolvable remote", async () => {
    const projPath = join(tmpRoot, "fetch-network-fail");
    const git = await initRepo(projPath);
    writeFileSync(join(projPath, "a.txt"), "1");
    await git.add("a.txt");
    await git.commit("init");
    await git.addRemote(
      "origin",
      "https://this.host.does.not.exist.invalid/repo.git",
    );

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Either DNS-resolver failure (network_error) or a host-replied-with-403
    // edge case (auth_failed) — we pin "not ok and reason in {network_error,
    // auth_failed, unknown}" so the test is stable across resolver configs.
    expect(["network_error", "auth_failed", "unknown"]).toContain(body.reason);
  });

  it("workspace route variant attributes the audit row to workspace_id", async () => {
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

    const wsId = seedWorkspace(testDb.sqlite, { path: projPath });
    const res = await app.request(`/workspaces/${wsId}/git-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("fetch");
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
  });
});
