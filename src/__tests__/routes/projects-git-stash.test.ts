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
import simpleGit, { type SimpleGit } from "simple-git";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { runGitStashPush } from "../../services/git-operations.js";

/**
 * End-to-end tests for the four stash endpoints exposed on both the
 * project and workspace routers:
 *   - POST   /:id/git-stash-push
 *   - GET    /:id/git-stash-list
 *   - POST   /:id/git-stash-pop
 *   - DELETE /:id/git-stash/:ref
 *
 * Sibling of `projects-git-discard-fetch.test.ts` — same approach: spin
 * up real git repos in temp dirs so the routes exercise the full
 * pre-flight → service → audit-row pipeline against a live working tree.
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

async function seedBaseline(path: string): Promise<SimpleGit> {
  const git = await initRepo(path);
  writeFileSync(join(path, "a.txt"), "v1\n");
  await git.add("a.txt");
  await git.commit("init");
  return git;
}

describe("POST /projects/:id/git-stash-push", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-push-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-stash-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-stash-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 on unknown body fields (.strict() canary)", async () => {
    const repo = join(tmpRoot, "strict");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    // A future refactor that adds `--keep-index` etc. without updating the
    // schema must trip this canary BEFORE reaching the service.
    const res = await app.request(`/projects/${id}/git-stash-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepIndex: true }),
    });
    expect(res.status).toBe(422);
  });

  it("happy path: stashes a tracked-file edit and writes one audit row", async () => {
    const repo = join(tmpRoot, "happy");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reason).toBe("ok");
    expect(body.nothingToStash).toBe(false);
    // Working tree restored to committed state.
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("v1\n");
    // One stash entry created.
    expect((await git.stashList()).total).toBe(1);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_push");
    expect(rows[0]!.projectId).toBe(id);
    expect(rows[0]!.workspaceId).toBeNull();
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({
      has_message: false,
      include_untracked: false,
    });
  });

  it("nothing_to_stash: clean tree returns ok:true with reason='nothing_to_stash'", async () => {
    const repo = join(tmpRoot, "clean");
    await seedBaseline(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reason).toBe("nothing_to_stash");
    expect(body.nothingToStash).toBe(true);
  });

  it("includeUntracked + message: audit payload reflects flags, never message body", async () => {
    const repo = join(tmpRoot, "flags");
    await seedBaseline(repo);
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const secret = "in-flight-feature-name";
    const res = await app.request(`/projects/${id}/git-stash-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: secret, includeUntracked: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({
      has_message: true,
      include_untracked: true,
    });
    expect(rows[0]!.argsJson).not.toContain(secret);
  });

  it("workspace route variant attributes audit row to workspace_id", async () => {
    const repo = join(tmpRoot, "ws-push");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "v2");
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    const res = await app.request(`/workspaces/${wsId}/git-stash-push`, {
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
    expect(rows[0]!.workspaceId).toBe(wsId);
    expect(rows[0]!.projectId).toBeNull();
    expect(rows[0]!.action).toBe("stash_push");
  });
});

describe("GET /projects/:id/git-stash-list", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-list-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-stash-list");
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-stash-list`);
    expect(res.status).toBe(422);
  });

  it("empty stash returns ok:true with stashes:[]", async () => {
    const repo = join(tmpRoot, "empty");
    await seedBaseline(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-list`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stashes).toEqual([]);
  });

  it("happy path: returns ref/hash/date/message rows in LIFO order", async () => {
    const repo = join(tmpRoot, "happy");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "v2");
    await runGitStashPush(repo, { message: "first" });
    writeFileSync(join(repo, "a.txt"), "v3");
    await runGitStashPush(repo, { message: "second" });
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-list`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stashes).toHaveLength(2);
    expect(body.stashes[0].ref).toBe("stash@{0}");
    expect(body.stashes[1].ref).toBe("stash@{1}");
    expect(body.stashes[0].hash).toMatch(/^[0-9a-f]{40}$/);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    // One audit row from this list call (the two seed pushes were called
    // directly via runGitStashPush WITHOUT a projectId, so they wrote rows
    // with project_id=NULL — only the route-driven list call attributes).
    const listRows = rows.filter((r) => r.action === "stash_list");
    expect(listRows).toHaveLength(1);
  });
});

describe("POST /projects/:id/git-stash-pop", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-pop-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-stash-pop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "stash@{0}" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when body lacks ref", async () => {
    const repo = join(tmpRoot, "no-ref");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 on non-canonical ref form (route-layer regex)", async () => {
    const repo = join(tmpRoot, "bad-ref");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    // Bare integer doesn't match `^stash@\{\d+\}$` — caught at the route
    // layer before reaching the service. Same defence-in-depth pattern as
    // BRANCH_NAME / git-checkout.
    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "0" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 on unknown body fields (.strict() canary)", async () => {
    const repo = join(tmpRoot, "pop-strict");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "stash@{0}", force: true }),
    });
    expect(res.status).toBe(422);
  });

  it("happy path: pops stash@{0} and writes audit row", async () => {
    const repo = join(tmpRoot, "happy-pop");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "stash@{0}" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ref).toBe("stash@{0}");
    expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("MOD\n");
    expect((await git.stashList()).total).toBe(0);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_pop");
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ ref: "stash@{0}" });
  });

  it("conflict: returns ok:false / reason:git_stash_pop_conflict, stash kept", async () => {
    const repo = join(tmpRoot, "conflict");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "VARIANT-A\n");
    await runGitStashPush(repo, {});
    writeFileSync(join(repo, "a.txt"), "VARIANT-B\n");
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "stash@{0}" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("git_stash_pop_conflict");
    // Stash MUST still be on the stack — git keeps it on conflict so the
    // operator can resolve and drop deliberately.
    expect((await git.stashList()).total).toBe(1);
  });

  it("not_found: empty stash surfaces as not_found (NOT conflict)", async () => {
    const repo = join(tmpRoot, "empty-pop");
    await seedBaseline(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const res = await app.request(`/projects/${id}/git-stash-pop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "stash@{0}" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_found");
  });
});

describe("DELETE /projects/:id/git-stash/:ref", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-stash-drop-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    // Use URL-encoded ref so the wildcard route accepts it.
    const ref = encodeURIComponent("stash@{0}");
    const res = await app.request(`/projects/999999/git-stash/${ref}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when ref does not match the canonical regex", async () => {
    const repo = join(tmpRoot, "bad-ref");
    await initRepo(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    // `bare-int` is path-segment-decoded to the same string and rejected.
    const res = await app.request(
      `/projects/${id}/git-stash/${encodeURIComponent("0")}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(422);
  });

  it("happy path: drops stash@{0} (URL-encoded) and writes audit row", async () => {
    const repo = join(tmpRoot, "happy-drop");
    const git = await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const id = seedProject(testDb.sqlite, { path: repo });

    const ref = encodeURIComponent("stash@{0}");
    const res = await app.request(`/projects/${id}/git-stash/${ref}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ref).toBe("stash@{0}");
    expect((await git.stashList()).total).toBe(0);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("stash_drop");
    expect(JSON.parse(rows[0]!.argsJson)).toEqual({ ref: "stash@{0}" });
  });

  it("not_found: dropping out-of-range entry surfaces as not_found (HTTP 200)", async () => {
    const repo = join(tmpRoot, "drop-oob");
    await seedBaseline(repo);
    const id = seedProject(testDb.sqlite, { path: repo });

    const ref = encodeURIComponent("stash@{0}");
    const res = await app.request(`/projects/${id}/git-stash/${ref}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_found");
  });

  it("workspace route variant attributes audit row to workspace_id", async () => {
    const repo = join(tmpRoot, "ws-drop");
    await seedBaseline(repo);
    writeFileSync(join(repo, "a.txt"), "MOD\n");
    await runGitStashPush(repo, {});
    const wsId = seedWorkspace(testDb.sqlite, { path: repo });

    const ref = encodeURIComponent("stash@{0}");
    const res = await app.request(`/workspaces/${wsId}/git-stash/${ref}`, {
      method: "DELETE",
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
    expect(rows[0]!.action).toBe("stash_drop");
  });
});
