import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { eq, and, isNull } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { fsAuditLog } from "../../db/schema.js";
import { createTestDb, seedProject } from "../helpers.js";
import {
  __resetRealRootCacheForTests,
  MAX_READ_BYTES,
} from "../../services/fs-operations.js";

/**
 * End-to-end tests for `GET /projects/:id/fs/file`. Hits the real Hono app
 * via `app.fetch`. Each invocation is expected to write exactly one row to
 * `fs_audit_log` keyed on `project_id` only (workspace_id IS NULL) — the
 * audit-row contract test at the bottom pins that for the success and
 * failure cases that share this surface.
 */

describe("GET /projects/:id/fs/file", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-proj-fs-read-"));

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
    const res = await app.request("/projects/999999/fs/file?path=README.md");
    expect(res.status).toBe(404);
  });

  it("returns 200 ok:true with content + sha + size + mtime + encoding for a small file", async () => {
    const projPath = join(tmpRoot, "happy");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "README.md"), "# hello\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/fs/file?path=README.md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.content).toBe("# hello\n");
    expect(body.encoding).toBe("utf-8");
    expect(typeof body.sha).toBe("string");
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.mtime).toBe("number");
    expect(body.size).toBeGreaterThan(0);
  });

  it("returns 200 ok:false / fs_not_found for a missing file", async () => {
    const projPath = join(tmpRoot, "missing");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/fs/file?path=nope.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_not_found" });
  });

  it("returns 200 ok:false / fs_path_outside_project for `..` traversal", async () => {
    const projPath = join(tmpRoot, "traversal");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=${encodeURIComponent("../../../etc/passwd")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("returns 200 ok:false / fs_too_large for files above the size cap", async () => {
    const projPath = join(tmpRoot, "huge");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(
      join(projPath, "big.txt"),
      Buffer.alloc(MAX_READ_BYTES + 16, 0x61),
    );
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/fs/file?path=big.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_too_large" });
  });

  it("returns 200 ok:false / fs_binary for binary files (NUL byte in first 4 KiB)", async () => {
    const projPath = join(tmpRoot, "binary");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/fs/file?path=blob.bin`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_binary" });
  });

  it("returns 200 ok:false / fs_no_project_path when project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/fs/file?path=anything.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_no_project_path" });
  });

  it("returns 200 ok:false / fs_missing_path when ?path= is omitted", async () => {
    const projPath = join(tmpRoot, "missing-query");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(`/projects/${id}/fs/file`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_missing_path" });
  });

  // ─── Audit-row contract — the headline assertion every fs read endpoint
  // must satisfy: each invocation writes exactly ONE row to fs_audit_log,
  // keyed on project_id with workspace_id IS NULL. The same fixture covers
  // both the success and failure branches so we know the failure-path
  // audit write isn't accidentally skipped.

  it("audit-row contract: every read writes exactly one project-scoped row", async () => {
    // Success branch.
    const successProj = join(tmpRoot, "audit-success");
    mkdirSync(successProj, { recursive: true });
    writeFileSync(join(successProj, "ok.txt"), "ok\n");
    const successId = seedProject(testDb.sqlite, { path: successProj });
    await app.request(`/projects/${successId}/fs/file?path=ok.txt`);

    const successRows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, successId),
          isNull(fsAuditLog.workspaceId),
        ),
      );
    expect(successRows).toHaveLength(1);
    expect(successRows[0]!.action).toBe("read");
    expect(successRows[0]!.entityType).toBe("project");
    expect(successRows[0]!.entityId).toBe(successId);
    expect(successRows[0]!.path).toBe("ok.txt");
    expect(successRows[0]!.ok).toBe(1);
    expect(successRows[0]!.errorCode).toBeNull();
    expect(typeof successRows[0]!.ts).toBe("number");

    // Failure branch — fs_path_outside_project must still write a row.
    const failProj = join(tmpRoot, "audit-fail");
    mkdirSync(failProj, { recursive: true });
    const failId = seedProject(testDb.sqlite, { path: failProj });
    await app.request(
      `/projects/${failId}/fs/file?path=${encodeURIComponent("../../../etc/passwd")}`,
    );

    const failRows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.projectId, failId),
          isNull(fsAuditLog.workspaceId),
        ),
      );
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.action).toBe("read");
    expect(failRows[0]!.ok).toBe(0);
    expect(failRows[0]!.errorCode).toBe("fs_path_outside_project");
    expect(failRows[0]!.path).toBe("../../../etc/passwd");
  });
});
