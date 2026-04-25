import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  validateWorkspaceConfig,
  _resetWorkspaceConfigCache,
} from "../../services/workspace-config.js";

const tmpRoot = join(tmpdir(), `flockctl-test-wsconfig-${process.pid}`);

beforeEach(() => {
  _resetWorkspaceConfigCache();
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function freshWs(name: string): string {
  const p = join(tmpRoot, name);
  rmSync(p, { recursive: true, force: true });
  mkdirSync(join(p, ".flockctl"), { recursive: true });
  return p;
}

describe("loadWorkspaceConfig", () => {
  it("returns {} when no config files exist", () => {
    const ws = freshWs("no-config");
    expect(loadWorkspaceConfig(ws)).toEqual({});
  });

  it("returns {} when config.json is malformed and logs error", () => {
    const ws = freshWs("bad-json");
    writeFileSync(join(ws, ".flockctl", "config.json"), "{ not valid json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = loadWorkspaceConfig(ws);
    expect(result).toEqual({});
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("hits cached path on second read", () => {
    const ws = freshWs("cached");
    writeFileSync(
      join(ws, ".flockctl", "config.json"),
      JSON.stringify({ permissionMode: "ask" }),
    );
    const first = loadWorkspaceConfig(ws);
    const second = loadWorkspaceConfig(ws);
    expect(first).toEqual({ permissionMode: "ask" });
    expect(second).toEqual({ permissionMode: "ask" });
  });

});

describe("saveWorkspaceConfig", () => {
  it("writes config.json and clears cache", () => {
    const ws = freshWs("save-test");
    saveWorkspaceConfig(ws, { permissionMode: "ask" });
    const reread = loadWorkspaceConfig(ws);
    expect(reread).toEqual({ permissionMode: "ask" });
  });
});

describe("validateWorkspaceConfig", () => {
  it("returns {} for non-object input", () => {
    expect(validateWorkspaceConfig(null)).toEqual({});
    expect(validateWorkspaceConfig("string")).toEqual({});
    expect(validateWorkspaceConfig(42)).toEqual({});
  });

  it("strips invalid fields and normalizes disable entries", () => {
    const result = validateWorkspaceConfig({
      permissionMode: "ask",
      disabledSkills: [
        "global-skill", // legacy string form → defaults to global
        { name: "ws-skill", level: "workspace" },
        { name: "bad", level: "invalid-level" }, // dropped
        { level: "global" }, // missing name → dropped
        42, // junk
      ],
      disabledMcpServers: [{ name: "mcp", level: "project" }],
      garbage: true,
    });
    expect(result.permissionMode).toBe("ask");
    expect(result.disabledSkills).toEqual([
      { name: "global-skill", level: "global" },
      { name: "ws-skill", level: "workspace" },
    ]);
    expect(result.disabledMcpServers).toEqual([{ name: "mcp", level: "project" }]);
    expect((result as any).garbage).toBeUndefined();
  });
});
