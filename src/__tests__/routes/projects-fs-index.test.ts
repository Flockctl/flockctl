import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync } from "zlib";
import { app } from "../../server.js";
import { setDb } from "../../db/index.js";
import { createTestDb, seedProject, seedWorkspace } from "../helpers.js";
import { _clearGitignoreCacheForTests } from "../../services/fs-gitignore.js";
import { _clearIndexCacheForTests } from "../../services/fs-operations.js";

/**
 * End-to-end coverage for `GET /:id/fs/index` (project + workspace mirrors)
 * and the gzip wire encoding the global compress middleware applies.
 */

describe("GET /:id/fs/index", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-index-route-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    _clearGitignoreCacheForTests();
    _clearIndexCacheForTests();
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
    const res = await app.request("/projects/999999/fs/index");
    expect(res.status).toBe(404);
  });

  it("returns 422 when the project has no path", async () => {
    const id = seedProject(testDb.sqlite, {});
    const res = await app.request(`/projects/${id}/fs/index`);
    expect(res.status).toBe(422);
  });

  it("returns 200 with ok:true and a flat path list", async () => {
    const root = makeProj("happy");
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "x.ts"), "");
    writeFileSync(join(root, "src", "y.ts"), "");

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/index`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(false);
    const sorted = [...body.paths].sort();
    expect(sorted).toEqual(["a.txt", "src/x.ts", "src/y.ts"]);
  });

  it("excludes .git and gitignored paths in the response", async () => {
    const root = makeProj("ignores");
    writeFileSync(join(root, ".gitignore"), "build/\nsecret.txt\n");
    writeFileSync(join(root, "ok.txt"), "");
    writeFileSync(join(root, "secret.txt"), "");
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build", "out.js"), "");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref\n");

    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/index`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.paths).toContain("ok.txt");
    expect(body.paths).toContain(".gitignore");
    expect(body.paths).not.toContain("secret.txt");
    for (const p of body.paths as string[]) {
      expect(p.startsWith("build/")).toBe(false);
      expect(p.startsWith(".git/")).toBe(false);
    }
  });

  it("returns ok:false / fs_not_found when the project root no longer exists", async () => {
    const root = makeProj("missing-root");
    rmSync(root, { recursive: true, force: true });
    const id = seedProject(testDb.sqlite, { path: root });
    const res = await app.request(`/projects/${id}/fs/index`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("fs_not_found");
  });

  it("compresses the response when the client asks for gzip and the body crosses the 1 KiB threshold", async () => {
    const root = makeProj("gzipped");
    // Generate enough files that the JSON body exceeds the compress
    // middleware's 1024-byte threshold by a comfortable margin.
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(root, `file-${i}-with-a-long-filename.txt`), "");
    }
    const id = seedProject(testDb.sqlite, { path: root });

    const res = await app.request(`/projects/${id}/fs/index`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");

    // Sanity-check we can decode the gzipped body and recover the JSON.
    const buf = Buffer.from(await res.arrayBuffer());
    const json = JSON.parse(gunzipSync(buf).toString("utf-8"));
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.paths)).toBe(true);
    expect(json.paths.length).toBe(200);
  });

  it("does not gzip when the client does not advertise an encoding", async () => {
    const root = makeProj("identity");
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(join(root, `file-${i}-with-a-long-filename.txt`), "");
    }
    const id = seedProject(testDb.sqlite, { path: root });

    const res = await app.request(`/projects/${id}/fs/index`);
    expect(res.status).toBe(200);
    // No Accept-Encoding ⇒ identity transfer. Hono leaves Content-Encoding
    // unset rather than emitting `identity`.
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("GET /workspaces/:id/fs/index", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const tmpRoot = mkdtempSync(join(tmpdir(), "flockctl-fs-index-ws-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  beforeEach(() => {
    _clearGitignoreCacheForTests();
    _clearIndexCacheForTests();
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns the same flat-list shape for workspaces", async () => {
    const root = join(tmpRoot, "ws");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.txt"), "");
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "x.ts"), "");

    const id = seedWorkspace(testDb.sqlite, { path: root });
    const res = await app.request(`/workspaces/${id}/fs/index`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(false);
    const sorted = [...body.paths].sort();
    expect(sorted).toEqual(["a.txt", "lib/x.ts"]);
  });
});
