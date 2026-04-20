import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { homedir } from "os";
import { cleanupClaudeCodePlugin } from "../../services/plugin-cleanup.js";

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "flockctl-plugin-cleanup-"));
  (homedir as any).mockReturnValue(fakeHome);
  // getFlockctlHome() reads process.env.HOME, so override both.
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe("cleanupClaudeCodePlugin", () => {
  it("no-ops when neither plugin dir nor settings exist", () => {
    expect(() => cleanupClaudeCodePlugin()).not.toThrow();
  });

  it("removes ~/flockctl/.claude-plugin directory", () => {
    const pluginDir = join(fakeHome, "flockctl", ".claude-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "marker"), "x");

    cleanupClaudeCodePlugin();

    expect(existsSync(pluginDir)).toBe(false);
  });

  it("strips flockctl entries from ~/.claude/settings.json", () => {
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const original = {
      unrelated: { keep: true },
      extraKnownMarketplaces: {
        "flockctl-local": { src: "x" },
        "other": { src: "y" },
      },
      enabledPlugins: {
        "flockctl@flockctl-local": true,
        "other@remote": true,
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original));

    cleanupClaudeCodePlugin();

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(parsed.extraKnownMarketplaces["flockctl-local"]).toBeUndefined();
    expect(parsed.extraKnownMarketplaces.other).toEqual({ src: "y" });
    expect(parsed.enabledPlugins["flockctl@flockctl-local"]).toBeUndefined();
    expect(parsed.enabledPlugins["other@remote"]).toBe(true);
    expect(parsed.unrelated).toEqual({ keep: true });
  });

  it("leaves settings untouched when flockctl keys absent", () => {
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const original = {
      extraKnownMarketplaces: { other: { src: "y" } },
      enabledPlugins: { "x@y": true },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const before = readFileSync(settingsPath, "utf-8");
    cleanupClaudeCodePlugin();
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).toBe(before);
  });

  it("does not throw on malformed settings JSON", () => {
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(settingsPath, "{ not json");

    expect(() => cleanupClaudeCodePlugin()).not.toThrow();
  });

  it("ignores non-object parsed settings", () => {
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(settingsPath, "null");

    expect(() => cleanupClaudeCodePlugin()).not.toThrow();
  });
});
