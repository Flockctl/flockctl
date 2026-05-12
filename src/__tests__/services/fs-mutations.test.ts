import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  mkdirInRoot,
  createFileInRoot,
  renameInRoot,
  deleteInRoot,
  MAX_CREATE_BYTES,
  __resetRealRootCacheForTests,
} from "../../services/fs-operations.js";

/**
 * Service-level tests for the four mutation helpers backing
 * `POST /:id/fs/op`. Pure-function: no DB, no Hono, no router. The
 * route-layer test (`routes/projects-fs-op.test.ts`) covers the audit-row
 * contract; this file pins the security and correctness invariants the
 * service layer must guarantee on its own.
 *
 * Each test gets a fresh tmp root in `beforeEach` so symlink fixtures /
 * recursive-delete state from one case cannot leak into another.
 */

describe("fs-mutations", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flockctl-fs-mut-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    __resetRealRootCacheForTests();
  });

  // ─── mkdirInRoot ────────────────────────────────────────────────────────

  describe("mkdirInRoot", () => {
    it("creates a directory under the root", async () => {
      const got = await mkdirInRoot(root, "newdir");
      expect(got).toEqual({ ok: true });
      expect(statSync(join(root, "newdir")).isDirectory()).toBe(true);
    });

    it("creates a nested directory when the parent exists", async () => {
      mkdirSync(join(root, "a"));
      const got = await mkdirInRoot(root, "a/b");
      expect(got.ok).toBe(true);
      expect(statSync(join(root, "a", "b")).isDirectory()).toBe(true);
    });

    it("returns fs_already_exists when target is a file", async () => {
      writeFileSync(join(root, "x"), "");
      const got = await mkdirInRoot(root, "x");
      expect(got).toMatchObject({ ok: false, error_code: "fs_already_exists" });
    });

    it("returns fs_already_exists when target is a directory", async () => {
      mkdirSync(join(root, "exist"));
      const got = await mkdirInRoot(root, "exist");
      expect(got).toMatchObject({ ok: false, error_code: "fs_already_exists" });
    });

    it("returns fs_not_found when parent directory is missing (non-recursive)", async () => {
      const got = await mkdirInRoot(root, "no-parent/child");
      expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
    });

    it("rejects path-jail escapes", async () => {
      const got = await mkdirInRoot(root, "../escape");
      expect(got.ok).toBe(false);
      if (got.ok) throw new Error("unreachable");
      expect(got.error_code).toBe("fs_path_outside_root");
    });

    it("rejects absolute paths", async () => {
      const got = await mkdirInRoot(root, "/etc/evil");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_path" });
    });

    it("refuses .git as fs_invalid_name", async () => {
      const got = await mkdirInRoot(root, ".git");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("refuses paths beneath .git/ as fs_invalid_name", async () => {
      const got = await mkdirInRoot(root, ".git/hooks");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("refuses top-level node_modules as fs_invalid_name", async () => {
      const got = await mkdirInRoot(root, "node_modules");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("refuses creating root as fs_invalid_name", async () => {
      const got = await mkdirInRoot(root, "");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("returns fs_no_path when root is empty", async () => {
      const got = await mkdirInRoot("", "anything");
      expect(got).toMatchObject({ ok: false, error_code: "fs_no_path" });
    });
  });

  // ─── createFileInRoot ───────────────────────────────────────────────────

  describe("createFileInRoot", () => {
    it("creates a file with content", async () => {
      const got = await createFileInRoot(root, "hello.txt", "hi\n");
      expect(got).toEqual({ ok: true });
      expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("hi\n");
    });

    it("creates an empty file when content is omitted", async () => {
      const got = await createFileInRoot(root, "empty.txt");
      expect(got.ok).toBe(true);
      expect(readFileSync(join(root, "empty.txt"), "utf-8")).toBe("");
    });

    it("returns fs_already_exists when file is already there", async () => {
      writeFileSync(join(root, "existing.txt"), "old");
      const got = await createFileInRoot(root, "existing.txt", "new");
      expect(got).toMatchObject({ ok: false, error_code: "fs_already_exists" });
      // Atomic — original content preserved.
      expect(readFileSync(join(root, "existing.txt"), "utf-8")).toBe("old");
    });

    it("returns fs_not_found when parent directory is missing", async () => {
      const got = await createFileInRoot(root, "missing/file.txt", "x");
      expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
    });

    it("rejects content above MAX_CREATE_BYTES with fs_too_large", async () => {
      const huge = "a".repeat(MAX_CREATE_BYTES + 1);
      const got = await createFileInRoot(root, "huge.txt", huge);
      expect(got).toMatchObject({ ok: false, error_code: "fs_too_large" });
      expect(existsSync(join(root, "huge.txt"))).toBe(false);
    });

    it("refuses .git/config as fs_invalid_name", async () => {
      const got = await createFileInRoot(root, ".git/config", "[core]\n");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("rejects path-jail escapes", async () => {
      const got = await createFileInRoot(root, "../escape.txt", "");
      expect(got.ok).toBe(false);
      if (got.ok) throw new Error("unreachable");
      expect(got.error_code).toBe("fs_path_outside_root");
    });
  });

  // ─── renameInRoot ───────────────────────────────────────────────────────

  describe("renameInRoot", () => {
    it("renames a file", async () => {
      writeFileSync(join(root, "a.txt"), "x");
      const got = await renameInRoot(root, "a.txt", "b.txt");
      expect(got).toEqual({ ok: true });
      expect(existsSync(join(root, "a.txt"))).toBe(false);
      expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("x");
    });

    it("moves a file into a subdirectory", async () => {
      writeFileSync(join(root, "a.txt"), "x");
      mkdirSync(join(root, "sub"));
      const got = await renameInRoot(root, "a.txt", "sub/a.txt");
      expect(got.ok).toBe(true);
      expect(existsSync(join(root, "sub", "a.txt"))).toBe(true);
    });

    it("renames a directory", async () => {
      mkdirSync(join(root, "old"));
      writeFileSync(join(root, "old", "f"), "");
      const got = await renameInRoot(root, "old", "new");
      expect(got.ok).toBe(true);
      expect(existsSync(join(root, "new", "f"))).toBe(true);
    });

    it("returns fs_already_exists when target file exists", async () => {
      writeFileSync(join(root, "a.txt"), "1");
      writeFileSync(join(root, "b.txt"), "2");
      const got = await renameInRoot(root, "a.txt", "b.txt");
      expect(got).toMatchObject({ ok: false, error_code: "fs_already_exists" });
      // Both originals untouched (refused before rename).
      expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("1");
      expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("2");
    });

    it("refuses targets in .git", async () => {
      writeFileSync(join(root, "f.txt"), "");
      const got = await renameInRoot(root, "f.txt", ".git/sneaky");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("refuses sources in .git", async () => {
      const got = await renameInRoot(root, ".git/HEAD", "stolen");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("rejects path-jail escapes on either side", async () => {
      writeFileSync(join(root, "f.txt"), "");
      const a = await renameInRoot(root, "f.txt", "../escape.txt");
      expect(a.ok).toBe(false);
      if (a.ok) throw new Error("unreachable");
      expect(a.error_code).toBe("fs_path_outside_root");

      const b = await renameInRoot(root, "../etc/passwd", "f2.txt");
      expect(b.ok).toBe(false);
      if (b.ok) throw new Error("unreachable");
      expect(b.error_code).toBe("fs_path_outside_root");
    });

    it("returns fs_not_found when source is missing", async () => {
      const got = await renameInRoot(root, "no.txt", "yes.txt");
      expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
    });

    it("refuses an existing symlink at the target", async () => {
      writeFileSync(join(root, "a.txt"), "");
      try {
        symlinkSync("/etc", join(root, "linked"));
      } catch {
        // sandbox without symlink support — skip
        return;
      }
      const got = await renameInRoot(root, "a.txt", "linked");
      expect(got).toMatchObject({ ok: false, error_code: "fs_already_exists" });
    });
  });

  // ─── deleteInRoot ───────────────────────────────────────────────────────

  describe("deleteInRoot", () => {
    it("deletes a file", async () => {
      writeFileSync(join(root, "f.txt"), "");
      const got = await deleteInRoot(root, "f.txt");
      expect(got).toEqual({ ok: true });
      expect(existsSync(join(root, "f.txt"))).toBe(false);
    });

    it("deletes an empty directory", async () => {
      mkdirSync(join(root, "empty"));
      const got = await deleteInRoot(root, "empty");
      expect(got.ok).toBe(true);
      expect(existsSync(join(root, "empty"))).toBe(false);
    });

    it("returns fs_not_empty for non-empty directory without recursive", async () => {
      mkdirSync(join(root, "d"));
      writeFileSync(join(root, "d", "f"), "");
      const got = await deleteInRoot(root, "d");
      expect(got).toMatchObject({ ok: false, error_code: "fs_not_empty" });
      // Must not have deleted anything.
      expect(existsSync(join(root, "d", "f"))).toBe(true);
    });

    it("deletes a non-empty directory when recursive=true", async () => {
      mkdirSync(join(root, "d"));
      writeFileSync(join(root, "d", "f"), "");
      mkdirSync(join(root, "d", "sub"));
      writeFileSync(join(root, "d", "sub", "g"), "");
      const got = await deleteInRoot(root, "d", { recursive: true });
      expect(got.ok).toBe(true);
      expect(existsSync(join(root, "d"))).toBe(false);
    });

    it("returns fs_not_found for a missing path", async () => {
      const got = await deleteInRoot(root, "nope");
      expect(got).toMatchObject({ ok: false, error_code: "fs_not_found" });
    });

    it("refuses .git as fs_invalid_name even with recursive=true", async () => {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      const got = await deleteInRoot(root, ".git", { recursive: true });
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
      // Must not have deleted .git or its contents.
      expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
    });

    it("refuses paths under .git/ as fs_invalid_name", async () => {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "x");
      const got = await deleteInRoot(root, ".git/HEAD");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
      expect(existsSync(join(root, ".git", "HEAD"))).toBe(true);
    });

    it("refuses top-level node_modules as fs_invalid_name", async () => {
      mkdirSync(join(root, "node_modules"));
      const got = await deleteInRoot(root, "node_modules", { recursive: true });
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
      expect(existsSync(join(root, "node_modules"))).toBe(true);
    });

    it("refuses deleting root as fs_invalid_name", async () => {
      const got = await deleteInRoot(root, "");
      expect(got).toMatchObject({ ok: false, error_code: "fs_invalid_name" });
    });

    it("rejects path-jail escapes", async () => {
      const got = await deleteInRoot(root, "../etc/passwd", { recursive: true });
      expect(got.ok).toBe(false);
      if (got.ok) throw new Error("unreachable");
      expect(got.error_code).toBe("fs_path_outside_root");
    });
  });
});
