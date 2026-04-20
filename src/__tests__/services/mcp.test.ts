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
  getGlobalSkillsDir: () => join(tmpdir(), `flockctl-test-mcp-svc-${process.pid}`, "global-skills"),
  getGlobalMcpDir: () => join(tmpdir(), `flockctl-test-mcp-svc-${process.pid}`, "global-mcp"),
}));

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = join(tmpdir(), `flockctl-test-mcp-svc-${process.pid}`);
  mkdirSync(join(tmpBase, "global-mcp"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

import { loadMcpServersFromDir, resolveMcpServersForProject } from "../../services/mcp.js";

describe("loadMcpServersFromDir", () => {
  it("returns empty array for nonexistent dir", () => {
    const result = loadMcpServersFromDir("/nonexistent", "global");
    expect(result).toEqual([]);
  });

  it("loads from individual JSON files", () => {
    const dir = join(tmpBase, "mcp-individual");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "my-server.json"), JSON.stringify({
      command: "node",
      args: ["server.js"],
    }));

    const result = loadMcpServersFromDir(dir, "global");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("my-server");
    expect(result[0].config.command).toBe("node");
  });

  it("loads from combined mcp.json", () => {
    const dir = join(tmpBase, "mcp-combined");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        "server-a": { command: "python", args: ["a.py"] },
        "server-b": { command: "node", args: ["b.js"] },
      },
    }));

    const result = loadMcpServersFromDir(dir, "workspace");
    expect(result.length).toBe(2);
    expect(result.find(s => s.name === "server-a")).toBeDefined();
    expect(result.find(s => s.name === "server-b")).toBeDefined();
  });

  it("skips config.json", () => {
    const dir = join(tmpBase, "mcp-skip-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ some: "config" }));
    writeFileSync(join(dir, "real-server.json"), JSON.stringify({ command: "node" }));

    const result = loadMcpServersFromDir(dir, "global");
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("real-server");
  });
});

describe("resolveMcpServersForProject", () => {
  it("returns global servers with no project", () => {
    const globalDir = join(tmpBase, "global-mcp");
    writeFileSync(join(globalDir, "global-srv.json"), JSON.stringify({ command: "node", args: ["global.js"] }));

    const result = resolveMcpServersForProject(null);
    const srv = result.find(s => s.name === "global-srv");
    expect(srv).toBeDefined();
    expect(srv!.level).toBe("global");
  });

  it("workspace servers override global with same name", () => {
    const wsPath = join(tmpBase, "ws-mcp-override");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-mcp-override", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-mcp-override");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-mcp-override",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    // Create workspace MCP with same name as global
    const wsMcpDir = join(wsPath, ".flockctl", "mcp");
    mkdirSync(wsMcpDir, { recursive: true });
    writeFileSync(join(wsMcpDir, "global-srv.json"), JSON.stringify({ command: "python", args: ["ws.py"] }));

    const result = resolveMcpServersForProject(proj!.id);
    const srv = result.find(s => s.name === "global-srv");
    expect(srv).toBeDefined();
    expect(srv!.level).toBe("workspace");
    expect(srv!.config.command).toBe("python");
  });

  it("workspace disabledMcpServers removes global servers", () => {
    const wsPath = join(tmpBase, "ws-mcp-disable-global");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({
      name: "ws-mcp-disable-global",
      path: wsPath,
    }).returning().get();

    // disabledMcpServers lives in .flockctl/config.json
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledMcpServers: [{ name: "global-srv", level: "global" }] }),
    );

    const projPath = join(tmpBase, "proj-mcp-disable-global");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-mcp-disable-global",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    const result = resolveMcpServersForProject(proj!.id);
    const srv = result.find(s => s.name === "global-srv" && s.level === "global");
    expect(srv).toBeUndefined();
  });

  it("project disabledMcpServers removes workspace servers", () => {
    const wsPath = join(tmpBase, "ws-mcp-disable-ws");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({
      name: "ws-mcp-disable-ws",
      path: wsPath,
    }).returning().get();

    // Create workspace MCP server
    const wsMcpDir = join(wsPath, ".flockctl", "mcp");
    mkdirSync(wsMcpDir, { recursive: true });
    writeFileSync(join(wsMcpDir, "ws-srv.json"), JSON.stringify({ command: "node" }));

    const projPath = join(tmpBase, "proj-mcp-disable-ws");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-mcp-disable-ws",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    // disabledMcpServers lives in project .flockctl/config.json
    mkdirSync(join(projPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledMcpServers: [{ name: "ws-srv", level: "workspace" }] }),
    );

    const result = resolveMcpServersForProject(proj!.id);
    const srv = result.find(s => s.name === "ws-srv");
    expect(srv).toBeUndefined();
  });

  it("project servers override workspace with same name", () => {
    const wsPath = join(tmpBase, "ws-mcp-proj-override");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-mcp-proj-override", path: wsPath }).returning().get();

    const wsMcpDir = join(wsPath, ".flockctl", "mcp");
    mkdirSync(wsMcpDir, { recursive: true });
    writeFileSync(join(wsMcpDir, "shared-srv.json"), JSON.stringify({ command: "ws-cmd" }));

    const projPath = join(tmpBase, "proj-mcp-override-2");
    mkdirSync(projPath, { recursive: true });
    const proj = db.insert(projects).values({
      name: "proj-mcp-override-2",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    const projMcpDir = join(projPath, ".flockctl", "mcp");
    mkdirSync(projMcpDir, { recursive: true });
    writeFileSync(join(projMcpDir, "shared-srv.json"), JSON.stringify({ command: "proj-cmd" }));

    const result = resolveMcpServersForProject(proj!.id);
    const srv = result.find(s => s.name === "shared-srv");
    expect(srv).toBeDefined();
    expect(srv!.level).toBe("project");
    expect(srv!.config.command).toBe("proj-cmd");
  });

  it("project disabledMcpServers can disable a global server directly", () => {
    // Seed a global server, then point a project at it via disabledMcpServers level=global.
    const globalDir = join(tmpBase, "global-mcp");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "kill-from-proj.json"), JSON.stringify({ command: "g" }));

    const wsPath = join(tmpBase, "ws-proj-kills-global");
    mkdirSync(wsPath, { recursive: true });
    const ws = db.insert(workspaces).values({ name: "ws-pkg", path: wsPath }).returning().get();

    const projPath = join(tmpBase, "proj-kills-global");
    mkdirSync(join(projPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledMcpServers: [{ name: "kill-from-proj", level: "global" }] }),
    );
    const proj = db.insert(projects).values({
      name: "proj-pkg",
      workspaceId: ws!.id,
      path: projPath,
    }).returning().get();

    const result = resolveMcpServersForProject(proj!.id);
    expect(result.find((s) => s.name === "kill-from-proj")).toBeUndefined();
  });
});

import { resolveMcpServersForWorkspace } from "../../services/mcp.js";

describe("resolveMcpServersForWorkspace", () => {
  it("workspace disabledMcpServers removes global servers", () => {
    const globalDir = join(tmpBase, "global-mcp");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "ws-kill-global.json"), JSON.stringify({ command: "g" }));

    const wsPath = join(tmpBase, "ws-self-kill-global");
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledMcpServers: [{ name: "ws-kill-global", level: "global" }] }),
    );
    const ws = db.insert(workspaces).values({ name: "ws-skg", path: wsPath }).returning().get();

    const result = resolveMcpServersForWorkspace(ws!.id);
    expect(result.find((s) => s.name === "ws-kill-global")).toBeUndefined();
  });
});

