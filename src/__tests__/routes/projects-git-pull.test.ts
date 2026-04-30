import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { app } from "../../server.js";
import { setDb } from "../../db/index.js";
import { createTestDb, seedProject } from "../helpers.js";
import {
  classifyPullError,
  extractGitErrorMessage,
  runGitPull,
} from "../../services/git-operations.js";

/**
 * End-to-end tests for `POST /projects/:id/git-pull` and the underlying
 * `runGitPull()` service. These spin up real git repos in temp dirs (the
 * same approach `git-context.test.ts` takes) — mocking simple-git is
 * fragile and the entire value of this code is its interaction with real
 * git semantics (upstream tracking, fast-forward refusal, status
 * cleanliness), which a mock cannot validate.
 *
 * Branches are pinned to `main` via `init.defaultBranch=main` on every
 * `git init` so the suite is stable across git versions whose `init`
 * default differs (`master` on <2.28, `main` thereafter, configurable
 * via the user's global git config).
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

describe("POST /projects/:id/git-pull", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-pull-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-pull", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    // `seedProject` only takes string|undefined for path; omitting it
    // leaves the column NULL, which is exactly the scenario we want to
    // exercise here (project row has no on-disk location).
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:not_a_git_repo when project path is not a git repo", async () => {
    const projPath = join(tmpRoot, "not-a-repo");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_git_repo");
  });

  it("returns ok:false / reason:no_upstream for a freshly-init'd repo with no remote", async () => {
    const projPath = join(tmpRoot, "no-upstream");
    const git = await initRepo(projPath);
    writeFileSync(join(projPath, "README.md"), "hello");
    await git.add("README.md");
    await git.commit("init");

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_upstream");
    // The message must include the actual branch name and the recovery
    // hint — operators read this verbatim, so any phrasing regression is
    // a UX regression we want a test to catch.
    expect(body.message).toMatch(/branch 'main'/i);
    expect(body.message).toMatch(/git push -u origin main/);
  });

  it("returns ok:false / reason:dirty_working_tree when there are uncommitted changes", async () => {
    // Set up a clone so an upstream exists — otherwise we'd hit no_upstream
    // before the dirty-working-tree check.
    const remote = join(tmpRoot, "dirty.git");
    const seeder = join(tmpRoot, "dirty-seeder");
    const projPath = join(tmpRoot, "dirty-project");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projGit = simpleGit(projPath);
    await projGit.addConfig("user.email", "test@example.com");
    await projGit.addConfig("user.name", "Test");
    // Introduce an untracked file → working tree dirty.
    writeFileSync(join(projPath, "scratch.txt"), "wip");

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("dirty_working_tree");
    expect(body.message).toMatch(/uncommitted changes/i);
  });

  it("returns ok:true / alreadyUpToDate when remote has nothing new", async () => {
    const remote = join(tmpRoot, "uptodate.git");
    const seeder = join(tmpRoot, "uptodate-seeder");
    const projPath = join(tmpRoot, "uptodate-project");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projGit = simpleGit(projPath);
    await projGit.addConfig("user.email", "test@example.com");
    await projGit.addConfig("user.name", "Test");

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyUpToDate).toBe(true);
    expect(body.commitsPulled).toBe(0);
    expect(body.filesChanged).toBe(0);
    expect(body.branch).toBe("main");
    expect(body.summary).toMatch(/already up to date/i);
  });

  it("happy path: pulls a new commit from origin, reports counts", async () => {
    const remote = join(tmpRoot, "pull.git");
    const seeder = join(tmpRoot, "pull-seeder");
    const projPath = join(tmpRoot, "pull-project");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projGit = simpleGit(projPath);
    await projGit.addConfig("user.email", "test@example.com");
    await projGit.addConfig("user.name", "Test");

    // Push a new commit to the remote *via the seeder* — the project
    // clone is now one commit behind origin/main.
    writeFileSync(join(seeder, "a.txt"), "2");
    writeFileSync(join(seeder, "b.txt"), "new");
    await seederGit.add(["a.txt", "b.txt"]);
    await seederGit.commit("update");
    await seederGit.push("origin", "main");

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyUpToDate).toBe(false);
    expect(body.commitsPulled).toBe(1);
    expect(body.filesChanged).toBe(2);
    expect(body.branch).toBe("main");
    expect(body.summary).toMatch(/pulled 1 commit, 2 files changed/i);
    // SHAs must differ — sanity-check the before/after snapshot.
    expect(body.beforeSha).not.toBe(body.afterSha);
    expect(body.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.afterSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns ok:false / reason:non_fast_forward when local and remote diverge", async () => {
    const remote = join(tmpRoot, "diverge.git");
    const seeder = join(tmpRoot, "diverge-seeder");
    const projPath = join(tmpRoot, "diverge-project");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projGit = simpleGit(projPath);
    await projGit.addConfig("user.email", "test@example.com");
    await projGit.addConfig("user.name", "Test");

    // Diverge: remote gets one commit, local gets a different one.
    writeFileSync(join(seeder, "remote.txt"), "remote");
    await seederGit.add("remote.txt");
    await seederGit.commit("remote-only");
    await seederGit.push("origin", "main");

    writeFileSync(join(projPath, "local.txt"), "local");
    await projGit.add("local.txt");
    await projGit.commit("local-only");
    // Local working tree is now CLEAN but HEAD has a commit not on origin,
    // and origin has a commit not on local — `pull --ff-only` must refuse.

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-pull`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("non_fast_forward");
    expect(typeof body.stderr).toBe("string");
  });
});

// ─── Service-level direct tests ────────────────────────────────────────────
//
// The route-level suite above pins the HTTP contract; these pin the
// service contract. Splitting the two means a future refactor that
// e.g. moves `runGitPull` behind a different transport (queued job,
// CLI command, mission proposal preview) can keep the service tests
// unchanged and re-target only the wire tests.

describe("runGitPull (service-level)", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-pull-svc-"));
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns not_a_git_repo when the project path does not exist on disk at all", async () => {
    // Distinct from "path exists but no .git/" — exercises the first half
    // of the existsSync(projectPath) || existsSync(.git) compound check.
    const ghost = join(tmpRoot, "never-created");
    const result = await runGitPull(ghost);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_a_git_repo");
      expect(result.message).toMatch(/not a git repository/i);
    }
  });

  it("returns a structured success directly (no HTTP layer)", async () => {
    const remote = join(tmpRoot, "svc-direct.git");
    const seeder = join(tmpRoot, "svc-direct-seeder");
    const projPath = join(tmpRoot, "svc-direct-proj");

    await initBareRepo(remote);
    const seederGit = await initRepo(seeder);
    writeFileSync(join(seeder, "a.txt"), "1");
    await seederGit.add("a.txt");
    await seederGit.commit("init");
    await seederGit.addRemote("origin", remote);
    await seederGit.push("origin", "main");

    await simpleGit().clone(remote, projPath);
    const projGit = simpleGit(projPath);
    await projGit.addConfig("user.email", "test@example.com");
    await projGit.addConfig("user.name", "Test");

    const result = await runGitPull(projPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Direct service call must produce identical shape to the wire
      // response — same field names, no snake_case translation. This
      // guards against a refactor that accidentally renames fields on
      // one side but not the other.
      expect(result.alreadyUpToDate).toBe(true);
      expect(result.branch).toBe("main");
      expect(result.commitsPulled).toBe(0);
      expect(result.filesChanged).toBe(0);
      expect(result.summary).toMatch(/already up to date/i);
      expect(result.beforeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.afterSha).toBe(result.beforeSha);
    }
  });
});

describe("classifyPullError", () => {
  it("recognises non-fast-forward stderr from git --ff-only", () => {
    expect(
      classifyPullError("fatal: Not possible to fast-forward, aborting."),
    ).toBe("non_fast_forward");
    expect(classifyPullError("hint: divergent branches; refusing to merge")).toBe(
      "non_fast_forward",
    );
    expect(classifyPullError("fatal: refusing to merge unrelated histories")).toBe(
      "non_fast_forward",
    );
  });

  it("recognises auth failures across SSH and HTTPS shapes", () => {
    expect(classifyPullError("Permission denied (publickey).")).toBe("auth_failed");
    expect(
      classifyPullError("remote: HTTP Basic: Access denied\nfatal: Authentication failed"),
    ).toBe("auth_failed");
    expect(
      classifyPullError("fatal: could not read Username for 'https://github.com'"),
    ).toBe("auth_failed");
    expect(classifyPullError("Host key verification failed.")).toBe("auth_failed");
    expect(classifyPullError("remote: 403\nfatal: unable to access")).toBe(
      "auth_failed",
    );
  });

  it("recognises network errors", () => {
    expect(
      classifyPullError("fatal: unable to access 'https://x.test/': Could not resolve host: x.test"),
    ).toBe("network_error");
    expect(classifyPullError("ssh: connect to host x port 22: Connection refused")).toBe(
      "network_error",
    );
    expect(classifyPullError("Operation timed out")).toBe("network_error");
  });

  it("falls back to 'unknown' for unrecognised stderr", () => {
    expect(classifyPullError("fatal: some weird new git error")).toBe("unknown");
    expect(classifyPullError("")).toBe("unknown");
  });
});

describe("extractGitErrorMessage", () => {
  it("returns the first fatal: line", () => {
    expect(
      extractGitErrorMessage("hint: blah\nfatal: bad thing\nmore noise"),
    ).toBe("fatal: bad thing");
  });

  it("returns the first error: line when no fatal: present", () => {
    expect(extractGitErrorMessage("warning: foo\nerror: thing\nbar")).toBe(
      "error: thing",
    );
  });

  it("falls back to the first non-empty line", () => {
    expect(extractGitErrorMessage("\n  some message\n")).toBe("some message");
  });

  it("returns null on empty stderr", () => {
    expect(extractGitErrorMessage("")).toBeNull();
    expect(extractGitErrorMessage("\n\n\n")).toBeNull();
  });
});
