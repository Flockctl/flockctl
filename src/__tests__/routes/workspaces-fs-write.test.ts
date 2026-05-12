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
import { createTestDb, seedWorkspace } from "../helpers.js";
import { __resetRealRootCacheForTests } from "../../services/fs-operations.js";

/**
 * Mirror of `projects-fs-write.test.ts` for `PUT /workspaces/:id/fs/file`.
 * Both routes flow through the same factory (`makeFsRouteHandlers`) — this
 * suite proves the workspace mount preserves the wire contract and that the
 * audit-row attribution is keyed on `workspace_id` with `project_id IS NULL`.
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

describe("PUT /workspaces/:id/fs/file", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-ws-fs-write-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns 404 when the workspace does not exist", async () => {
    const res = await put("/workspaces/999999/fs/file?path=x.txt", {
      content: "x",
      expectedSha: "",
      allowCreate: true,
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 ok:true with sha+mtime+size on a successful create", async () => {
    const wsPath = join(tmpRoot, "create");
    mkdirSync(wsPath, { recursive: true });
    const id = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await put(`/workspaces/${id}/fs/file?path=NOTES.md`, {
      content: "rules\n",
      expectedSha: "",
      allowCreate: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sha).toBe(sha("rules\n"));
    expect(readFileSync(join(wsPath, "NOTES.md"), "utf-8")).toBe("rules\n");
  });

  it("returns fs_sha_conflict with currentSha on stale expectedSha", async () => {
    const wsPath = join(tmpRoot, "conflict");
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(join(wsPath, "f.txt"), "actual\n");
    const id = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await put(`/workspaces/${id}/fs/file?path=f.txt`, {
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
    expect(readFileSync(join(wsPath, "f.txt"), "utf-8")).toBe("actual\n");
  });

  it("audit-row contract: every workspace write writes one row keyed on workspace_id only", async () => {
    // Success branch.
    const successWs = join(tmpRoot, "audit-success");
    mkdirSync(successWs, { recursive: true });
    writeFileSync(join(successWs, "f.txt"), "v0\n");
    const successId = seedWorkspace(testDb.sqlite, { path: successWs });
    const before = sha("v0\n");
    const after = sha("v1\n");
    await put(`/workspaces/${successId}/fs/file?path=f.txt`, {
      content: "v1\n",
      expectedSha: before,
    });

    const successRows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.workspaceId, successId),
          isNull(fsAuditLog.projectId),
        ),
      );
    expect(successRows).toHaveLength(1);
    const row = successRows[0]!;
    expect(row.action).toBe("write");
    expect(row.entityType).toBe("workspace");
    expect(row.entityId).toBe(successId);
    expect(row.projectId).toBeNull();
    expect(row.workspaceId).toBe(successId);
    expect(row.path).toBe("f.txt");
    expect(row.ok).toBe(1);
    expect(row.errorCode).toBeNull();
    expect(row.shaBefore).toBe(before);
    expect(row.shaAfter).toBe(after);
    expect(row.bytes).toBe(Buffer.byteLength("v1\n"));

    // Failure branch — sha conflict.
    const failWs = join(tmpRoot, "audit-fail");
    mkdirSync(failWs, { recursive: true });
    writeFileSync(join(failWs, "g.txt"), "stay\n");
    const failId = seedWorkspace(testDb.sqlite, { path: failWs });
    await put(`/workspaces/${failId}/fs/file?path=g.txt`, {
      content: "ignored\n",
      expectedSha: "0".repeat(64),
    });

    const failRows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(
          eq(fsAuditLog.workspaceId, failId),
          isNull(fsAuditLog.projectId),
        ),
      );
    expect(failRows).toHaveLength(1);
    const failRow = failRows[0]!;
    expect(failRow.action).toBe("write");
    expect(failRow.ok).toBe(0);
    expect(failRow.errorCode).toBe("fs_sha_conflict");
    expect(failRow.shaBefore).toBe(sha("stay\n"));
    expect(failRow.shaAfter).toBeNull();
    expect(failRow.bytes).toBe(Buffer.byteLength("ignored\n"));
  });
});
