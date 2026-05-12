import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject } from "../helpers.js";
import { __pushTestHooks } from "../../services/git-operations.js";

/**
 * End-to-end tests for `POST /projects/:id/git-push`. Sibling of
 * `projects-git-pull.test.ts` and `projects-git-commit.test.ts` — the same
 * approach: spin up real git repos in temp dirs (with a paired bare-repo
 * "remote" wired via `addRemote("origin", …)`) so the route exercises the
 * full pre-flight → argv-build → audit-row pipeline against a live working
 * tree. Network-side failure modes (auth_failed, rejected_non_fast_forward)
 * are simulated by spying on `__pushTestHooks.executeRaw` and rejecting with
 * the literal stderr strings the brief calls out — mocking simple-git
 * wholesale is fragile, but stubbing the single network seam is precise.
 *
 * Branches are pinned via `--initial-branch=…` on every `git init` so the
 * suite is stable across git versions whose `init` default differs (`master`
 * on <2.28, `main` thereafter, configurable via the user's global git config).
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

/**
 * Set up a project repo wired to a local bare-repo "remote" via `origin`,
 * with a single seed commit pushed and the upstream link in place. Returns
 * paths so individual tests can layer additional commits on top.
 */
async function setupRepoWithRemote(opts: {
  tmpRoot: string;
  name: string;
  branch?: string;
  pushInitialCommit?: boolean;
}): Promise<{ repo: string; bare: string; git: ReturnType<typeof simpleGit> }> {
  const branch = opts.branch ?? "main";
  const repo = join(opts.tmpRoot, opts.name);
  const bare = join(opts.tmpRoot, `${opts.name}.git`);
  await initBareRepo(bare, branch);
  const git = await initRepo(repo, branch);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  await git.add(["seed.txt"]);
  await git.commit("seed");
  await git.addRemote("origin", bare);
  if (opts.pushInitialCommit !== false) {
    await git.push(["-u", "origin", branch]);
  }
  return { repo, bare, git };
}

describe("POST /projects/:id/git-push", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-push-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── 4xx-shape errors (project / body validation) ──────────────────────

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    // `seedProject` leaves the column NULL when path is omitted, exercising
    // the "Project has no path" guard before runGitPush is even invoked.
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  // The strict-schema canary. A future refactor that drops `.strict()` would
  // silently let `{ all: true }` (or any other unknown / dangerous field)
  // flow into the service. The service itself defends against this via
  // `buildPushArgs`, but we want validation to fail fast at the wire.
  it("returns 422 when body contains unknown fields like { all: true }", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "strict-all",
    });
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when body contains other unknown fields like { mirror: true }", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "strict-mirror",
    });
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mirror: true }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when remote is empty string (min(1))", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "empty-remote",
    });
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when remote exceeds max(100)", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "long-remote",
    });
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote: "x".repeat(101) }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when force is non-boolean", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "wrong-force-type",
    });
    const id = seedProject(testDb.sqlite, { path: repo });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: "yes" }),
    });
    expect(res.status).toBe(422);
  });

  // Empty body / no body should be accepted — the schema's three fields are
  // all optional and the service defaults to origin / setUpstream:false /
  // force:false. The push will fail downstream (real network), but the wire
  // contract is "empty POST is well-formed".
  it("accepts empty body { } as well-formed (defaults applied downstream)", async () => {
    // Wire the upstream so we get past the no_upstream check and reach the
    // network seam — which we then stub out so the test doesn't depend on
    // a real push working.
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "empty-body-ok",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({ stdout: "", stderr: "Everything up-to-date\n" });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.branch).toBe("feature");
      expect(body.remote).toBe("origin");
      expect(body.updated).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // ─── Pre-flight error paths (HTTP 200, ok:false body) ──────────────────

  it("returns ok:false / reason:not_a_repo when project path is not a git repo", async () => {
    const projPath = join(tmpRoot, "not-a-repo");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_repo");
  });

  it("returns ok:false / reason:no_upstream when branch has no @{u} and setUpstream is omitted", async () => {
    // No `pushInitialCommit` step → no upstream wired even though origin is set.
    const projPath = join(tmpRoot, "no-upstream-proj");
    const bare = join(tmpRoot, "no-upstream-bare.git");
    await initBareRepo(bare, "feature");
    const git = await initRepo(projPath, "feature");
    writeFileSync(join(projPath, "a.txt"), "1");
    await git.add(["a.txt"]);
    await git.commit("init");
    await git.addRemote("origin", bare);

    const id = seedProject(testDb.sqlite, { path: projPath });
    const res = await app.request(`/projects/${id}/git-push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_upstream");
    expect(body.branch).toBe("feature");
    expect(body.message).toMatch(/setUpstream=true/);
  });

  it("returns ok:false / reason:protected_branch when force-pushing to main", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "protected-main",
      branch: "main",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    // Spy that errors if invoked — protected_branch refusal must happen
    // BEFORE the network seam is touched. Mirrors the security test in
    // services/git-operations.test.ts.
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        new Error("executeRaw must not run for protected_branch"),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("protected_branch");
      expect(body.branch).toBe("main");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // ─── Mocked network failures (the literal stderr strings from the brief) ─

  it("auth_failed: 'Permission denied (publickey)' — SSH key rejected", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "auth-publickey",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "Permission denied (publickey).\nfatal: Could not read from remote repository.",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");
      expect(body.branch).toBe("feature");
      expect(body.remote).toBe("origin");
      expect(body.stderr).toMatch(/Permission denied/);
    } finally {
      spy.mockRestore();
    }
  });

  it("auth_failed: 'fatal: could not read Username' — HTTPS prompt with TERMINAL_PROMPT=0", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "auth-username",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");
      expect(body.stderr).toMatch(/could not read Username/);
    } finally {
      spy.mockRestore();
    }
  });

  it("auth_failed: 'fatal: Authentication failed' — generic auth fail line", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "auth-generic",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "remote: Invalid credentials\nfatal: Authentication failed for 'https://github.com/x/y.git'",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("auth_failed: 'HTTP 403' — credentials valid, repo permission denied", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "auth-403",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "remote: HTTP 403 forbidden\nfatal: unable to access 'https://github.com/x/y.git/'",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("auth_failed: 'remote: Repository not found' — GitHub's 404-as-401", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "auth-notfound",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");
      expect(body.stderr).toMatch(/Repository not found/);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejected_non_fast_forward: stderr classifies push refusal correctly", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "rejected-nff",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr:
            "! [rejected]        feature -> feature (non-fast-forward)\nerror: failed to push some refs to 'origin'",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("rejected_non_fast_forward");
      expect(body.stderr).toMatch(/non-fast-forward/);
    } finally {
      spy.mockRestore();
    }
  });

  // ─── Happy path with executeRaw stubbed ────────────────────────────────

  it("happy path: ok:true, updated:true, branch + remote echoed back", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "happy-updated",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({
        stdout: "",
        stderr: "To origin\n   abc1234..def5678  feature -> feature\n",
      });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.reason).toBe("ok");
      expect(body.branch).toBe("feature");
      expect(body.remote).toBe("origin");
      expect(body.updated).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("setUpstream:true is threaded through to the service (-u argv emitted)", async () => {
    // Fresh repo with NO upstream — a plain push would 422-equivalent with
    // no_upstream. With `setUpstream: true`, the service skips the upstream
    // check and emits `-u`.
    const projPath = join(tmpRoot, "happy-setupstream");
    const bare = join(tmpRoot, "happy-setupstream-bare.git");
    await initBareRepo(bare, "newfeat");
    const git = await initRepo(projPath, "newfeat");
    writeFileSync(join(projPath, "a"), "1");
    await git.add(".");
    await git.commit("init");
    await git.addRemote("origin", bare);
    const id = seedProject(testDb.sqlite, { path: projPath });

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_g, args) => {
        capturedArgs = args;
        return { stdout: "", stderr: "" };
      });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setUpstream: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.branch).toBe("newfeat");
      expect(capturedArgs).toEqual([
        "push",
        "-u",
        "origin",
        "HEAD:refs/heads/newfeat",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("force:true on a non-protected branch resolves to --force-with-lease (NEVER raw --force)", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "happy-force",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_g, args) => {
        capturedArgs = args;
        return { stdout: "", stderr: "" };
      });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(capturedArgs).toContain("--force-with-lease");
      expect(capturedArgs).not.toContain("--force");
      expect(capturedArgs).not.toContain("--all");
      expect(capturedArgs).not.toContain("--mirror");
    } finally {
      spy.mockRestore();
    }
  });

  it("custom remote name is plumbed through (e.g. 'upstream')", async () => {
    const projPath = join(tmpRoot, "custom-remote");
    const bare = join(tmpRoot, "custom-remote-bare.git");
    await initBareRepo(bare, "feature");
    const git = await initRepo(projPath, "feature");
    writeFileSync(join(projPath, "a"), "1");
    await git.add(".");
    await git.commit("init");
    await git.addRemote("upstream", bare);
    await git.push(["-u", "upstream", "feature"]);
    const id = seedProject(testDb.sqlite, { path: projPath });

    let capturedArgs: string[] | undefined;
    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockImplementation(async (_g, args) => {
        capturedArgs = args;
        return { stdout: "", stderr: "" };
      });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote: "upstream" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.remote).toBe("upstream");
      expect(capturedArgs).toContain("upstream");
    } finally {
      spy.mockRestore();
    }
  });

  // ─── Audit-row contract — counts-only argsJson, no URL / token / auth ─

  // The push-route audit-row contract: exactly one row per call, action='push',
  // and `args_json` parses to JSON containing EXACTLY the four keys
  // {remote, branch, force, setUpstream}. No `url`, no `token`, no `auth`,
  // no `HEAD:refs/heads/…` ref string. This is the single most important
  // invariant the audit table promises: forensics MUST NOT mirror anything
  // that could carry a credential.
  it("audit_row: argsJson has exactly the four documented keys, no url/token/auth leakage", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "audit-shape",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockResolvedValue({ stdout: "", stderr: "" });
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote: "origin", setUpstream: false, force: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("push");
      expect(rows[0]!.reason).toBe("ok");
      expect(rows[0]!.exitCode).toBe(0);
      expect(rows[0]!.projectId).toBe(id);
      expect(rows[0]!.workspaceId).toBeNull();

      // argsJson must be parseable JSON.
      const args = JSON.parse(rows[0]!.argsJson);

      // Exactly four keys — no `url`, no `token`, no `auth`, nothing else.
      expect(Object.keys(args).sort()).toEqual([
        "branch",
        "force",
        "remote",
        "setUpstream",
      ]);
      expect(args).toEqual({
        remote: "origin",
        branch: "feature",
        force: false,
        setUpstream: false,
      });

      // Substring assertions — none of the credential-shaped substrings
      // appear in the serialised payload. This is defence-in-depth: even
      // if a future refactor accidentally widened the JSON shape, these
      // catches the most dangerous classes of leak (URLs, refs, auth).
      const json = rows[0]!.argsJson;
      expect(json).not.toMatch(/url/i);
      expect(json).not.toMatch(/token/i);
      expect(json).not.toMatch(/auth/i);
      expect(json).not.toMatch(/https?:\/\//i);
      expect(json).not.toMatch(/refs\/heads/);
      expect(json).not.toMatch(/@/);
    } finally {
      spy.mockRestore();
    }
  });

  it("audit_row: protected_branch refusal records branch=main, force=true and never reaches network", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "audit-protected",
      branch: "main",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(new Error("must not run"));
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("protected_branch");
      expect(spy).not.toHaveBeenCalled();

      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("push");
      expect(rows[0]!.reason).toBe("protected_branch");
      const args = JSON.parse(rows[0]!.argsJson);
      // Same four-key shape even on refusal — branch is captured so
      // forensics can reconstruct *which* branch was refused.
      expect(Object.keys(args).sort()).toEqual([
        "branch",
        "force",
        "remote",
        "setUpstream",
      ]);
      expect(args).toEqual({
        remote: "origin",
        branch: "main",
        force: true,
        setUpstream: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("audit_row: auth_failed mock writes one row with stderr_truncated populated", async () => {
    const { repo } = await setupRepoWithRemote({
      tmpRoot,
      name: "audit-auth-fail",
      branch: "feature",
    });
    const id = seedProject(testDb.sqlite, { path: repo });

    const spy = vi
      .spyOn(__pushTestHooks, "executeRaw")
      .mockRejectedValue(
        Object.assign(new Error("git failed"), {
          stderr: "Permission denied (publickey).\nfatal: Could not read from remote repository.",
        }),
      );
    try {
      const res = await app.request(`/projects/${id}/git-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("auth_failed");

      const rows = await getDb()
        .select()
        .from(gitAuditLog)
        .where(eq(gitAuditLog.projectId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("push");
      expect(rows[0]!.reason).toBe("auth_failed");
      expect(rows[0]!.stderrTruncated).toMatch(/Permission denied/);
      // stderr_truncated must be ≤ 4096 bytes per schema invariant.
      expect(
        Buffer.byteLength(rows[0]!.stderrTruncated ?? "", "utf-8"),
      ).toBeLessThanOrEqual(4096);
    } finally {
      spy.mockRestore();
    }
  });
});
