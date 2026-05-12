import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import {
  readProjectFileRange,
  RANGE_SLICE_CAP,
  __resetRealRootCacheForTests,
} from "../../services/fs-operations.js";

/**
 * Service-level tests for `readProjectFileRange` — the partial-slice reader
 * that backs `GET /:id/fs/file?range=bytes=N-M`. These pin the security and
 * correctness invariants without an HTTP harness; the route-layer
 * `projects-fs-range.test.ts` covers the wire-shape contract.
 *
 * Each describe block uses an isolated tmp directory so a fixture in one
 * test cannot leak into the next. We reset the realpath cache between
 * scenarios because `getRealRoot` keys on the literal `projectRoot` string
 * — a fixture rebuilt at the same path between cases would otherwise serve
 * a stale canonical path.
 */

describe("readProjectFileRange — happy path", () => {
  let root: string;
  const fileBytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz", "utf-8");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-range-happy-"));
    writeFileSync(join(root, "data.txt"), fileBytes);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns the requested slice with whole-file sha and totalSize", async () => {
    const got = await readProjectFileRange(root, "data.txt", {
      offset: 5,
      length: 10,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");

    expect(got.partial).toBe(true);
    expect(got.encoding).toBe("utf-8");
    expect(got.content).toBe(fileBytes.subarray(5, 15).toString("utf-8"));
    expect(got.range).toEqual({ offset: 5, length: 10 });
    expect(got.totalSize).toBe(fileBytes.length);

    // sha is over the WHOLE file, not the slice — that's the crucial
    // identity-token invariant for future write-side conflict detection.
    const expectedWholeFileSha = createHash("sha256")
      .update(fileBytes)
      .digest("hex");
    expect(got.sha).toBe(expectedWholeFileSha);

    // sha of the slice alone would be different — confirm we are not doing
    // that by accident.
    const sliceOnlySha = createHash("sha256")
      .update(fileBytes.subarray(5, 15))
      .digest("hex");
    expect(got.sha).not.toBe(sliceOnlySha);
  });

  it("reads from offset 0 when length covers the whole file", async () => {
    const got = await readProjectFileRange(root, "data.txt", {
      offset: 0,
      length: fileBytes.length,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.content).toBe(fileBytes.toString("utf-8"));
    expect(got.range.length).toBe(fileBytes.length);
    expect(got.totalSize).toBe(fileBytes.length);
    expect(got.partial).toBe(true);
  });

  it("clamps requested length to bytes-remaining when it overshoots EOF", async () => {
    const got = await readProjectFileRange(root, "data.txt", {
      offset: fileBytes.length - 4,
      length: 1024,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.range).toEqual({ offset: fileBytes.length - 4, length: 4 });
    expect(got.content).toBe(fileBytes.subarray(-4).toString("utf-8"));
  });

  it("treats omitted length as `up to slice cap or EOF, whichever is smaller`", async () => {
    const got = await readProjectFileRange(root, "data.txt", { offset: 10 });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.range.offset).toBe(10);
    expect(got.range.length).toBe(fileBytes.length - 10);
    expect(got.content).toBe(fileBytes.subarray(10).toString("utf-8"));
  });
});

describe("readProjectFileRange — large file (above 2 MiB whole-file cap)", () => {
  let root: string;
  const HUGE = 3 * 1024 * 1024; // 3 MiB — above readProjectFile's 2 MiB ceiling.

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-range-huge-"));
    // Fill with a deterministic but non-trivial pattern so the slice content
    // is recognisable in assertions.
    const buf = Buffer.alloc(HUGE);
    for (let i = 0; i < buf.length; i += 1) {
      // ASCII 'A' + (i % 26) — keeps everything in the printable / non-NUL
      // range so we don't accidentally trip the binary detector.
      buf[i] = 65 + (i % 26);
    }
    writeFileSync(join(root, "huge.txt"), buf);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("serves a 1 MiB slice from a 3 MiB file (above the whole-file cap)", async () => {
    const got = await readProjectFileRange(root, "huge.txt", {
      offset: 1024,
      length: RANGE_SLICE_CAP,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.range).toEqual({ offset: 1024, length: RANGE_SLICE_CAP });
    expect(got.totalSize).toBe(HUGE);
    expect(got.content.length).toBe(RANGE_SLICE_CAP);
  });

  it("rejects length > slice cap with fs_invalid_range without touching the FS", async () => {
    const got = await readProjectFileRange(root, "huge.txt", {
      offset: 0,
      length: RANGE_SLICE_CAP + 1,
    });
    expect(got).toMatchObject({
      ok: false,
      error_code: "fs_invalid_range",
    });
  });
});

describe("readProjectFileRange — range param validation", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-range-validate-"));
    writeFileSync(join(root, "ok.txt"), "0123456789");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("rejects negative offset", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: -1, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("rejects non-integer offset", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: 1.5, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("rejects NaN offset", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: Number.NaN, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("rejects zero length", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: 0, length: 0 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("rejects negative length", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: 0, length: -8 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("rejects offset past EOF with fs_invalid_range", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: 10_000, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_range" });
  });

  it("accepts offset == totalSize and returns an empty slice", async () => {
    const got = await readProjectFileRange(root, "ok.txt", { offset: 10, length: 4 });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.content).toBe("");
    expect(got.range).toEqual({ offset: 10, length: 0 });
  });
});

describe("readProjectFileRange — path-jail invariants", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-range-jail-"));
    writeFileSync(join(root, "real.txt"), "hello");
    try {
      symlinkSync("/etc", join(root, "escape"));
    } catch {
      /* tolerate sandboxes that disallow symlink creation */
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns fs_no_project_path when projectRoot is empty", async () => {
    const got = await readProjectFileRange("", "real.txt", { offset: 0, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_no_project_path" });
  });

  it("returns fs_missing_path when relPath is empty", async () => {
    const got = await readProjectFileRange(root, "", { offset: 0, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_missing_path" });
  });

  it("rejects absolute paths with fs_path_outside_project", async () => {
    const got = await readProjectFileRange(root, "/etc/passwd", { offset: 0, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("rejects `..` traversal with fs_path_outside_project", async () => {
    const got = await readProjectFileRange(root, "../../../etc/passwd", {
      offset: 0,
      length: 4,
    });
    expect(got).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("rejects double-encoded `..` traversal smuggling", async () => {
    const got = await readProjectFileRange(root, "%2e%2e/etc/passwd", {
      offset: 0,
      length: 4,
    });
    expect(got).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("refuses reads through a symlink that escapes the root", async () => {
    let canSymlink = true;
    try {
      const probe = await import("fs/promises");
      await probe.lstat(join(root, "escape"));
    } catch {
      canSymlink = false;
    }
    if (!canSymlink) return;
    const got = await readProjectFileRange(root, "escape/hosts", {
      offset: 0,
      length: 4,
    });
    expect(got).toMatchObject({
      ok: false,
      error_code: "fs_path_outside_project",
    });
  });

  it("returns fs_not_found for a missing file", async () => {
    const got = await readProjectFileRange(root, "no-such-file.txt", {
      offset: 0,
      length: 4,
    });
    expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
  });

  it("returns fs_not_found when the path resolves to a directory", async () => {
    const got = await readProjectFileRange(root, ".", { offset: 0, length: 4 });
    expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
  });
});

describe("readProjectFileRange — binary detection", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-range-binary-"));
    writeFileSync(
      join(root, "binary.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("flags binary files as fs_binary when the slice contains a NUL byte", async () => {
    const got = await readProjectFileRange(root, "binary.bin", {
      offset: 0,
      length: 8,
    });
    expect(got).toMatchObject({ ok: false, error_code: "fs_binary" });
  });
});
