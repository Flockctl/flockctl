import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  listProjectDir,
  resolveSafePath,
  LIST_ENTRY_CAP,
} from "../../services/fs-operations.js";
import { _clearGitignoreCacheForTests } from "../../services/fs-gitignore.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-list-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test gets a fresh gitignore cache so a previous fixture's `.gitignore`
  // can't leak into the next test under the 1 s TTL.
  _clearGitignoreCacheForTests();
});

function makeProject(
  name: string,
  files: Record<string, string>,
  dirs: string[] = [],
): string {
  const root = join(tmpRoot, name);
  mkdirSync(root, { recursive: true });
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("resolveSafePath", () => {
  const root = "/tmp/proj-root";

  it("treats empty string as the root itself", () => {
    const r = resolveSafePath(root, "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe(".");
  });

  it("rejects absolute paths even when they resolve back inside root", () => {
    const r = resolveSafePath(root, "/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_invalid_path");
  });

  it("rejects NUL bytes in the path", () => {
    const r = resolveSafePath(root, "src/\0evil");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_invalid_path");
  });

  it("rejects ../ traversal that escapes the root", () => {
    const r = resolveSafePath(root, "../../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_path_outside_root");
  });

  it("accepts ../ that collapses back inside root", () => {
    const r = resolveSafePath(root, "src/../docs");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("docs");
  });

  it("returns fs_no_path when root is empty", () => {
    const r = resolveSafePath("", "src");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_no_path");
  });
});

describe("listProjectDir", () => {
  it("returns directory-first / alphabetical entries", async () => {
    const root = makeProject(
      "alpha",
      { "z.txt": "z", "a.txt": "a", "m.txt": "m" },
      ["zeta", "beta"],
    );

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const names = r.entries.map((e) => `${e.type}:${e.name}`);
    expect(names).toEqual([
      "dir:beta",
      "dir:zeta",
      "file:a.txt",
      "file:m.txt",
      "file:z.txt",
    ]);
    expect(r.path).toBe(".");
    expect(r.truncated).toBe(false);
  });

  it("includes file size and mtime, omits size for directories", async () => {
    const root = makeProject(
      "stats",
      { "small.txt": "abc", "big.txt": "x".repeat(2048) },
      ["sub"],
    );

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const small = r.entries.find((e) => e.name === "small.txt")!;
    const big = r.entries.find((e) => e.name === "big.txt")!;
    const sub = r.entries.find((e) => e.name === "sub")!;

    expect(small.size).toBe(3);
    expect(big.size).toBe(2048);
    expect(sub.size).toBeUndefined();
    expect(typeof small.mtime).toBe("number");
    expect(typeof sub.mtime).toBe("number");
  });

  it("reports hasChildren on directories with content", async () => {
    const root = makeProject("has-children", {
      "full/inner.txt": "",
    }, ["empty"]);

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const full = r.entries.find((e) => e.name === "full")!;
    const empty = r.entries.find((e) => e.name === "empty")!;
    expect(full.type).toBe("dir");
    expect(full.hasChildren).toBe(true);
    expect(empty.type).toBe("dir");
    expect(empty.hasChildren).toBe(false);
  });

  it("marks .gitignore-ed entries as ignored:true and respects always-on defaults", async () => {
    const root = makeProject(
      "gitignored",
      {
        ".gitignore": "build/\n*.log\n",
        "keep.txt": "k",
        "noise.log": "x",
      },
      ["build", "node_modules", ".git"],
    );

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e.ignored]));
    expect(byName["keep.txt"]).toBe(false);
    expect(byName[".gitignore"]).toBe(false);
    expect(byName["noise.log"]).toBe(true);
    expect(byName["build"]).toBe(true);
    // Always-on defaults bite even without an explicit rule.
    expect(byName["node_modules"]).toBe(true);
    expect(byName[".git"]).toBe(true);
  });

  it("returns fs_not_found for a missing path", async () => {
    const root = makeProject("missing-host", { "real.txt": "y" });
    const r = await listProjectDir(root, "does-not-exist");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_not_found");
  });

  it("returns fs_not_a_directory when caller asks to list a file", async () => {
    const root = makeProject("not-a-dir", { "thing.txt": "y" });
    const r = await listProjectDir(root, "thing.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_not_a_directory");
  });

  it("returns fs_path_outside_root for ../ escape", async () => {
    const root = makeProject("escape-host", { "ok.txt": "y" });
    const r = await listProjectDir(root, "../../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("fs_path_outside_root");
  });

  it("caps entries at LIST_ENTRY_CAP and sets truncated:true", async () => {
    // Construct a directory with `cap+5` files. We don't assert the cap value
    // (it's the constant) — we assert the behaviour: result length === cap,
    // truncated flag flips.
    const cap = LIST_ENTRY_CAP;
    const files: Record<string, string> = {};
    // Use `tiny-N` so the alphabetical sort is deterministic.
    for (let i = 0; i < cap + 5; i += 1) {
      files[`f-${String(i).padStart(6, "0")}.txt`] = "";
    }
    const root = makeProject("trunc", files);

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.length).toBe(cap);
    expect(r.truncated).toBe(true);
  });

  it("lists a nested directory by relative path and returns the relative path back", async () => {
    const root = makeProject(
      "nested",
      { "src/lib/util.ts": "", "src/lib/index.ts": "" },
      ["src/lib"],
    );

    const r = await listProjectDir(root, "src/lib");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.path).toBe("src/lib");
    expect(r.entries.map((e) => e.name).sort()).toEqual([
      "index.ts",
      "util.ts",
    ]);
  });

  it("propagates gitignore rules to nested entries via their relative path", async () => {
    const root = makeProject(
      "nested-gitignore",
      {
        ".gitignore": "src/secret.ts\n",
        "src/secret.ts": "",
        "src/public.ts": "",
      },
      ["src"],
    );
    const r = await listProjectDir(root, "src");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e.ignored]));
    expect(byName["secret.ts"]).toBe(true);
    expect(byName["public.ts"]).toBe(false);
  });

  it("classifies a symlink to a file as type:file", async () => {
    const root = makeProject("symlink", { "real.txt": "y" });
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));

    const r = await listProjectDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const alias = r.entries.find((e) => e.name === "alias.txt");
    expect(alias?.type).toBe("file");
  });
});
