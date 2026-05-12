import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { eq, and, isNull } from "drizzle-orm";
import { app } from "../../server.js";
import { setDb, getDb } from "../../db/index.js";
import { fsAuditLog } from "../../db/schema.js";
import { createTestDb, seedWorkspace } from "../helpers.js";
import { __resetRealRootCacheForTests } from "../../services/fs-operations.js";

/**
 * Mirror of `projects-fs-read.test.ts` for `GET /workspaces/:id/fs/file`.
 * Both routes flow through the same factory (`makeFsRouteHandlers`) — this
 * suite proves the workspace mount preserves the wire contract and that the
 * audit-row attribution is keyed on `workspace_id` with `project_id IS NULL`.
 */

describe("GET /workspaces/:id/fs/file", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-ws-fs-read-"));

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
    const res = await app.request("/workspaces/999999/fs/file?path=README.md");
    expect(res.status).toBe(404);
  });

  it("returns 200 ok:true with content + sha for a small file", async () => {
    const wsPath = join(tmpRoot, "happy");
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(join(wsPath, "AGENTS.md"), "rules\n");
    const id = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await app.request(`/workspaces/${id}/fs/file?path=AGENTS.md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.content).toBe("rules\n");
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(body.encoding).toBe("utf-8");
  });

  it("rejects `..` traversal with fs_path_outside_project", async () => {
    const wsPath = join(tmpRoot, "traversal");
    mkdirSync(wsPath, { recursive: true });
    const id = seedWorkspace(testDb.sqlite, { path: wsPath });

    const res = await app.request(
      `/workspaces/${id}/fs/file?path=${encodeURIComponent("../../../etc/passwd")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("audit-row contract: every workspace read writes one row keyed on workspace_id only", async () => {
    // Success branch.
    const successWs = join(tmpRoot, "audit-success");
    mkdirSync(successWs, { recursive: true });
    writeFileSync(join(successWs, "ok.txt"), "ok\n");
    const successId = seedWorkspace(testDb.sqlite, { path: successWs });
    await app.request(`/workspaces/${successId}/fs/file?path=ok.txt`);

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
    expect(successRows[0]!.action).toBe("read");
    expect(successRows[0]!.entityType).toBe("workspace");
    expect(successRows[0]!.entityId).toBe(successId);
    expect(successRows[0]!.projectId).toBeNull();
    expect(successRows[0]!.workspaceId).toBe(successId);
    expect(successRows[0]!.path).toBe("ok.txt");
    expect(successRows[0]!.ok).toBe(1);
    expect(successRows[0]!.errorCode).toBeNull();

    // Failure branch.
    const failWs = join(tmpRoot, "audit-fail");
    mkdirSync(failWs, { recursive: true });
    const failId = seedWorkspace(testDb.sqlite, { path: failWs });
    await app.request(`/workspaces/${failId}/fs/file?path=missing.txt`);

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
    expect(failRows[0]!.action).toBe("read");
    expect(failRows[0]!.ok).toBe(0);
    expect(failRows[0]!.errorCode).toBe("fs_not_found");
    expect(failRows[0]!.path).toBe("missing.txt");
  });
});
