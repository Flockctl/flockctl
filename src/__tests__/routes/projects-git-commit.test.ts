import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import simpleGit from "simple-git";
import { eq } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { gitAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject } from "../helpers.js";

/**
 * End-to-end tests for `POST /projects/:id/git-commit`. Sibling of
 * `projects-git-pull.test.ts` — same approach: spin up real git repos in
 * temp dirs and exercise the HTTP route end-to-end. Mocking simple-git
 * here would defeat the point — the value of `runGitCommit` is its
 * pre-flight ordering against a *live* working tree, and stubbing that
 * out would make the assertions a tautology.
 *
 * Branch is pinned to `main` via `init.defaultBranch=main` on every `git
 * init` so the suite is stable across git versions whose default differs.
 */

async function initRepoAtPath(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@flockctl.local");
  await git.addConfig("user.name", "Flockctl Test");
  // Seed a commit so HEAD resolves; pre-flight reads `git status`, which
  // needs a HEAD to be sensible.
  writeFileSync(join(path, "seed.txt"), "seed\n");
  await git.add(["seed.txt"]);
  await git.commit("seed");
}

describe("POST /projects/:id/git-commit", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-git-commit-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns 404 when project does not exist", async () => {
    const res = await app.request("/projects/999999/git-commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "anything" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when project has no path", async () => {
    // `seedProject` leaves the column NULL when path is omitted, exercising
    // the "Project has no path" guard before runGitCommit is even invoked.
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "anything" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when body is missing the message field", async () => {
    const projPath = join(tmpRoot, "missing-message");
    await initRepoAtPath(projPath);
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when message exceeds 4096 bytes", async () => {
    const projPath = join(tmpRoot, "msg-too-long");
    await initRepoAtPath(projPath);
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(4097) }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when paths exceeds the 500-element cap", async () => {
    const projPath = join(tmpRoot, "too-many-paths");
    await initRepoAtPath(projPath);
    const id = seedProject(testDb.sqlite, { path: projPath });

    const tooManyPaths = Array.from({ length: 501 }, (_, i) => `f${i}.txt`);
    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "noop", paths: tooManyPaths }),
    });
    expect(res.status).toBe(422);
  });

  it("returns ok:false / reason:empty_message for whitespace-only message via the wire", async () => {
    // Schema requires `message.length >= 1`, but a string of " " is length 1
    // and passes zod — exercising the service-level whitespace guard which
    // sits inside `runGitCommit` (not in the route schema).
    const projPath = join(tmpRoot, "whitespace-message");
    await initRepoAtPath(projPath);
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   \t  " }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_message");
  });

  it("returns ok:false / reason:not_a_repo when project path is not a git repo", async () => {
    const projPath = join(tmpRoot, "not-a-repo");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "anything" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_a_repo");
  });

  it("returns ok:false / reason:empty_index when the working tree is clean", async () => {
    const projPath = join(tmpRoot, "clean-tree");
    await initRepoAtPath(projPath);
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nothing to commit" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_index");
  });

  it("returns ok:false / reason:unknown_path when paths are not in status", async () => {
    const projPath = join(tmpRoot, "unknown-path");
    await initRepoAtPath(projPath);
    writeFileSync(join(projPath, "real.txt"), "hi\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "include nothing",
        paths: ["real.txt", "ghost.txt"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unknown_path");
    // The offending path is echoed so the operator learns *which* entry was
    // wrong, not just that *one* was — a UX regression we want a test to catch.
    expect(body.message).toMatch(/ghost\.txt/);
  });

  it("happy path: stages -A and commits everything dirty, returns sha + filesCommitted", async () => {
    const projPath = join(tmpRoot, "happy-A");
    await initRepoAtPath(projPath);
    writeFileSync(join(projPath, "a.txt"), "alpha\n");
    writeFileSync(join(projPath, "b.txt"), "bravo\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: add a and b" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reason).toBe("ok");
    expect(typeof body.sha).toBe("string");
    expect(body.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(body.filesCommitted).toBe(2);

    // HEAD now points at the returned SHA — sanity-check the side effect
    // actually landed in the working tree, not just in our response object.
    const headSha = (await simpleGit(projPath).revparse(["HEAD"])).trim();
    expect(headSha).toBe(body.sha);
  });

  it("happy path: explicit paths stage only those files", async () => {
    const projPath = join(tmpRoot, "happy-explicit");
    await initRepoAtPath(projPath);
    writeFileSync(join(projPath, "wanted.txt"), "wanted\n");
    writeFileSync(join(projPath, "skipped.txt"), "skipped\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "feat: only wanted",
        paths: ["wanted.txt"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.filesCommitted).toBe(1);

    // The skipped file is still untracked after the commit — pinning the
    // contract that explicit paths are *exclusive*, not advisory.
    const status = await simpleGit(projPath).status();
    expect(status.not_added).toContain("skipped.txt");
  });

  it("happy path: commits 50 dirty files when paths is empty (-A path)", async () => {
    const projPath = join(tmpRoot, "happy-fifty");
    await initRepoAtPath(projPath);
    // 50 untracked files; with paths omitted, runGitCommit issues `git add -A`
    // and stages every one of them. Smaller than the 500-cap on the explicit
    // paths array but representative of "commit a feature branch's worth of
    // changes" in one shot.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(projPath, `f${i}.txt`), `${i}\n`);
    }
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: bulk add" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.filesCommitted).toBe(50);
  });

  // After the commit lands, the route should leave exactly one row in
  // `git_audit_log` keyed on the project_id — same audit-row contract the
  // pull route pins. Crucially: argsJson is COUNTS-ONLY (paths_count,
  // message_bytes) — never raw paths, never the message body. Audit-log
  // forensics deliberately doesn't mirror the request body; commit messages
  // can leak ticket numbers / customer names / worse, and paths can leak
  // file structure intent. This test is the canary on that promise.
  it("audit_row_writes_one_row_keyed_on_project_id_with_counts_only_argsjson", async () => {
    const projPath = join(tmpRoot, "audit-success");
    await initRepoAtPath(projPath);
    writeFileSync(join(projPath, "tracked.txt"), "value\n");
    writeFileSync(join(projPath, "another.txt"), "value\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "feat: secret-ticket-12345",
        paths: ["tracked.txt", "another.txt"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBe(id);
    expect(rows[0]!.workspaceId).toBeNull();
    expect(rows[0]!.action).toBe("commit");
    expect(rows[0]!.reason).toBe("ok");
    expect(rows[0]!.exitCode).toBe(0);

    // argsJson invariant: counts-only. Parse and pin the exact shape so a
    // future refactor that "helpfully" added the message body or path list
    // to the audit row blows up here.
    const args = JSON.parse(rows[0]!.argsJson);
    expect(args).toEqual({
      paths_count: 2,
      message_bytes: Buffer.byteLength("feat: secret-ticket-12345", "utf-8"),
    });
    // Substring assertions — the message body and path names must NOT
    // appear anywhere in the serialised payload.
    expect(rows[0]!.argsJson).not.toMatch(/tracked\.txt/);
    expect(rows[0]!.argsJson).not.toMatch(/another\.txt/);
    expect(rows[0]!.argsJson).not.toMatch(/secret-ticket/);
    expect(rows[0]!.argsJson).not.toMatch(/feat:/);
  });

  // The empty-message guard sits BEFORE `runGitCommand`, so a no-op caller
  // must NOT pollute `git_audit_log`. This test pins that contract via the
  // wire — a regression here would mean an attacker could DoS the audit
  // table by spamming whitespace-only commit requests.
  it("audit_row_NOT_written_when_empty_message_guard_short_circuits", async () => {
    const projPath = join(tmpRoot, "audit-no-write");
    await initRepoAtPath(projPath);
    writeFileSync(join(projPath, "x.txt"), "x\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/git-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: " \t \n " }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("empty_message");

    const rows = await getDb()
      .select()
      .from(gitAuditLog)
      .where(eq(gitAuditLog.projectId, id));
    expect(rows).toHaveLength(0);
  });
});
