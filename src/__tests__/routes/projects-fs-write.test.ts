import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
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
 * End-to-end tests for `PUT /projects/:id/fs/file`. Hits the real Hono app
 * via `app.fetch`. Each invocation is expected to write exactly one row to
 * `fs_audit_log` keyed on `project_id` only (workspace_id IS NULL) with
 * `action='write'` and the new sha_before / sha_after / bytes columns
 * populated per the slice contract.
 */

function sha(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

async function put(
  url: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /projects/:id/fs/file", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-proj-fs-write-"));

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
    const res = await put("/projects/999999/fs/file?path=README.md", {
      content: "x",
      expectedSha: "",
      allowCreate: true,
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when the body is malformed", async () => {
    const projPath = join(tmpRoot, "bad-body");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(`/projects/${id}/fs/file?path=x.txt`, {
      content: "x",
      expectedSha: "not-a-sha",
      allowCreate: true,
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 ok:true with sha+mtime+size on a successful create", async () => {
    const projPath = join(tmpRoot, "create");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(`/projects/${id}/fs/file?path=new.txt`, {
      content: "hello\n",
      expectedSha: "",
      allowCreate: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sha).toBe(sha("hello\n"));
    expect(body.size).toBe(Buffer.byteLength("hello\n"));
    expect(typeof body.mtime).toBe("number");
    expect(readFileSync(join(projPath, "new.txt"), "utf-8")).toBe("hello\n");
  });

  it("returns 200 ok:false / fs_sha_conflict with currentSha when expectedSha doesn't match", async () => {
    const projPath = join(tmpRoot, "conflict");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "f.txt"), "actual\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(`/projects/${id}/fs/file?path=f.txt`, {
      content: "new\n",
      expectedSha: "0".repeat(64),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error_code: "fs_sha_conflict",
      currentSha: sha("actual\n"),
    });
    // Original file untouched.
    expect(readFileSync(join(projPath, "f.txt"), "utf-8")).toBe("actual\n");
  });

  it("returns fs_sha_conflict with currentSha:'' when target file is missing and allowCreate=false", async () => {
    const projPath = join(tmpRoot, "missing-no-create");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(`/projects/${id}/fs/file?path=absent.txt`, {
      content: "x",
      expectedSha: "",
      allowCreate: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error_code: "fs_sha_conflict",
      currentSha: "",
    });
  });

  it("returns 422 when the body exceeds the 2 MiB cap (Zod validator)", async () => {
    const projPath = join(tmpRoot, "too-large");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(`/projects/${id}/fs/file?path=big.txt`, {
      content: "a".repeat(MAX_READ_BYTES + 1),
      expectedSha: "",
      allowCreate: true,
    });
    // The Zod schema rejects oversize content as a malformed body → 422.
    // The service-layer `fs_too_large` branch is exercised in the
    // service-level test where the route is bypassed.
    expect(res.status).toBe(422);
  });

  it("returns fs_path_outside_project for `..` traversal", async () => {
    const projPath = join(tmpRoot, "traversal");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await put(
      `/projects/${id}/fs/file?path=${encodeURIComponent("../../etc/passwd")}`,
      { content: "x", expectedSha: "", allowCreate: true },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("returns fs_no_project_path when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await put(`/projects/${id}/fs/file?path=x.txt`, {
      content: "x",
      expectedSha: "",
      allowCreate: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_no_project_path" });
  });

  // ─── Audit-row contract — every write writes exactly ONE row to
  // `fs_audit_log` with `action='write'`, the project_id attribution, and
  // the new `sha_before` / `sha_after` / `bytes` columns populated.

  it("audit-row contract: success path records sha_before, sha_after, bytes", async () => {
    const projPath = join(tmpRoot, "audit-success");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "f.txt"), "v0\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const before = sha("v0\n");
    const after = sha("v1\n");
    await put(`/projects/${id}/fs/file?path=f.txt`, {
      content: "v1\n",
      expectedSha: before,
    });

    const rows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(eq(fsAuditLog.projectId, id), isNull(fsAuditLog.workspaceId)),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("write");
    expect(row.entityType).toBe("project");
    expect(row.entityId).toBe(id);
    expect(row.path).toBe("f.txt");
    expect(row.ok).toBe(1);
    expect(row.errorCode).toBeNull();
    expect(row.shaBefore).toBe(before);
    expect(row.shaAfter).toBe(after);
    expect(row.bytes).toBe(Buffer.byteLength("v1\n"));
  });

  it("audit-row contract: sha_conflict failure records sha_before=currentSha, sha_after=null, bytes", async () => {
    const projPath = join(tmpRoot, "audit-conflict");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "f.txt"), "actual\n");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const payload = "ignored\n";
    await put(`/projects/${id}/fs/file?path=f.txt`, {
      content: payload,
      expectedSha: "0".repeat(64),
    });

    const rows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(eq(fsAuditLog.projectId, id), isNull(fsAuditLog.workspaceId)),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("write");
    expect(row.ok).toBe(0);
    expect(row.errorCode).toBe("fs_sha_conflict");
    expect(row.shaBefore).toBe(sha("actual\n"));
    expect(row.shaAfter).toBeNull();
    expect(row.bytes).toBe(Buffer.byteLength(payload));
  });

  it("audit-row contract: fresh-create write records shaBefore=null, shaAfter=newSha", async () => {
    const projPath = join(tmpRoot, "audit-create");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const content = "fresh\n";
    await put(`/projects/${id}/fs/file?path=fresh.txt`, {
      content,
      expectedSha: "",
      allowCreate: true,
    });

    const rows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(eq(fsAuditLog.projectId, id), isNull(fsAuditLog.workspaceId)),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("write");
    expect(row.ok).toBe(1);
    expect(row.shaBefore).toBeNull();
    expect(row.shaAfter).toBe(sha(content));
    expect(row.bytes).toBe(Buffer.byteLength(content));
  });
});
