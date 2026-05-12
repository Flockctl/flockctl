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
  RANGE_SLICE_CAP,
} from "../../services/fs-operations.js";

/**
 * End-to-end tests for the range branch of `GET /projects/:id/fs/file`.
 *
 *   - With `?range=bytes=N-M`, the route serves a partial slice and replies
 *     with HTTP 206 Partial Content. The body shape adds `partial:true`,
 *     `totalSize`, and `range:{offset,length}`; `sha` is over the WHOLE file.
 *   - Without `?range=`, the route falls back to the existing whole-file
 *     reader and still refuses files above `MAX_READ_BYTES` with `fs_too_large`.
 *   - With `?range=`, the route accepts files up to whatever the FS exposes
 *     — only the per-slice cap (`RANGE_SLICE_CAP`) applies to `length`.
 *   - Every invocation writes exactly one row to `fs_audit_log` keyed on
 *     `project_id` (workspace_id IS NULL).
 */

describe("GET /projects/:id/fs/file?range=...", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-proj-fs-range-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns 206 + partial body for a valid range", async () => {
    const projPath = join(tmpRoot, "happy");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123456789abcdef");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=bytes=2-7`,
    );
    expect(res.status).toBe(206);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(true);
    // bytes=2-7 → offset 2, last 7 (inclusive) → length 6.
    expect(body.range).toEqual({ offset: 2, length: 6 });
    expect(body.content).toBe("234567");
    expect(body.totalSize).toBe(16);
    expect(body.encoding).toBe("utf-8");
    expect(typeof body.sha).toBe("string");
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.mtime).toBe("number");
  });

  it("supports `bytes=N-` open-ended ranges (read to end of file)", async () => {
    const projPath = join(tmpRoot, "open-ended");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123456789");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=bytes=4-`,
    );
    expect(res.status).toBe(206);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.content).toBe("456789");
    expect(body.range).toEqual({ offset: 4, length: 6 });
    expect(body.totalSize).toBe(10);
  });

  it("serves a slice from a file LARGER than the 2 MiB whole-file cap", async () => {
    const projPath = join(tmpRoot, "huge");
    mkdirSync(projPath, { recursive: true });
    // 3 MiB of printable ASCII so binary detection doesn't trip.
    const buf = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = 65 + (i % 26);
    writeFileSync(join(projPath, "big.txt"), buf);
    const id = seedProject(testDb.sqlite, { path: projPath });

    // Sanity: without range, this file is rejected as fs_too_large.
    const noRange = await app.request(`/projects/${id}/fs/file?path=big.txt`);
    expect(noRange.status).toBe(200);
    const noRangeBody = await noRange.json();
    expect(noRangeBody).toMatchObject({ ok: false, error_code: "fs_too_large" });

    // With range, the same file streams happily within the slice cap.
    const ranged = await app.request(
      `/projects/${id}/fs/file?path=big.txt&range=bytes=0-65535`,
    );
    expect(ranged.status).toBe(206);
    const body = await ranged.json();
    expect(body.ok).toBe(true);
    expect(body.partial).toBe(true);
    expect(body.range).toEqual({ offset: 0, length: 65536 });
    expect(body.totalSize).toBe(buf.length);
    expect(body.content.length).toBe(65536);
  });

  it("without ?range= the whole-file reader still refuses files > 2 MiB", async () => {
    const projPath = join(tmpRoot, "still-too-large");
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

  it("returns 200 ok:false / fs_invalid_range on a malformed range param", async () => {
    const projPath = join(tmpRoot, "malformed");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=cursors=0-3`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("returns 200 ok:false / fs_invalid_range when last < first", async () => {
    const projPath = join(tmpRoot, "inverted");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123456789");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=bytes=8-3`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("returns 200 ok:false / fs_invalid_range when length > slice cap", async () => {
    const projPath = join(tmpRoot, "overcap");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123456789");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const last = RANGE_SLICE_CAP; // length = last - 0 + 1 = cap + 1.
    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=bytes=0-${last}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("returns 200 ok:false / fs_invalid_range for offset past EOF", async () => {
    const projPath = join(tmpRoot, "past-eof");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "data.txt"), "0123");
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=data.txt&range=bytes=100-200`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("returns 200 ok:false / fs_not_found on a missing file even with a valid range", async () => {
    const projPath = join(tmpRoot, "missing");
    mkdirSync(projPath, { recursive: true });
    const id = seedProject(testDb.sqlite, { path: projPath });

    const res = await app.request(
      `/projects/${id}/fs/file?path=nope.txt&range=bytes=0-15`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error_code: "fs_not_found" });
  });

  it("audit-row contract: a successful range read writes one project-scoped row", async () => {
    const projPath = join(tmpRoot, "audit-success");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "ok.txt"), "audit-me");
    const id = seedProject(testDb.sqlite, { path: projPath });

    await app.request(
      `/projects/${id}/fs/file?path=ok.txt&range=bytes=0-3`,
    );

    const rows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(eq(fsAuditLog.projectId, id), isNull(fsAuditLog.workspaceId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("read");
    expect(rows[0]!.entityType).toBe("project");
    expect(rows[0]!.path).toBe("ok.txt");
    expect(rows[0]!.ok).toBe(1);
    expect(rows[0]!.errorCode).toBeNull();
  });

  it("audit-row contract: a malformed range writes a failure row with fs_invalid_range", async () => {
    const projPath = join(tmpRoot, "audit-malformed");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, "ok.txt"), "x");
    const id = seedProject(testDb.sqlite, { path: projPath });

    await app.request(
      `/projects/${id}/fs/file?path=ok.txt&range=garbage`,
    );

    const rows = await getDb()
      .select()
      .from(fsAuditLog)
      .where(
        and(eq(fsAuditLog.projectId, id), isNull(fsAuditLog.workspaceId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(0);
    expect(rows[0]!.errorCode).toBe("fs_invalid_range");
    expect(rows[0]!.path).toBe("ok.txt");
  });
});
