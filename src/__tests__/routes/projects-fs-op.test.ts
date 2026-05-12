import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { eq, and, isNull } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { fsAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject } from "../helpers.js";
import { __resetRealRootCacheForTests } from "../../services/fs-operations.js";

/**
 * End-to-end tests for `POST /projects/:id/fs/op`. Hits the real Hono app
 * via `app.fetch`. Each invocation should write exactly one row to
 * `fs_audit_log` keyed on `project_id` (workspace_id IS NULL) — the
 * audit-row contract block at the bottom pins that for the success and
 * failure branches.
 *
 * The discriminated union body shape is what's under test here: the same
 * route handler dispatches to four different service helpers based on the
 * `op` field, and each branch must produce a 200 envelope + audit row.
 */

async function postOp(id: number, body: unknown): Promise<Response> {
  return app.request(`/projects/${id}/fs/op`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /projects/:id/fs/op", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-proj-fs-op-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns 404 when the project does not exist", async () => {
    const res = await postOp(999999, { op: "mkdir", path: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 422 for a body missing the `op` discriminator", async () => {
    const id = seedProject(testDb.sqlite, {
      path: mkdtempSync(join(tmpRoot, "shape-")),
    });
    const res = await postOp(id, { path: "x" });
    expect(res.status).toBe(422);
  });

  it("returns 422 for an unknown op", async () => {
    const id = seedProject(testDb.sqlite, {
      path: mkdtempSync(join(tmpRoot, "unknown-")),
    });
    const res = await postOp(id, { op: "chmod", path: "x" });
    expect(res.status).toBe(422);
  });

  it("returns 422 for an unknown extra field (.strict)", async () => {
    const id = seedProject(testDb.sqlite, {
      path: mkdtempSync(join(tmpRoot, "strict-")),
    });
    const res = await postOp(id, { op: "mkdir", path: "x", recursive: true });
    expect(res.status).toBe(422);
  });

  // ─── mkdir branch ───────────────────────────────────────────────────────

  it("mkdir: 200 ok:true creates the directory", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "mkdir-ok-"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "mkdir", path: "newdir" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(existsSync(join(projPath, "newdir"))).toBe(true);
  });

  it("mkdir: 200 ok:false / fs_already_exists when target exists", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "mkdir-exists-"));
    mkdirSync(join(projPath, "d"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "mkdir", path: "d" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_already_exists" });
  });

  it("mkdir: 200 ok:false / fs_invalid_name for .git", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "mkdir-git-"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "mkdir", path: ".git" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
  });

  // ─── create branch ──────────────────────────────────────────────────────

  it("create: 200 ok:true writes the file with content", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "create-ok-"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, {
      op: "create",
      path: "hello.txt",
      content: "world\n",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(readFileSync(join(projPath, "hello.txt"), "utf-8")).toBe("world\n");
  });

  it("create: 200 ok:true with no content writes an empty file", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "create-empty-"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "create", path: "empty.txt" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(projPath, "empty.txt"), "utf-8")).toBe("");
  });

  it("create: 200 ok:false / fs_already_exists when file exists", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "create-exists-"));
    writeFileSync(join(projPath, "f.txt"), "old");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "create", path: "f.txt", content: "new" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_already_exists" });
    expect(readFileSync(join(projPath, "f.txt"), "utf-8")).toBe("old");
  });

  // ─── rename branch ──────────────────────────────────────────────────────

  it("rename: 200 ok:true moves the file", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "rename-ok-"));
    writeFileSync(join(projPath, "a.txt"), "x");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "rename", from: "a.txt", to: "b.txt" });
    expect(res.status).toBe(200);
    expect(existsSync(join(projPath, "a.txt"))).toBe(false);
    expect(readFileSync(join(projPath, "b.txt"), "utf-8")).toBe("x");
  });

  it("rename: 200 ok:false / fs_already_exists when target exists", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "rename-collide-"));
    writeFileSync(join(projPath, "a.txt"), "1");
    writeFileSync(join(projPath, "b.txt"), "2");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "rename", from: "a.txt", to: "b.txt" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_already_exists" });
  });

  it("rename: 200 ok:false / fs_invalid_name when target is in .git", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "rename-git-"));
    writeFileSync(join(projPath, "a.txt"), "");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, {
      op: "rename",
      from: "a.txt",
      to: ".git/sneaky",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
  });

  // ─── delete branch ──────────────────────────────────────────────────────

  it("delete: 200 ok:true removes a file", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "delete-file-"));
    writeFileSync(join(projPath, "f.txt"), "");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "delete", path: "f.txt" });
    expect(res.status).toBe(200);
    expect(existsSync(join(projPath, "f.txt"))).toBe(false);
  });

  it("delete: 200 ok:false / fs_not_empty for non-empty dir without recursive", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "delete-non-empty-"));
    mkdirSync(join(projPath, "d"));
    writeFileSync(join(projPath, "d", "f"), "");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, { op: "delete", path: "d" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_not_empty" });
    expect(existsSync(join(projPath, "d", "f"))).toBe(true);
  });

  it("delete: 200 ok:true with recursive=true removes the tree", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "delete-recursive-"));
    mkdirSync(join(projPath, "d"));
    writeFileSync(join(projPath, "d", "f"), "");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, {
      op: "delete",
      path: "d",
      recursive: true,
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(projPath, "d"))).toBe(false);
  });

  it("delete: refuses .git even with recursive=true", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "delete-git-"));
    mkdirSync(join(projPath, ".git"));
    writeFileSync(join(projPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await postOp(id, {
      op: "delete",
      path: ".git",
      recursive: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    expect(existsSync(join(projPath, ".git", "HEAD"))).toBe(true);
  });

  // ─── audit row contract ─────────────────────────────────────────────────
  //
  // Every op writes exactly ONE row to fs_audit_log keyed on project_id
  // with workspace_id IS NULL. Action matches the op verbatim, path is the
  // request-supplied relative path (or `from -> to` for rename), errorCode
  // mirrors the FsErrorCode discriminator on failure rows.

  it("audit: mkdir success writes a project-scoped row with action='mkdir'", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "audit-mkdir-"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    await postOp(id, { op: "mkdir", path: "auditdir" });

    const rows = getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, id),
          isNull(fsAuditLog.workspaceId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("mkdir");
    expect(rows[0]!.entityType).toBe("project");
    expect(rows[0]!.entityId).toBe(id);
    expect(rows[0]!.path).toBe("auditdir");
    expect(rows[0]!.ok).toBe(1);
    expect(rows[0]!.errorCode).toBeNull();
    expect(typeof rows[0]!.ts).toBe("number");
  });

  it("audit: create failure writes a row with errorCode set", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "audit-create-fail-"));
    writeFileSync(join(projPath, "f.txt"), "old");
    const id = seedProject(testDb.sqlite, { path: projPath });

    await postOp(id, { op: "create", path: "f.txt", content: "new" });

    const rows = getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, id),
          isNull(fsAuditLog.workspaceId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("create");
    expect(rows[0]!.path).toBe("f.txt");
    expect(rows[0]!.ok).toBe(0);
    expect(rows[0]!.errorCode).toBe("fs_already_exists");
  });

  it("audit: rename writes a row with `from -> to` in the path column", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "audit-rename-"));
    writeFileSync(join(projPath, "a.txt"), "x");
    const id = seedProject(testDb.sqlite, { path: projPath });

    await postOp(id, { op: "rename", from: "a.txt", to: "b.txt" });

    const rows = getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, id),
          isNull(fsAuditLog.workspaceId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("rename");
    expect(rows[0]!.path).toBe("a.txt -> b.txt");
    expect(rows[0]!.ok).toBe(1);
  });

  it("audit: delete writes a row even on protected-path refusal", async () => {
    const projPath = mkdtempSync(join(tmpRoot, "audit-delete-fail-"));
    mkdirSync(join(projPath, ".git"));
    const id = seedProject(testDb.sqlite, { path: projPath });

    await postOp(id, { op: "delete", path: ".git", recursive: true });

    const rows = getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, id),
          isNull(fsAuditLog.workspaceId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("delete");
    expect(rows[0]!.path).toBe(".git");
    expect(rows[0]!.ok).toBe(0);
    expect(rows[0]!.errorCode).toBe("fs_invalid_name");
  });

  it("audit: writes a row when the project has no path (fs_no_project_path)", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await postOp(id, { op: "mkdir", path: "any" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_no_project_path" });

    const rows = getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, id),
          isNull(fsAuditLog.workspaceId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("mkdir");
    expect(rows[0]!.errorCode).toBe("fs_no_project_path");
  });
});
