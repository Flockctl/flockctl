import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadProjectConfig,
  saveProjectConfig,
  validateConfig,
  _resetConfigCache,
} from "../../services/project-config.js";

describe("validateConfig", () => {
  it("returns empty object for null/non-object", () => {
    expect(validateConfig(null)).toEqual({});
    expect(validateConfig(undefined)).toEqual({});
    expect(validateConfig("string")).toEqual({});
    expect(validateConfig(42)).toEqual({});
    expect(validateConfig([])).toEqual({});
  });

  it("strips unknown fields", () => {
    expect(validateConfig({ foo: "bar", model: "x" })).toEqual({ model: "x" });
  });

  it("validates all string fields", () => {
    const cfg = {
      model: "claude-sonnet-4-6",
      planningModel: "claude-opus-4-7",
      baseBranch: "main",
      testCommand: "npm run test",
    };
    expect(validateConfig(cfg)).toEqual(cfg);
  });

  it("filters allowedProviders to strings only", () => {
    const cfg = { allowedProviders: ["anthropic", 42, null, "openai"] };
    expect(validateConfig(cfg).allowedProviders).toEqual(["anthropic", "openai"]);
  });

  it("drops allowedProviders if not an array", () => {
    expect(validateConfig({ allowedProviders: "anthropic" })).toEqual({});
  });

  it("validates all numeric fields", () => {
    const cfg = {
      defaultTimeout: 3600,
      maxConcurrentTasks: 4,
      budgetDailyUsd: 10.5,
    };
    expect(validateConfig(cfg)).toEqual(cfg);
  });

  it("drops numeric fields with wrong type", () => {
    expect(validateConfig({ defaultTimeout: "3600" })).toEqual({});
    expect(validateConfig({ maxConcurrentTasks: true })).toEqual({});
  });

  it("validates requiresApproval boolean", () => {
    expect(validateConfig({ requiresApproval: true })).toEqual({ requiresApproval: true });
    expect(validateConfig({ requiresApproval: false })).toEqual({ requiresApproval: false });
    expect(validateConfig({ requiresApproval: "true" })).toEqual({});
  });

  it("validates env map, filtering non-string keys/values", () => {
    const cfg = { env: { FOO: "bar", NUM: 5, BAZ: "ok" } };
    expect(validateConfig(cfg).env).toEqual({ FOO: "bar", BAZ: "ok" });
  });

  it("drops env if not an object", () => {
    expect(validateConfig({ env: "FOO=bar" })).toEqual({});
    expect(validateConfig({ env: null })).toEqual({});
  });
});

describe("loadProjectConfig / saveProjectConfig", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "proj-config-"));
    _resetConfigCache();
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("returns empty object when no config file", () => {
    expect(loadProjectConfig(projectPath)).toEqual({});
  });

  it("saves and loads config round-trip", () => {
    const cfg = {
      model: "claude-sonnet-4-6",
      baseBranch: "develop",
      allowedProviders: ["anthropic"],
      env: { KEY: "value" },
    };
    saveProjectConfig(projectPath, cfg);
    const loaded = loadProjectConfig(projectPath);
    expect(loaded).toEqual(cfg);
  });

  it("returns cached value on second load with same mtime", () => {
    saveProjectConfig(projectPath, { model: "x" });
    const first = loadProjectConfig(projectPath);
    const second = loadProjectConfig(projectPath);
    expect(second).toEqual(first);
  });

  it("invalidates cache on save", () => {
    saveProjectConfig(projectPath, { model: "old" });
    expect(loadProjectConfig(projectPath).model).toBe("old");
    saveProjectConfig(projectPath, { model: "new" });
    expect(loadProjectConfig(projectPath).model).toBe("new");
  });

  it("creates .flockctl directory when saving", () => {
    saveProjectConfig(projectPath, { model: "x" });
    const content = readFileSync(join(projectPath, ".flockctl", "config.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.model).toBe("x");
  });
});
