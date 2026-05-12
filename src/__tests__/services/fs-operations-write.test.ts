import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "fs";
import fsp from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import {
  writeProjectFile,
  MAX_READ_BYTES,
  __resetRealRootCacheForTests,
} from "../../services/fs-operations.js";

/**
 * Service-level tests for `writeProjectFile`. The route-layer suites cover
 * the audit-row contract; this file pins the security and concurrency
 * invariants that survive without an HTTP harness.
 *
 * Each test owns a fresh tmp directory so concurrent renames in one suite
 * cannot leak into another. The realpath cache is reset between tests for
 * the same reason — `getRealRoot` keys on the literal `projectRoot` string,
 * and a fixture rebuilt at the same path between cases would otherwise see
 * a stale canonical path.
 */

function sha(buf: string | Buffer): string {
  return createHash("sha256")
    .update(typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf)
    .digest("hex");
}

describe("writeProjectFile — happy path", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-write-happy-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("creates a new file when allowCreate=true and expectedSha=''", async () => {
    const result = await writeProjectFile(root, "new.txt", "hello\n", "", {
      allowCreate: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.sha).toBe(sha("hello\n"));
    expect(result.size).toBe(Buffer.byteLength("hello\n"));
    expect(typeof result.mtime).toBe("number");
    expect(readFileSync(join(root, "new.txt"), "utf-8")).toBe("hello\n");
  });

  it("overwrites an existing file when expectedSha matches the on-disk sha", async () => {
    writeFileSync(join(root, "existing.txt"), "v1\n");
    const expected = sha("v1\n");
    const result = await writeProjectFile(root, "existing.txt", "v2\n", expected);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.sha).toBe(sha("v2\n"));
    expect(readFileSync(join(root, "existing.txt"), "utf-8")).toBe("v2\n");
  });

  it("returned sha can be used as expectedSha for the next write", async () => {
    const r1 = await writeProjectFile(root, "chain.txt", "a", "", {
      allowCreate: true,
    });
    if (!r1.ok) throw new Error("first write should succeed");
    const r2 = await writeProjectFile(root, "chain.txt", "b", r1.sha);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("unreachable");
    expect(r2.sha).toBe(sha("b"));
  });
});

describe("writeProjectFile — sha conflict", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-write-conflict-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns fs_sha_conflict with currentSha when expectedSha doesn't match", async () => {
    writeFileSync(join(root, "f.txt"), "actual\n");
    const result = await writeProjectFile(
      root,
      "f.txt",
      "new\n",
      "0".repeat(64), // wrong sha
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_sha_conflict");
    expect(result.currentSha).toBe(sha("actual\n"));
    // Original file untouched.
    expect(readFileSync(join(root, "f.txt"), "utf-8")).toBe("actual\n");
  });

  it("returns fs_sha_conflict with currentSha='' when file is missing and allowCreate=false", async () => {
    const result = await writeProjectFile(root, "absent.txt", "x", "");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_sha_conflict");
    expect(result.currentSha).toBe("");
  });

  it("returns fs_sha_conflict when file is missing and caller passed a non-empty expectedSha (even with allowCreate)", async () => {
    const result = await writeProjectFile(
      root,
      "absent.txt",
      "x",
      sha("guess"),
      { allowCreate: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_sha_conflict");
    expect(result.currentSha).toBe("");
  });
});

describe("writeProjectFile — input validation", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-write-input-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("returns fs_no_project_path when projectRoot is empty", async () => {
    const result = await writeProjectFile("", "x.txt", "x", "", {
      allowCreate: true,
    });
    expect(result).toMatchObject({ ok: false, error_code: "fs_no_project_path" });
  });

  it("returns fs_missing_path when relPath is empty", async () => {
    const result = await writeProjectFile(root, "", "x", "", {
      allowCreate: true,
    });
    expect(result).toMatchObject({ ok: false, error_code: "fs_missing_path" });
  });

  it("rejects absolute paths with fs_path_outside_project", async () => {
    const result = await writeProjectFile(root, "/etc/passwd", "x", "", {
      allowCreate: true,
    });
    expect(result).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("rejects `..` traversal with fs_path_outside_project", async () => {
    const result = await writeProjectFile(
      root,
      "../escape.txt",
      "x",
      "",
      { allowCreate: true },
    );
    expect(result).toMatchObject({ ok: false, error_code: "fs_path_outside_project" });
  });

  it("returns fs_too_large when payload exceeds MAX_READ_BYTES", async () => {
    const tooBig = "a".repeat(MAX_READ_BYTES + 1);
    const result = await writeProjectFile(root, "big.txt", tooBig, "", {
      allowCreate: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_too_large");
  });

  it("returns fs_not_found when parent directory does not exist", async () => {
    const result = await writeProjectFile(
      root,
      "missing-dir/file.txt",
      "x",
      "",
      { allowCreate: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_not_found");
  });
});

describe("writeProjectFile — atomic write semantics", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-write-atomic-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
    vi.restoreAllMocks();
  });

  it("fs_write_uses_temp_file_and_atomic_rename — original file unchanged when rename throws", async () => {
    writeFileSync(join(root, "f.txt"), "original\n");
    const expected = sha("original\n");

    // Monkey-patch fs.rename to throw — simulates a mid-write failure.
    const renameSpy = vi
      .spyOn(fsp, "rename")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("simulated rename failure"), {
          code: "EIO",
        });
      });

    const result = await writeProjectFile(
      root,
      "f.txt",
      "new content\n",
      expected,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("fs_io_error");
    expect(renameSpy).toHaveBeenCalled();

    // Atomic guarantee: original file's content + sha unchanged.
    expect(readFileSync(join(root, "f.txt"), "utf-8")).toBe("original\n");

    // Temp file must have been cleaned up — no `.flockctl-tmp-*` siblings.
    const leftover = readdirSync(root).filter((n) =>
      n.includes(".flockctl-tmp-"),
    );
    expect(leftover).toEqual([]);
  });

  it("does not leak temp files on writeFile failure", async () => {
    // Pre-write a file so we have a known baseline.
    writeFileSync(join(root, "f.txt"), "x");
    const writeSpy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      });

    const result = await writeProjectFile(root, "f.txt", "y", sha("x"));
    expect(result.ok).toBe(false);
    expect(writeSpy).toHaveBeenCalled();

    const leftover = readdirSync(root).filter((n) =>
      n.includes(".flockctl-tmp-"),
    );
    expect(leftover).toEqual([]);
  });
});

describe("writeProjectFile — concurrency", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-write-concurrent-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  it("fs_write_concurrent_two_clients_exactly_one_wins — sha-conflict surfaces on the loser", async () => {
    writeFileSync(join(root, "race.txt"), "v0\n");
    const expected = sha("v0\n");

    // Both writers race against the same expectedSha. With a per-file lock
    // and re-check inside the lock, the first one through commits the
    // rename and the second sees its sha-check fail (because the on-disk
    // content is now what the first writer left behind).
    const [r1, r2] = await Promise.all([
      writeProjectFile(root, "race.txt", "writer-1\n", expected),
      writeProjectFile(root, "race.txt", "writer-2\n", expected),
    ]);

    const winners = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (loser.ok) throw new Error("unreachable");
    expect(loser.error_code).toBe("fs_sha_conflict");
    // Loser's currentSha is the WINNER's content (the new on-disk state).
    const finalContent = readFileSync(join(root, "race.txt"), "utf-8");
    expect(loser.currentSha).toBe(sha(finalContent));
    // Final disk content is whichever writer won (one of the two).
    expect(["writer-1\n", "writer-2\n"]).toContain(finalContent);
  });

  it("serialised writes against the same path all succeed when each uses the previous sha", async () => {
    const r1 = await writeProjectFile(root, "seq.txt", "a", "", {
      allowCreate: true,
    });
    if (!r1.ok) throw new Error("step 1 failed");
    const r2 = await writeProjectFile(root, "seq.txt", "ab", r1.sha);
    if (!r2.ok) throw new Error("step 2 failed");
    const r3 = await writeProjectFile(root, "seq.txt", "abc", r2.sha);
    expect(r3.ok).toBe(true);
    expect(readFileSync(join(root, "seq.txt"), "utf-8")).toBe("abc");
  });
});
