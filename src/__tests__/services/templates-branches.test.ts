/**
 * Branch-coverage extras for `services/templates.ts`.
 *
 * Fills:
 *   - `assertValidName` throwing path (invalid characters).
 *   - `resolveWorkspacePath` / `resolveProjectPath` not-found throwers.
 *   - `templatesDirFor` `default` switch arm (unknown scope).
 *   - `readTemplateFile` catching malformed JSON → null.
 *   - `listInDir` skipping non-file and null-parse entries.
 *   - `listTemplates` workspace/project aggregation with rows that have no path.
 *   - `listTemplates` sort tie-breaker via same-scope names.
 *   - `createTemplate` failed re-read branch (simulate by unlinking between write and read — hard;
 *     instead we exercise it via readTemplateFile null-return when the written file is corrupted
 *     after rename — not feasible without mocks, so we skip this specific branch).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects } from "../../db/schema.js";

const tmpBase = join(tmpdir(), `flockctl-templates-branches-${process.pid}-${Date.now()}`);

vi.mock("../../config/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/index.js")>();
  return {
    ...actual,
    getGlobalTemplatesDir: () => join(tmpBase, "global-templates"),
  };
});

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  mkdirSync(join(tmpBase, "global-templates"), { recursive: true });
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Wipe global templates directory between tests
  try {
    rmSync(join(tmpBase, "global-templates"), { recursive: true, force: true });
  } catch {}
  mkdirSync(join(tmpBase, "global-templates"), { recursive: true });
});

import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  templatesDirFor,
  TemplateError,
} from "../../services/templates.js";

describe("templates — branch gaps", () => {
  it("assertValidName throws TemplateError on invalid chars (createTemplate)", () => {
    expect(() =>
      createTemplate({ name: "bad name with spaces", scope: "global" }),
    ).toThrow(TemplateError);
    expect(() =>
      createTemplate({ name: "also/bad", scope: "global" }),
    ).toThrow(/Invalid template name/);
    // Also exercise via deleteTemplate + getTemplate
    expect(() => deleteTemplate("global", "bad name")).toThrow(TemplateError);
    expect(() => getTemplate("global", "bad name")).toThrow(TemplateError);
  });

  it("templatesDirFor throws for unknown scope (default arm)", () => {
    expect(() =>
      // @ts-expect-error deliberately passing an invalid scope
      templatesDirFor("galaxy", {}),
    ).toThrow(/Unknown scope/);
  });

  it("templatesDirFor throws when workspaceId/projectId are missing", () => {
    expect(() => templatesDirFor("workspace", {})).toThrow(/workspaceId is required/);
    expect(() => templatesDirFor("project", {})).toThrow(/projectId is required/);
  });

  it("resolveWorkspacePath throws when workspace is missing", () => {
    // Triggered via createTemplate with an unknown workspaceId
    expect(() =>
      createTemplate({ name: "ws-orphan", scope: "workspace", workspaceId: 999999 }),
    ).toThrow(/Workspace 999999 not found/);
  });

  it("resolveProjectPath throws when project is missing", () => {
    expect(() =>
      createTemplate({ name: "proj-orphan", scope: "project", projectId: 999999 }),
    ).toThrow(/Project 999999 not found/);
  });

  it("listTemplates listInDir: skips non-file entries and malformed JSON files", () => {
    const dir = join(tmpBase, "global-templates");
    // A subdirectory inside the templates dir — triggers the `!entry.isFile()` skip.
    mkdirSync(join(dir, "not-a-template-dir"), { recursive: true });
    // A non-.json file — triggers the `.endsWith(".json")` skip.
    writeFileSync(join(dir, "ignored.txt"), "no");
    // A malformed JSON file — triggers the readTemplateFile try/catch → null, exercising
    // the `if (tpl) out.push(tpl)` false branch.
    writeFileSync(join(dir, "broken.json"), "{ not json");
    // A valid one so we still get something.
    writeFileSync(
      join(dir, "ok.json"),
      JSON.stringify({ prompt: "hi", description: "d" }),
    );
    const out = listTemplates({ scope: "global" });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe("ok");
  });

  it("listTemplates aggregates workspaces/projects skipping rows with no path", () => {
    // Workspace with no path (violates NOT NULL, so skip via SQL and an empty string)
    const wsOkPath = join(tmpBase, `ws-ok-${Date.now()}`);
    mkdirSync(join(wsOkPath, ".flockctl", "templates"), { recursive: true });
    writeFileSync(
      join(wsOkPath, ".flockctl", "templates", "w1.json"),
      JSON.stringify({ prompt: "ws" }),
    );
    const wsOk = db
      .insert(workspaces)
      .values({ name: `ws-ok-${Date.now()}`, path: wsOkPath })
      .returning()
      .get()!;

    // Insert a ws row with empty path to exercise the `!ws.path` continue branch.
    sqlite
      .prepare("INSERT INTO workspaces (name, path) VALUES (?, ?)")
      .run(`ws-empty-${Date.now()}`, `placeholder-${Date.now()}`);
    sqlite.prepare("UPDATE workspaces SET path='' WHERE name LIKE 'ws-empty-%'").run();

    const projOkPath = join(tmpBase, `proj-ok-${Date.now()}`);
    mkdirSync(join(projOkPath, ".flockctl", "templates"), { recursive: true });
    writeFileSync(
      join(projOkPath, ".flockctl", "templates", "p1.json"),
      JSON.stringify({ prompt: "pr" }),
    );
    const projOk = db
      .insert(projects)
      .values({ name: `proj-ok-${Date.now()}`, path: projOkPath })
      .returning()
      .get()!;

    // Project with null path → triggers `!p.path` continue branch
    db.insert(projects).values({ name: `proj-noPath-${Date.now()}` }).run();

    const all = listTemplates();
    const names = all.map((t) => `${t.scope}:${t.name}`);
    expect(names).toContain("workspace:w1");
    expect(names).toContain("project:p1");

    // Clean up DB state so later tests don't see these rows
    db.delete(workspaces).where(undefined as never).run(); // no-op: delete returns builder; ignore
    // Actually just remove the tmp dirs; the rows may remain but other tests don't rely on listTemplates
    rmSync(wsOkPath, { recursive: true, force: true });
    rmSync(projOkPath, { recursive: true, force: true });
    // Also use the inserted rows so TS doesn't warn
    expect(wsOk.id).toBeGreaterThan(0);
    expect(projOk.id).toBeGreaterThan(0);
  });

  it("listTemplates sort: same-scope names localeCompare tie-breaker", () => {
    const dir = join(tmpBase, "global-templates");
    writeFileSync(join(dir, "zeta.json"), JSON.stringify({ prompt: "z" }));
    writeFileSync(join(dir, "alpha.json"), JSON.stringify({ prompt: "a" }));
    const out = listTemplates({ scope: "global" });
    expect(out.map((t) => t.name)).toEqual(["alpha", "zeta"]);
  });

  it("updateTemplate throws not_found when template is missing", () => {
    expect(() => updateTemplate("global", "nope", {}, { prompt: "p" })).toThrow(
      /not found/,
    );
  });

  it("createTemplate refuses to create when file already exists", () => {
    createTemplate({ name: "dup", scope: "global", prompt: "p" });
    expect(() =>
      createTemplate({ name: "dup", scope: "global", prompt: "q" }),
    ).toThrow(/already exists/);
  });

  it("deleteTemplate returns false when file does not exist", () => {
    expect(deleteTemplate("global", "never-was")).toBe(false);
  });

  it("getTemplate returns null when file does not exist", () => {
    expect(getTemplate("global", "never-was")).toBeNull();
  });
});
