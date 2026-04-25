import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let tmpBase: string;

vi.mock("../../config", () => ({
  getFlockctlHome: () => "/mock-home",
  getWorkspacesDir: () => "/mock-home/workspaces",
  getGlobalSkillsDir: () => join(tmpdir(), `flockctl-test-mcp-branches-${process.pid}`, "global-skills"),
  getGlobalMcpDir: () => join(tmpdir(), `flockctl-test-mcp-branches-${process.pid}`, "global-mcp"),
}));

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-mcp-branches-${process.pid}`);
  mkdirSync(join(tmpBase, "global-mcp"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

import { loadMcpServersFromDir, resolveMcpServersForProject } from "../../services/mcp.js";

describe("loadMcpServersFromDir — branch gaps", () => {
  it("warns and returns [] when mcp.json is malformed JSON", () => {
    const dir = join(tmpBase, "mcp-bad-combined");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "{ not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadMcpServersFromDir(dir, "global");
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips non-object values inside mcp.json mcpServers map", () => {
    const dir = join(tmpBase, "mcp-mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        "good": { command: "node" },
        "bad-string": "not an object",
        "bad-null": null,
      },
    }));
    const result = loadMcpServersFromDir(dir, "global");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("good");
  });

  it("warns and continues when an individual server file is malformed", () => {
    const dir = join(tmpBase, "mcp-bad-individual");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.json"), JSON.stringify({ command: "ok" }));
    writeFileSync(join(dir, "broken.json"), "{ definitely not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadMcpServersFromDir(dir, "global");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("good");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("applies .local.json override and merges env", () => {
    const dir = join(tmpBase, "mcp-local-override");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "srv.json"), JSON.stringify({
      command: "node", env: { FOO: "1", BAR: "2" },
    }));
    writeFileSync(join(dir, "srv.local.json"), JSON.stringify({
      command: "bun",
      env: { BAR: "override", BAZ: "3" },
    }));
    const result = loadMcpServersFromDir(dir, "global");
    expect(result[0].config.command).toBe("bun");
    expect(result[0].config.env).toEqual({ FOO: "1", BAR: "override", BAZ: "3" });
  });

  it("tolerates a malformed .local.json and keeps base config", () => {
    const dir = join(tmpBase, "mcp-local-broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "srv.json"), JSON.stringify({ command: "node" }));
    writeFileSync(join(dir, "srv.local.json"), "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadMcpServersFromDir(dir, "global");
    expect(result[0].config.command).toBe("node");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("merges env from override when base has no env (covers base.env ?? {})", () => {
    const dir = join(tmpBase, "mcp-local-base-no-env");
    mkdirSync(dir, { recursive: true });
    // base has NO env at all → `base.env ?? {}` exercises the nullish branch
    writeFileSync(join(dir, "srv.json"), JSON.stringify({ command: "node" }));
    writeFileSync(
      join(dir, "srv.local.json"),
      JSON.stringify({ env: { ADDED: "1" } }),
    );
    const result = loadMcpServersFromDir(dir, "global");
    expect(result[0].config.env).toEqual({ ADDED: "1" });
  });

  it("ignores non-object local override (array)", () => {
    const dir = join(tmpBase, "mcp-local-array");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "srv.json"), JSON.stringify({ command: "node" }));
    writeFileSync(join(dir, "srv.local.json"), JSON.stringify(["ignored"]));
    const result = loadMcpServersFromDir(dir, "global");
    // Arrays ARE objects in JS, so mergeLocalOverride runs — but Object.entries of array
    // yields numeric index keys. Verify command still resolves to "node" (base) since
    // "0" key adds an extra field; main command stays intact.
    expect(result[0].config.command).toBe("node");
  });

  it("drops per-file when name already exists in combined mcp.json", () => {
    const dir = join(tmpBase, "mcp-dedupe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: { dup: { command: "from-combined" } },
    }));
    writeFileSync(join(dir, "dup.json"), JSON.stringify({ command: "from-file" }));
    const result = loadMcpServersFromDir(dir, "global");
    expect(result.length).toBe(1);
    expect(result[0].config.command).toBe("from-combined");
  });
});

describe("resolveMcpServersForProject — branch gaps", () => {
  it("returns global-only list when project id doesn't exist", () => {
    const globalDir = join(tmpBase, "global-mcp");
    writeFileSync(join(globalDir, "g-only.json"), JSON.stringify({ command: "g" }));
    const result = resolveMcpServersForProject(999999);
    // Still returns only the global servers; no throw
    expect(result.find(s => s.name === "g-only")).toBeDefined();
  });

  it("returns global-only when project has no workspaceId and no path", () => {
    const p = db.insert(projects).values({ name: `p-orphan-${Date.now()}` }).returning().get()!;
    const result = resolveMcpServersForProject(p.id);
    // No throw; global-only list is fine
    expect(Array.isArray(result)).toBe(true);
  });

  it("tolerates workspace with empty path (falsy workspace.path)", () => {
    // Workspace with empty-string path → `workspace?.path` is falsy → skip ws branch
    sqlite.prepare("INSERT INTO workspaces (name, path) VALUES (?, ?)")
      .run(`ws-empty-${Date.now()}`, `/tmp/ws-empty-${Date.now()}-${Math.random()}`);
    const wsRow = sqlite.prepare("SELECT id, path FROM workspaces ORDER BY id DESC LIMIT 1").get() as { id: number; path: string };
    // Overwrite path to empty via direct SQL (bypasses NOT NULL since we set '')
    sqlite.prepare("UPDATE workspaces SET path = '' WHERE id = ?").run(wsRow.id);
    const projPath = join(tmpBase, `proj-wsno-${Date.now()}`);
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: `p-emptyws-${Date.now()}`,
      workspaceId: wsRow.id,
      path: projPath,
    }).returning().get()!;
    expect(() => resolveMcpServersForProject(proj.id)).not.toThrow();
  });
});

import { resolveMcpServersForWorkspace } from "../../services/mcp.js";

describe("resolveMcpServersForWorkspace — branch gaps", () => {
  it("returns without throwing when workspace id is unknown (no workspace row)", () => {
    expect(() => resolveMcpServersForWorkspace(999999)).not.toThrow();
  });

  it("workspace-level disable referencing non-global name is a no-op", () => {
    const wsPath = join(tmpBase, `ws-disable-noop-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "global", name: "does-not-exist" }],
      }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-disable-noop-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    expect(() => resolveMcpServersForWorkspace(ws.id)).not.toThrow();
  });

  it("workspace-level disables its own workspace server (covers !disabled.has false)", () => {
    const wsPath = join(tmpBase, `ws-dis-own-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "mcp", "wsrv.json"),
      JSON.stringify({ command: "ws-c" }),
    );
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "workspace", name: "wsrv" }],
      }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-dis-own-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const out = resolveMcpServersForWorkspace(ws.id);
    expect(out.find((s) => s.name === "wsrv")).toBeUndefined();
  });
});

describe("resolveMcpServersForProject — disable-else branches", () => {
  it("project-level workspace-disable for a name that isn't a workspace server is a no-op", () => {
    // Covers the `if (s && s.level === 'workspace')` else branch — the name
    // being disabled corresponds to a global-level server, so out.delete()
    // is skipped. Must also cover the global-disable else (name is workspace).
    const wsPath = join(tmpBase, `ws-mixlevels-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "mcp", "wsonly.json"),
      JSON.stringify({ command: "ws-c" }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-mixlevels-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-mixlevels-${Date.now()}`);
    mkdirSync(join(pPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(pPath, ".flockctl", "config.json"),
      JSON.stringify({
        // project claims to disable a GLOBAL-named server, but `wsonly` is
        // workspace-level → s.level !== 'global' → delete is skipped.
        disabledMcpServers: [
          { level: "global", name: "wsonly" },
          // project claims to disable a WORKSPACE-named server, but the
          // name doesn't exist at workspace level → s is undefined.
          { level: "workspace", name: "not-present" },
        ],
      }),
    );
    const p = db
      .insert(projects)
      .values({ name: `p-mixlevels-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveMcpServersForProject(p.id);
    // The workspace server survives — project's global-disable of the same
    // name was a no-op because it's not global.
    expect(out.find((s) => s.name === "wsonly")).toBeDefined();
  });

  it("workspace-level own-disable skips setting the workspace server (covers if-false branch)", () => {
    // When the workspace config disables a workspace-level server name,
    // loadMcpServersFromDir produces the entry, but the `if (!wsDisabled.has)`
    // guard is false, so `out.set` is skipped.
    const wsPath = join(tmpBase, `ws-owndis-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "mcp", "wsoff.json"),
      JSON.stringify({ command: "x" }),
    );
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "workspace", name: "wsoff" }],
      }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-owndis-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-owndis-${Date.now()}`);
    mkdirSync(pPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `p-owndis-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveMcpServersForProject(p.id);
    expect(out.find((s) => s.name === "wsoff")).toBeUndefined();
  });
});

describe("resolveMcpServersForProject — workspace/project precedence branches", () => {
  it("project-level disables a workspace server (covers project-workspace branch)", () => {
    const wsPath = join(tmpBase, `ws-pwd-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "mcp", "wssrv.json"),
      JSON.stringify({ command: "ws-c" }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-pwd-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-pwd-${Date.now()}`);
    mkdirSync(join(pPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(pPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "workspace", name: "wssrv" }],
      }),
    );
    const p = db
      .insert(projects)
      .values({ name: `p-pwd-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveMcpServersForProject(p.id);
    expect(out.find((s) => s.name === "wssrv")).toBeUndefined();
  });

  it("project-level loads its own mcp dir and respects project disables", () => {
    const wsPath = join(tmpBase, `ws-pself-${Date.now()}`);
    mkdirSync(wsPath, { recursive: true });
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-pself-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-pself-${Date.now()}`);
    mkdirSync(join(pPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(pPath, ".flockctl", "mcp", "psrv1.json"),
      JSON.stringify({ command: "p1" }),
    );
    writeFileSync(
      join(pPath, ".flockctl", "mcp", "psrv2.json"),
      JSON.stringify({ command: "p2" }),
    );
    writeFileSync(
      join(pPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "project", name: "psrv2" }],
      }),
    );
    const p = db
      .insert(projects)
      .values({ name: `p-pself-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    const out = resolveMcpServersForProject(p.id);
    expect(out.find((s) => s.name === "psrv1")).toBeDefined();
    expect(out.find((s) => s.name === "psrv2")).toBeUndefined();
  });

  it("workspace-level disable referencing non-global name is a no-op (project path)", () => {
    const wsPath = join(tmpBase, `ws-pnoop-${Date.now()}`);
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({
        disabledMcpServers: [{ level: "global", name: "nonexistent" }],
      }),
    );
    const ws = db
      .insert(workspaces)
      .values({ name: `ws-pnoop-${Date.now()}`, path: wsPath })
      .returning()
      .get()!;
    const pPath = join(tmpBase, `p-pnoop-${Date.now()}`);
    mkdirSync(pPath, { recursive: true });
    const p = db
      .insert(projects)
      .values({ name: `p-pnoop-${Date.now()}`, workspaceId: ws.id, path: pPath })
      .returning()
      .get()!;
    expect(() => resolveMcpServersForProject(p.id)).not.toThrow();
  });
});

describe("mergeLocalOverride — branch gaps", () => {
  it("warns when local override JSON is malformed (already covered); override 'env' array is treated as flat spread", () => {
    const dir = join(tmpBase, "mcp-env-array-override");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "srv.json"),
      JSON.stringify({ command: "node", env: { A: "1" } }),
    );
    // env is an array — hits the `!Array.isArray(v)` false branch; falls through to else.
    writeFileSync(
      join(dir, "srv.local.json"),
      JSON.stringify({ env: ["not", "a", "map"] }),
    );
    const result = loadMcpServersFromDir(dir, "global");
    // env was overwritten with the array (spread through else arm).
    expect(Array.isArray((result[0].config as any).env)).toBe(true);
  });
});
