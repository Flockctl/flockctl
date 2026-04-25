import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<any>("child_process");
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { app } from "../../server.js";
import { execSync } from "child_process";

let db: FlockctlDb;
let sqlite: Database.Database;
let tempDir: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-agentsmd-"));
});

afterAll(() => {
  sqlite.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM usage_records;
    DELETE FROM tasks;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
  (execSync as any).mockReset();
  (execSync as any).mockImplementation(() => Buffer.from(""));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject(name: string): { id: number; path: string } {
  const path = mkdtempSync(join(tempDir, `proj-${name}-`));
  const row = db
    .insert(projects)
    .values({ name, path })
    .returning()
    .get()!;
  return { id: row.id, path };
}

function mkWorkspace(name: string): { id: number; path: string } {
  const path = mkdtempSync(join(tempDir, `ws-${name}-`));
  const row = db
    .insert(workspaces)
    .values({ name, path })
    .returning()
    .get()!;
  return { id: row.id, path };
}

async function getJson(url: string) {
  const r = await app.request(url);
  return { status: r.status, body: await r.json() };
}

async function putJson(url: string, body: unknown) {
  const r = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ---------------------------------------------------------------------------
// Project endpoints — single public layer (`project-public`).
// ---------------------------------------------------------------------------

describe("GET /projects/:id/agents-md — per-layer shape", () => {
  it("returns the project-public layer absent when no file exists on disk", async () => {
    const p = mkProject("empty");
    const { status, body } = await getJson(`/projects/${p.id}/agents-md`);
    expect(status).toBe(200);
    expect(body.layers).toBeDefined();
    expect(body.layers["project-public"]).toEqual({
      present: false,
      bytes: 0,
      content: "",
    });
    // Private layers were retired; the response MUST NOT expose them.
    expect(body.layers["project-private"]).toBeUndefined();
  });

  it("reads project-public from <project>/AGENTS.md", async () => {
    const p = mkProject("present");
    writeFileSync(join(p.path, "AGENTS.md"), "PUBLIC");

    const { status, body } = await getJson(`/projects/${p.id}/agents-md`);
    expect(status).toBe(200);
    expect(body.layers["project-public"]).toMatchObject({
      present: true,
      content: "PUBLIC",
      bytes: 6,
    });
  });

  it("returns the project-public layer absent when project has no filesystem path", async () => {
    const row = db.insert(projects).values({ name: "no-path" }).returning().get()!;
    const { status, body } = await getJson(`/projects/${row.id}/agents-md`);
    expect(status).toBe(200);
    expect(body.layers["project-public"].present).toBe(false);
  });

  it("404 when project missing", async () => {
    const { status } = await getJson(`/projects/999999/agents-md`);
    expect(status).toBe(404);
  });
});

describe("PUT /projects/:id/agents-md — single public layer", () => {
  it("writes to <project>/AGENTS.md and returns {layer, present, bytes}", async () => {
    const p = mkProject("put-public");
    const { status, body } = await putJson(`/projects/${p.id}/agents-md`, {
      content: "# Public rules",
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      layer: "project-public",
      present: true,
      bytes: Buffer.byteLength("# Public rules", "utf-8"),
    });
    expect(readFileSync(join(p.path, "AGENTS.md"), "utf-8")).toBe("# Public rules");
    // No private `.flockctl/AGENTS.md` should be created.
    expect(existsSync(join(p.path, ".flockctl", "AGENTS.md"))).toBe(false);
  });

  it("empty content deletes the file (does not leave an empty file behind)", async () => {
    const p = mkProject("delete-on-empty");
    writeFileSync(join(p.path, "AGENTS.md"), "something");
    expect(existsSync(join(p.path, "AGENTS.md"))).toBe(true);

    const { status, body } = await putJson(`/projects/${p.id}/agents-md`, {
      content: "",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ layer: "project-public", present: false, bytes: 0 });
    expect(existsSync(join(p.path, "AGENTS.md"))).toBe(false);
  });

  it("empty content on a project that has no file is a no-op (200)", async () => {
    const p = mkProject("empty-on-missing");
    const { status, body } = await putJson(`/projects/${p.id}/agents-md`, {
      content: "",
    });
    expect(status).toBe(200);
    expect(body.present).toBe(false);
    expect(existsSync(join(p.path, "AGENTS.md"))).toBe(false);
  });

  it("ignores any legacy `layer` field in the body — always writes project-public", async () => {
    // Old clients may still send `layer: "project-private"`; the route now
    // ignores that field and writes the single public layer unconditionally.
    const p = mkProject("legacy-layer");
    const { status, body } = await putJson(`/projects/${p.id}/agents-md`, {
      layer: "project-private",
      content: "keeps-writing",
    });
    expect(status).toBe(200);
    expect(body.layer).toBe("project-public");
    expect(readFileSync(join(p.path, "AGENTS.md"), "utf-8")).toBe("keeps-writing");
    expect(existsSync(join(p.path, ".flockctl", "AGENTS.md"))).toBe(false);
  });

  it("returns 413 for oversized content (> 256 KiB)", async () => {
    const p = mkProject("oversize");
    const { status } = await putJson(`/projects/${p.id}/agents-md`, {
      content: "x".repeat(300_000),
    });
    expect(status).toBe(413);
    expect(existsSync(join(p.path, "AGENTS.md"))).toBe(false);
  });

  it("non-string content is coerced to '' (which deletes the file)", async () => {
    const p = mkProject("nonstr");
    writeFileSync(join(p.path, "AGENTS.md"), "old");
    const { status, body } = await putJson(`/projects/${p.id}/agents-md`, {
      content: 42,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ layer: "project-public", present: false, bytes: 0 });
    expect(existsSync(join(p.path, "AGENTS.md"))).toBe(false);
  });

  it("404 when project missing", async () => {
    const { status } = await putJson(`/projects/999999/agents-md`, {
      content: "x",
    });
    expect(status).toBe(404);
  });

  it("422 when project has no filesystem path", async () => {
    const row = db.insert(projects).values({ name: "no-path-put" }).returning().get()!;
    const { status } = await putJson(`/projects/${row.id}/agents-md`, {
      content: "x",
    });
    expect(status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Workspace endpoints — single public layer (`workspace-public`).
// ---------------------------------------------------------------------------

describe("GET /workspaces/:id/agents-md — per-layer shape", () => {
  it("returns the workspace-public layer absent when no file exists on disk", async () => {
    const w = mkWorkspace("empty");
    const { status, body } = await getJson(`/workspaces/${w.id}/agents-md`);
    expect(status).toBe(200);
    expect(body.layers["workspace-public"]).toEqual({
      present: false,
      bytes: 0,
      content: "",
    });
    expect(body.layers["workspace-private"]).toBeUndefined();
  });

  it("reads workspace-public from <workspace>/AGENTS.md", async () => {
    const w = mkWorkspace("present");
    writeFileSync(join(w.path, "AGENTS.md"), "WS_PUB");

    const { body } = await getJson(`/workspaces/${w.id}/agents-md`);
    expect(body.layers["workspace-public"].content).toBe("WS_PUB");
  });

  it("404 when workspace missing", async () => {
    const { status } = await getJson(`/workspaces/999999/agents-md`);
    expect(status).toBe(404);
  });
});

describe("PUT /workspaces/:id/agents-md — single public layer", () => {
  it("writes to <workspace>/AGENTS.md", async () => {
    const w = mkWorkspace("put-public");
    const { status, body } = await putJson(`/workspaces/${w.id}/agents-md`, {
      content: "WS RULES",
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      layer: "workspace-public",
      present: true,
      bytes: 8,
    });
    expect(readFileSync(join(w.path, "AGENTS.md"), "utf-8")).toBe("WS RULES");
  });

  it("ignores any legacy `layer` field in the body — always writes workspace-public", async () => {
    const w = mkWorkspace("legacy-layer");
    const { status, body } = await putJson(`/workspaces/${w.id}/agents-md`, {
      layer: "workspace-private",
      content: "keeps-writing",
    });
    expect(status).toBe(200);
    expect(body.layer).toBe("workspace-public");
    expect(readFileSync(join(w.path, "AGENTS.md"), "utf-8")).toBe(
      "keeps-writing",
    );
    expect(existsSync(join(w.path, ".flockctl", "AGENTS.md"))).toBe(false);
  });

  it("returns 413 for oversized content (> 256 KiB)", async () => {
    const w = mkWorkspace("oversize");
    const { status } = await putJson(`/workspaces/${w.id}/agents-md`, {
      content: "x".repeat(300_000),
    });
    expect(status).toBe(413);
  });

  it("404 when workspace missing", async () => {
    const { status } = await putJson(`/workspaces/999999/agents-md`, {
      content: "x",
    });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Effective (merged) endpoint — GET /projects/:id/agents-md/effective.
// Asserts the three layers resolve in the documented order and that the
// `mergedWithHeaders` / `totalBytes` shape from `loadAgentGuidance` is passed
// through verbatim.
// ---------------------------------------------------------------------------

describe("get_project_agents_md_effective_returns_merged_layers", () => {
  it("resolves the three public layers in order with matching totalBytes and merge markers", async () => {
    const savedHome = process.env.FLOCKCTL_HOME;
    const fakeHome = mkdtempSync(join(tempDir, "fc-home-"));
    process.env.FLOCKCTL_HOME = fakeHome;
    try {
      // Layer 1: user
      writeFileSync(join(fakeHome, "AGENTS.md"), "MARK_USER");

      // Workspace + layer 2
      const w = mkWorkspace("eff");
      writeFileSync(join(w.path, "AGENTS.md"), "MARK_WS_PUB");

      // Project inside the workspace + layer 3
      const pPath = mkdtempSync(join(w.path, "proj-eff-"));
      writeFileSync(join(pPath, "AGENTS.md"), "MARK_PROJ_PUB");
      const pRow = db
        .insert(projects)
        .values({ name: "eff", workspaceId: w.id, path: pPath })
        .returning()
        .get()!;

      const { status, body } = await getJson(
        `/projects/${pRow.id}/agents-md/effective`,
      );
      expect(status).toBe(200);

      // Three layers, in the canonical load order.
      expect(Array.isArray(body.layers)).toBe(true);
      expect(body.layers.map((l: { layer: string }) => l.layer)).toEqual([
        "user",
        "workspace-public",
        "project-public",
      ]);

      // Each layer carries its marker content.
      const byName: Record<string, { content: string; bytes: number }> = {};
      for (const l of body.layers) byName[l.layer] = l;
      expect(byName.user!.content).toBe("MARK_USER");
      expect(byName["workspace-public"]!.content).toBe("MARK_WS_PUB");
      expect(byName["project-public"]!.content).toBe("MARK_PROJ_PUB");

      // totalBytes equals the sum of per-layer bytes.
      const summed = body.layers.reduce(
        (acc: number, l: { bytes: number }) => acc + l.bytes,
        0,
      );
      expect(body.totalBytes).toBe(summed);

      // mergedWithHeaders contains every marker.
      for (const marker of ["MARK_USER", "MARK_WS_PUB", "MARK_PROJ_PUB"]) {
        expect(body.mergedWithHeaders).toContain(marker);
      }
    } finally {
      if (savedHome === undefined) delete process.env.FLOCKCTL_HOME;
      else process.env.FLOCKCTL_HOME = savedHome;
    }
  });
});

// ---------------------------------------------------------------------------
// Cascade regression — editing a workspace layer must NOT touch any project's
// AGENTS.md files on disk (no cross-layer write, no reconciler side-effects).
// ---------------------------------------------------------------------------

describe("workspace_edit_does_not_touch_project_files_regression", () => {
  it("PUT workspace-public leaves every child project's AGENTS.md byte-identical with unchanged mtime", async () => {
    const w = mkWorkspace("cascade");
    // Two child projects, each with a pre-existing root AGENTS.md.
    const p1Path = mkdtempSync(join(w.path, "P1-"));
    const p2Path = mkdtempSync(join(w.path, "P2-"));
    writeFileSync(join(p1Path, "AGENTS.md"), "P1_CONTENT");
    writeFileSync(join(p2Path, "AGENTS.md"), "P2_CONTENT");

    db.insert(projects)
      .values({ name: "P1", workspaceId: w.id, path: p1Path })
      .run();
    db.insert(projects)
      .values({ name: "P2", workspaceId: w.id, path: p2Path })
      .run();

    const p1Before = {
      bytes: readFileSync(join(p1Path, "AGENTS.md"), "utf-8"),
      mtime: statSync(join(p1Path, "AGENTS.md")).mtimeMs,
    };
    const p2Before = {
      bytes: readFileSync(join(p2Path, "AGENTS.md"), "utf-8"),
      mtime: statSync(join(p2Path, "AGENTS.md")).mtimeMs,
    };

    // Nudge the clock so a truncating-and-rewriting cascade would be
    // detectable via mtime drift.
    await new Promise((r) => setTimeout(r, 25));

    const { status } = await putJson(`/workspaces/${w.id}/agents-md`, {
      content: "NEW_WS_RULES",
    });
    expect(status).toBe(200);

    // The workspace-public write *must* land at the workspace root.
    expect(readFileSync(join(w.path, "AGENTS.md"), "utf-8")).toBe("NEW_WS_RULES");

    // Child projects must be byte-identical and have unchanged mtime.
    expect(readFileSync(join(p1Path, "AGENTS.md"), "utf-8")).toBe(p1Before.bytes);
    expect(readFileSync(join(p2Path, "AGENTS.md"), "utf-8")).toBe(p2Before.bytes);
    expect(statSync(join(p1Path, "AGENTS.md")).mtimeMs).toBe(p1Before.mtime);
    expect(statSync(join(p2Path, "AGENTS.md")).mtimeMs).toBe(p2Before.mtime);
  });
});
