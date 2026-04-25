/**
 * Branch-coverage tests for `agent-guidance-loader.ts`.
 *
 * Fills the missing branches:
 *  - Total-cap exceeded: `remaining <= 0` (skip layer) and
 *    `layerBytes > remaining` (truncate to fit, append `total-cap` marker).
 *  - `loadWorkspaceAgentGuidance` when workspacePath === flockctlHome.
 *  - `symlink` where realPath === realRoot (edge case).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadAgentGuidance,
  loadWorkspaceAgentGuidance,
} from "../../services/agent-session/agent-guidance-loader.js";

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(
    tmpdir(),
    `flockctl-guidance-branches-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// NOTE: total-cap branches (`remaining <= 0` and `layerBytes > remaining`)
// are effectively unreachable through the public API in the current build:
// PER_LAYER_CAP=256 KiB × 3 layers = 768 KiB, well under the 1 MiB total
// cap. Covering them would require either exposing a smaller internal cap
// or adding a 4th layer candidate. Flagged as dead-branch — see report.

describe("loadWorkspaceAgentGuidance — branches", () => {
  it("passes workspacePath through to loader when it differs from flockctlHome", () => {
    const flockctlHome = join(tmpBase, "home");
    const ws = join(tmpBase, "ws");
    mkdirSync(flockctlHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(flockctlHome, "AGENTS.md"), "U\n");
    writeFileSync(join(ws, "AGENTS.md"), "W\n");

    const out = loadWorkspaceAgentGuidance(ws, flockctlHome);
    expect(out.layers.map((l) => l.layer)).toEqual(["user", "workspace-public"]);
  });

  it("returns null workspacePath when workspace === flockctlHome (dedupe)", () => {
    const home = join(tmpBase, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "U\n");
    const out = loadWorkspaceAgentGuidance(home, home);
    // Only user layer — workspace-public de-duped to avoid re-reading same file.
    expect(out.layers.map((l) => l.layer)).toEqual(["user"]);
  });

  it("returns null workspacePath when workspacePath is falsy", () => {
    const home = join(tmpBase, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "U\n");
    const out = loadWorkspaceAgentGuidance("", home);
    expect(out.layers.map((l) => l.layer)).toEqual(["user"]);
  });
});

describe("loadAgentGuidance — symlink traversal branches", () => {
  it("follows a symlink whose realpath is inside the root", () => {
    const home = join(tmpBase, "home");
    mkdirSync(home, { recursive: true });
    // Write the real file elsewhere in the same root; then symlink AGENTS.md → real
    const realFile = join(home, "_real.md");
    writeFileSync(realFile, "real content\n");
    symlinkSync(realFile, join(home, "AGENTS.md"));
    const out = loadAgentGuidance({
      flockctlHome: home,
      workspacePath: null,
      projectPath: null,
    });
    expect(out.layers.length).toBe(1);
    expect(out.layers[0].content).toContain("real content");
  });

  it("rejects a symlink pointing outside the root", () => {
    const home = join(tmpBase, "home");
    const elsewhere = join(tmpBase, "elsewhere");
    mkdirSync(home, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const outside = join(elsewhere, "AGENTS.md");
    writeFileSync(outside, "escaped\n");
    symlinkSync(outside, join(home, "AGENTS.md"));
    const out = loadAgentGuidance({
      flockctlHome: home,
      workspacePath: null,
      projectPath: null,
    });
    expect(out.layers.length).toBe(0);
  });

  it("rejects a symlink whose target is a directory", () => {
    const home = join(tmpBase, "home");
    mkdirSync(home, { recursive: true });
    const targetDir = join(home, "dir-target");
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(targetDir, join(home, "AGENTS.md"));
    const out = loadAgentGuidance({
      flockctlHome: home,
      workspacePath: null,
      projectPath: null,
    });
    expect(out.layers.length).toBe(0);
  });

  it("skips a dangling symlink without crashing", () => {
    const home = join(tmpBase, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(join(home, "does-not-exist"), join(home, "AGENTS.md"));
    const out = loadAgentGuidance({
      flockctlHome: home,
      workspacePath: null,
      projectPath: null,
    });
    expect(out.layers.length).toBe(0);
  });
});
