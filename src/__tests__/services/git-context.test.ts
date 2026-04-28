import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-git-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

import { buildCodebaseContext } from "../../services/git-context.js";

describe("buildCodebaseContext", () => {
  it("returns empty string for nonexistent project", async () => {
    const result = await buildCodebaseContext(99999);
    expect(result).toBe("");
  });

  it("returns empty string for project with no path", async () => {
    const proj = db.insert(projects).values({ name: "no-path-proj" }).returning().get();
    const result = await buildCodebaseContext(proj!.id);
    expect(result).toBe("");
  });

  it("returns empty string for project with nonexistent path", async () => {
    const proj = db.insert(projects).values({
      name: "missing-path-proj",
      path: "/nonexistent/path/12345",
    }).returning().get();
    const result = await buildCodebaseContext(proj!.id);
    expect(result).toBe("");
  });

  it("builds file tree for project with real directory", async () => {
    // Create a project directory with some files
    const projPath = join(tmpBase, "real-proj");
    mkdirSync(join(projPath, "src"), { recursive: true });
    writeFileSync(join(projPath, "README.md"), "# Test Project\nThis is a test.");
    writeFileSync(join(projPath, "src", "index.ts"), "console.log('hello');");

    const proj = db.insert(projects).values({
      name: "real-proj",
      path: projPath,
    }).returning().get();

    const result = await buildCodebaseContext(proj!.id);

    // Should contain file tree
    expect(result).toContain("<file_tree>");
    expect(result).toContain("src/");
    expect(result).toContain("index.ts");

    // Should contain README
    expect(result).toContain("<readme>");
    expect(result).toContain("# Test Project");
  });

  it("includes git_status block for repo with untracked file", async () => {
    const projPath = join(tmpBase, "git-status-proj");
    mkdirSync(projPath, { recursive: true });
    const simpleGit = (await import("simple-git")).default;
    const git = simpleGit(projPath);
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");
    writeFileSync(join(projPath, "untracked.txt"), "hello");

    const proj = db.insert(projects).values({
      name: "git-status-proj",
      path: projPath,
    }).returning().get();

    const result = await buildCodebaseContext(proj!.id);
    expect(result).toContain("<git_status>");
    expect(result).toContain("untracked.txt");
  });

  it("swallows simple-git errors as non-fatal", async () => {
    // .git/ exists as a regular file (not a real git dir) → simple-git throws
    const projPath = join(tmpBase, "fake-git-proj");
    mkdirSync(projPath, { recursive: true });
    writeFileSync(join(projPath, ".git"), "this is not a git directory");
    const proj = db.insert(projects).values({
      name: "fake-git-proj",
      path: projPath,
    }).returning().get();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await buildCodebaseContext(proj!.id);
    // Tree still rendered; git_status block omitted
    expect(result).toContain("<file_tree>");
    expect(result).not.toContain("<git_status>");
    warnSpy.mockRestore();
  });

  it("omits git_status block when working tree is clean (no modified, no untracked)", async () => {
    const projPath = join(tmpBase, "clean-git-proj");
    mkdirSync(projPath, { recursive: true });
    const simpleGit = (await import("simple-git")).default;
    const git = simpleGit(projPath);
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test");
    // Commit a file so the tree is clean (no modified, no untracked).
    writeFileSync(join(projPath, "tracked.txt"), "hello");
    await git.add("tracked.txt");
    await git.commit("init");

    const proj = db
      .insert(projects)
      .values({ name: "clean-git-proj", path: projPath })
      .returning()
      .get();

    const result = await buildCodebaseContext(proj!.id);
    expect(result).toContain("<file_tree>");
    // Clean working tree → no git_status block.
    expect(result).not.toContain("<git_status>");
  });

  it("buildFileTree returns empty string at maxDepth (line 49 branch)", async () => {
    // A project with a deeply-nested directory ensures recursion hits the
    // `depth >= maxDepth` early-return on the inner-most call.
    const projPath = join(tmpBase, "deep-proj");
    mkdirSync(join(projPath, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(projPath, "a", "b", "c", "d", "deep.txt"), "");
    const proj = db
      .insert(projects)
      .values({ name: "deep-proj", path: projPath })
      .returning()
      .get();

    const result = await buildCodebaseContext(proj!.id);
    // The 3-level cap means the d/ contents must NOT appear.
    expect(result).not.toContain("deep.txt");
  });

  it("buildFileTree sorts directories before files at the same depth", async () => {
    // Both branches of the sort comparator: dir-vs-file (a.isDirectory()
    // !== b.isDirectory()) and dir-vs-dir (same isDirectory result, fall
    // through to localeCompare).
    const projPath = join(tmpBase, "sort-proj");
    mkdirSync(join(projPath, "z_dir"), { recursive: true });
    mkdirSync(join(projPath, "a_dir"), { recursive: true });
    writeFileSync(join(projPath, "b_file.txt"), "");
    writeFileSync(join(projPath, "a_file.txt"), "");
    const proj = db
      .insert(projects)
      .values({ name: "sort-proj", path: projPath })
      .returning()
      .get();

    const result = await buildCodebaseContext(proj!.id);
    // a_dir should appear before z_dir; both directories before files.
    const idxADir = result.indexOf("a_dir/");
    const idxZDir = result.indexOf("z_dir/");
    const idxAFile = result.indexOf("a_file.txt");
    expect(idxADir).toBeGreaterThan(-1);
    expect(idxZDir).toBeGreaterThan(idxADir);
    expect(idxAFile).toBeGreaterThan(idxZDir);
  });

  it("ignores node_modules and .git directories in tree", async () => {
    const projPath = join(tmpBase, "ignore-proj");
    mkdirSync(join(projPath, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(projPath, ".git", "objects"), { recursive: true });
    mkdirSync(join(projPath, "src"), { recursive: true });
    writeFileSync(join(projPath, "src", "app.ts"), "");
    writeFileSync(join(projPath, "node_modules", "pkg", "index.js"), "");

    const proj = db.insert(projects).values({
      name: "ignore-proj",
      path: projPath,
    }).returning().get();

    const result = await buildCodebaseContext(proj!.id);
    expect(result).toContain("src/");
    expect(result).not.toContain("node_modules");
    // .git should be ignored (hidden dirs are filtered)
    expect(result).not.toContain("objects");
  });
});
