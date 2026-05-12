import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { setDb } from "../../db/index.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { _clearGitignoreCacheForTests } from "../../services/fs-gitignore.js";

/**
 * End-to-end tests for `GET /projects/:id/fs/list` (and the workspace
 * mirror). The route writes nothing — the only persistence side effect is
 * an audit log line on stderr — so we rely on real on-disk fixtures plus the
 * in-memory DB for entity rows.
 */

describe("GET /projects/:id/fs/list", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-list-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    _clearGitignoreCacheForTests();
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeProj(name: string): string {
    const root = join(tmpRoot, name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("returns 404 when the project does not exist", async () => {
    const res = await app.request("/projects/999999/fs/list");
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/fs/list`);
    expect(res.status).toBe(422);
  });

  it("returns 200 with ok:true and sorted entries for the root listing", async () => {
    const root = makeProj("happy-path");
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "x.ts"), "");

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/list`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe(".");
    expect(body.truncated).toBe(false);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["src", "a.txt"]);
  });

  it("respects the ?path= query for nested directories", async () => {
    const root = makeProj("nested-q");
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "y.ts"), "");

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(
      `/projects/${id}/fs/list?path=${encodeURIComponent("src/lib")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe("src/lib");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].name).toBe("y.ts");
  });

  it("returns ok:false / fs_path_outside_root for ../ traversal", async () => {
    const root = makeProj("escape");
    writeFileSync(join(root, "ok.txt"), "");

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(
      `/projects/${id}/fs/list?path=${encodeURIComponent("../../etc")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("fs_path_outside_root");
  });

  it("returns ok:false / fs_invalid_path for absolute paths", async () => {
    const root = makeProj("abs");
    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(
      `/projects/${id}/fs/list?path=${encodeURIComponent("/etc/passwd")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("fs_invalid_path");
  });

  it("returns ok:false / fs_not_found for a missing path", async () => {
    const root = makeProj("missing-q");
    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/list?path=does-not-exist`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("fs_not_found");
  });

  it("returns ok:false / fs_not_a_directory when target is a file", async () => {
    const root = makeProj("file-q");
    writeFileSync(join(root, "thing.txt"), "x");
    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/list?path=thing.txt`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("fs_not_a_directory");
  });

  it("flags .gitignore entries on a project listing", async () => {
    const root = makeProj("gi");
    writeFileSync(join(root, ".gitignore"), "secret.log\n");
    writeFileSync(join(root, "secret.log"), "x");
    writeFileSync(join(root, "public.txt"), "");
    mkdirSync(join(root, "node_modules"));

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/list`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const flags = Object.fromEntries(
      body.entries.map((e: { name: string; ignored: boolean }) => [
        e.name,
        e.ignored,
      ]),
    );
    expect(flags["secret.log"]).toBe(true);
    expect(flags["public.txt"]).toBe(false);
    // Always-on default still applies even though .gitignore doesn't list it.
    expect(flags["node_modules"]).toBe(true);
  });

  it("populates hasChildren on directory entries", async () => {
    const root = makeProj("has-children-route");
    mkdirSync(join(root, "full"));
    writeFileSync(join(root, "full", "x.txt"), "");
    mkdirSync(join(root, "empty"));

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/list`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const byName = Object.fromEntries(
      body.entries.map((e: { name: string; hasChildren?: boolean }) => [
        e.name,
        e.hasChildren,
      ]),
    );
    expect(byName["full"]).toBe(true);
    expect(byName["empty"]).toBe(false);
  });
});

describe("GET /workspaces/:id/fs/list", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-list-ws-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    _clearGitignoreCacheForTests();
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("mirrors the project handler against a workspace path", async () => {
    const root = join(tmpRoot, "ws-mirror");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), "");
    mkdirSync(join(root, "projects"));

    const id = seedWorkspace(testDb.sqlite, { path: root });
    const res = await app.request(`/workspaces/${id}/fs/list`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
      "projects",
      "README.md",
    ]);
  });
});
