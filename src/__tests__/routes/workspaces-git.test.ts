import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { eq, and, isNull } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedWorkspace } from "../helpers.js";
import { __pushTestHooks } from "../../services/git-operations.js";

/**
 * End-to-end tests for the workspace-scoped git routes mounted in
 * `routes/workspaces.ts` via `makeGitRouteHandlers`. Sibling of the project
 * variant (`projects-git-pull.test.ts` etc.) — same approach: real git
 * repos in temp dirs, full HTTP surface, no simple-git mocking except for
 * the network seam (`__pushTestHooks.executeRaw`) on push.
 *
 * The `all_three_workspace_routes_omit_project_id_in_audit_row` test pins
 * the audit-row contract every workspace mount must satisfy: each call
 * writes exactly one `git_audit_log` row keyed on `workspace_id` only,
 * with `project_id IS NULL`. The `git_audit_log_scope_check` constraint
 * requires at least one of the two to be set, and the per-side recency
 * indexes assume the asymmetry — see migration 0046.
 */

async function initRepo(path: string, branch = "main") {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init([`--initial-branch=${branch}`]);
  await git.addConfig("user.email", "test@flockctl.local");
  await git.addConfig("user.name", "Flockctl Test");
  return git;
}

async function initBareRepo(path: string, branch = "main") {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--bare", `--initial-branch=${branch}`]);
  return git;
}

describe("workspace-scoped git routes (POST /workspaces/:id/git-{pull,commit,push})", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-ws-git-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── 4xx-shape errors (entity / body validation) ───────────────────────

  it("git-pull returns 404 when workspace does not exist", async () => {
    const res = await app.request("/workspaces/999999/git-pull", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("git-commit returns 404 when workspace does not exist", async () => {
    const res = await app.request("/workspaces/999999/git-commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "anything" }),
    });
    expect(res.status).toBe(404);
  });

  it("git-push returns 404 when workspace does not exist", async () => {
    const res = await app.request("/workspaces/999999/git-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  // The factory's `requirePath` guard fires when the entity row's `path`
  // is falsy. The schema enforces NOT NULL, so the only way to exercise
  // the 422 branch end-to-end is to UPDATE the row to an empty string
  // post-insert — which still satisfies the column NOT NULL constraint
  // but is falsy in JS. Pinning the guard at the wire keeps the
  // `<resourceLabel> has no path` message symmetric with the project
  // variant ("Project has no path —" vs "Workspace has no path —").
  it("git-pull returns 422 when workspace has empty path", async () => {
    const wsId = seedWorkspace(testDb.sqlite, {});
    testDb.sqlite
      .prepare(`UPDATE workspaces SET path = '' WHERE id = ?`)
      .run(wsId);
    const res = await app.request(`/workspaces/${wsId}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  // ─── Pre-flight error paths (HTTP 200, ok:false body) ──────────────────

  it("git-pull returns ok:false / reason:not_a_git_repo when workspace path is not a git repo", async () => {
    const wsPath = join(tmpRoot, "ws-not-a-repo");
    mkdirSync(wsPath, { recursive: true });
    const wsId = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await app.request(`/workspaces/${wsId}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_git_repo");
  });

  it("git-commit returns ok:false / reason:empty_index when working tree is clean", async () => {
    const wsPath = join(tmpRoot, "ws-clean");
    const git = await initRepo(wsPath);
    writeFileSync(join(wsPath, "seed.txt"), "seed\n");
    await git.add(["seed.txt"]);
    await git.commit("seed");
    const wsId = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await app.request(`/workspaces/${wsId}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nothing to commit" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_index");
  });

  it("git-push returns 422 when body contains unknown fields like { all: true }", async () => {
    const wsPath = join(tmpRoot, "ws-strict-all");
    const bare = join(tmpRoot, "ws-strict-all.git");
    await initBareRepo(bare);
    const git = await initRepo(wsPath);
    writeFileSync(join(wsPath, "seed.txt"), "seed\n");
    await git.add(["seed.txt"]);
    await git.commit("seed");
    await git.addRemote("origin", bare);
    await git.push(["-u", "origin", "main"]);
    const wsId = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await app.request(`/workspaces/${wsId}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(422);
  });

  // ─── Audit-row contract — the headline test the slice spec calls out ──

  it("all_three_workspace_routes_omit_project_id_in_audit_row", async () => {
    // Independent workspace per directional check so the per-action audit
    // assertion can be scoped to one workspace_id at a time without
    // leaking rows from earlier subtests in this describe block.
    //
    // ── Pull ─────────────────────────────────────────────────────────────
    const pullRemote = join(tmpRoot, "audit-pull.git");
    const pullSeeder = join(tmpRoot, "audit-pull-seeder");
    const pullRepo = join(tmpRoot, "audit-pull-ws");

    await initBareRepo(pullRemote);
    const seederGit = await initRepo(pullSeeder);
    writeFileSync(join(pullSeeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", pullRemote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(pullRemote, pullRepo);
    const pullRepoGit = simpleGit(pullRepo);
    await pullRepoGit.addConfig("user.email", "test@example.com");
    await pullRepoGit.addConfig("user.name", "Test");

    const pullWsId = seedWorkspace(testDb.sqlite, { path: pullRepo });
    const pullRes = await app.request(`/workspaces/${pullWsId}/git-pull`, {
      method: "POST",
    });
    expect(pullRes.status).toBe(200);
    const pullRows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(
        and(
          eq(gitAuditLog.workspaceId, pullWsId),
          isNull(gitAuditLog.projectId),
        ),
      );
    expect(pullRows).toHaveLength(1);
    expect(pullRows[0]!.action).toBe("pull");
    expect(pullRows[0]!.projectId).toBeNull();
    expect(pullRows[0]!.workspaceId).toBe(pullWsId);

    // ── Commit ──────────────────────────────────────────────────────────
    const commitRepo = join(tmpRoot, "audit-commit-ws");
    const commitGit = await initRepo(commitRepo);
    // Initial commit so HEAD exists; runGitCommit's pre-flight reads
    // `git status` against a working tree with a HEAD.
    writeFileSync(join(commitRepo, "seed.txt"), "seed\n");
    await commitGit.add(["seed.txt"]);
    await commitGit.commit("seed");
    // New file to actually commit on the route invocation.
    writeFileSync(join(commitRepo, "tracked.txt"), "value\n");
    const commitWsId = seedWorkspace(testDb.sqlite, { path: commitRepo });

    const commitRes = await app.request(`/workspaces/${commitWsId}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: add tracked" }),
    });
    expect(commitRes.status).toBe(200);
    const commitBody = await commitRes.json();
    expect(commitBody.ok).toBe(true);

    const commitRows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(
        and(
          eq(gitAuditLog.workspaceId, commitWsId),
          isNull(gitAuditLog.projectId),
        ),
      );
    expect(commitRows).toHaveLength(1);
    expect(commitRows[0]!.action).toBe("commit");
    expect(commitRows[0]!.projectId).toBeNull();
    expect(commitRows[0]!.workspaceId).toBe(commitWsId);
    expect(commitRows[0]!.reason).toBe("ok");

    // ── Push ────────────────────────────────────────────────────────────
    const pushRepo = join(tmpRoot, "audit-push-ws");
    const pushBare = join(tmpRoot, "audit-push-ws.git");
    await initBareRepo(pushBare, "feature");
    const pushGit = await initRepo(pushRepo, "feature");
    writeFileSync(join(pushRepo, "seed.txt"), "seed\n");
    await pushGit.add(["seed.txt"]);
    await pushGit.commit("seed");
    await pushGit.addRemote("origin", pushBare);
    await pushGit.push(["-u", "origin", "feature"]);
    const pushWsId = seedWorkspace(testDb.sqlite, { path: pushRepo });

    // Stub the network seam so the test doesn't depend on an actual push
    // landing — the audit row write happens regardless of whether the
    // network call succeeded or failed (per `runGitCommand`'s contract).
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({ stdout: "", stderr: "Everything up-to-date\n" });
    try {
      const pushRes = await app.request(`/workspaces/${pushWsId}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(pushRes.status).toBe(200);
      const pushBody = await pushRes.json();
      expect(pushBody.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }

    const pushRows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(
        and(
          eq(gitAuditLog.workspaceId, pushWsId),
          isNull(gitAuditLog.projectId),
        ),
      );
    expect(pushRows).toHaveLength(1);
    expect(pushRows[0]!.action).toBe("push");
    expect(pushRows[0]!.projectId).toBeNull();
    expect(pushRows[0]!.workspaceId).toBe(pushWsId);
  });
});
