import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadAgentGuidance,
  PER_LAYER_CAP,
  TOTAL_CAP,
  type LoaderInput,
} from "../../services/agent-session/agent-guidance-loader.js";

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(
    tmpdir(),
    `flockctl-guidance-loader-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // intentionally swallow cleanup races
  }
});

/**
 * Build a three-layer tree inside `tmpBase` and return the LoaderInput pointing
 * at it. Each layer is seeded only when a non-null string is provided, so the
 * same helper covers "all layers present", "only user", "empty tree", etc.
 *
 * Layers: user (flockctlHome/AGENTS.md), workspace-public
 * (workspacePath/AGENTS.md), project-public (projectPath/AGENTS.md).
 */
function seedTree(opts: {
  user?: string | null;
  wsPublic?: string | null;
  projPublic?: string | null;
}): LoaderInput {
  const flockctlHome = join(tmpBase, "flockctl-home");
  const workspacePath = join(tmpBase, "ws");
  const projectPath = join(tmpBase, "ws", "proj");

  mkdirSync(flockctlHome, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(projectPath, { recursive: true });

  if (opts.user != null) {
    writeFileSync(join(flockctlHome, "AGENTS.md"), opts.user, "utf8");
  }
  if (opts.wsPublic != null) {
    writeFileSync(join(workspacePath, "AGENTS.md"), opts.wsPublic, "utf8");
  }
  if (opts.projPublic != null) {
    writeFileSync(join(projectPath, "AGENTS.md"), opts.projPublic, "utf8");
  }

  return { flockctlHome, workspacePath, projectPath };
}

describe("loadAgentGuidance", () => {
  it("reads_three_layers_in_order", () => {
    const input = seedTree({
      user: "USER_LAYER_MARKER\n",
      wsPublic: "WS_PUBLIC_MARKER\n",
      projPublic: "PROJ_PUBLIC_MARKER\n",
    });
    const out = loadAgentGuidance(input);
    expect(out.layers.map((l) => l.layer)).toEqual([
      "user",
      "workspace-public",
      "project-public",
    ]);
    // Ordering also preserved in merged string.
    const positions = [
      "USER_LAYER_MARKER",
      "WS_PUBLIC_MARKER",
      "PROJ_PUBLIC_MARKER",
    ].map((m) => out.mergedWithHeaders.indexOf(m));
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
    // End banner present.
    expect(out.mergedWithHeaders).toMatch(/flockctl:agent-guidance end total_bytes=\d+/);
  });

  it("skips_absent_layers", () => {
    const input = seedTree({
      user: "USER\n",
      // wsPublic omitted
      projPublic: "PROJ_PUBLIC\n",
    });
    const out = loadAgentGuidance(input);
    expect(out.layers.map((l) => l.layer)).toEqual(["user", "project-public"]);
    expect(out.mergedWithHeaders).toContain("USER");
    expect(out.mergedWithHeaders).toContain("PROJ_PUBLIC");
  });

  it("enforces_per_layer_cap_with_marker", () => {
    const oversized = "x".repeat(PER_LAYER_CAP + 10 * 1024); // 266 KiB
    const input = seedTree({ user: oversized });
    const out = loadAgentGuidance(input);
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]!.truncated).toBe(true);
    expect(out.layers[0]!.content).toMatch(
      /flockctl:truncated layer=user original_bytes=\d+ reason=per-layer-cap/,
    );
    expect(out.truncatedLayers).toContain("user");
  });

  it("single_layer_at_300_KiB_gets_truncated_at_256_KiB", () => {
    const huge = "A".repeat(300 * 1024);
    const input = seedTree({ projPublic: huge });
    const out = loadAgentGuidance(input);
    expect(out.layers).toHaveLength(1);
    // Bytes should be approximately PER_LAYER_CAP plus the truncation marker.
    expect(out.layers[0]!.bytes).toBeGreaterThan(PER_LAYER_CAP);
    expect(out.layers[0]!.bytes).toBeLessThan(PER_LAYER_CAP + 500);
    expect(out.layers[0]!.truncated).toBe(true);
  });

  it("three_layers_at_exactly_256_KiB_each_fits_under_1_MiB_total", () => {
    // 3 * 256 KiB = 768 KiB < 1 MiB. All three layers fit with no truncation.
    const chunk = "B".repeat(PER_LAYER_CAP);
    const input = seedTree({
      user: chunk,
      wsPublic: chunk,
      projPublic: chunk,
    });
    const out = loadAgentGuidance(input);
    expect(out.totalBytes).toBeLessThanOrEqual(TOTAL_CAP);
    expect(out.layers).toHaveLength(3);
    // No total-cap truncation expected; per-layer cap matches input exactly.
    for (const l of out.layers) {
      expect(l.truncated).toBe(false);
    }
    expect(out.truncatedLayers).toEqual([]);
  });

  it("preserves_unicode_and_multibyte", () => {
    const text = "🌟 日本語テスト\n русская строка\nمرحبا\n".repeat(500);
    const input = seedTree({ projPublic: text });
    const out = loadAgentGuidance(input);
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]!.content).toBe(text);
    // Bytes field matches UTF-8 byte length, not character count.
    expect(out.layers[0]!.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.layers[0]!.bytes).toBeGreaterThan(text.length); // multibyte proof
  });

  it("ignores_directory_named_AGENTS.md", () => {
    const input = seedTree({ user: "USER\n" });
    // Replace project-public file location with a directory.
    mkdirSync(join(input.projectPath!, "AGENTS.md"));
    const out = loadAgentGuidance(input);
    // User layer present, project-public absent (directory skipped).
    expect(out.layers.map((l) => l.layer)).toEqual(["user"]);
  });

  it("ignores_zero_byte_files_without_header", () => {
    const input = seedTree({ user: "", projPublic: "REAL_CONTENT\n" });
    const out = loadAgentGuidance(input);
    expect(out.layers.map((l) => l.layer)).toEqual(["project-public"]);
  });

  it("handles_permission_denied_by_logging_and_skipping", () => {
    // chmod 0o000 on the file. Note: running as root (rare in CI but possible
    // in containers) will bypass mode; we gate the assertion on that.
    const input = seedTree({ user: "USER\n", projPublic: "PROJ\n" });
    chmodSync(join(input.flockctlHome, "AGENTS.md"), 0o000);
    const out = loadAgentGuidance(input);
    // Restore so cleanup can rm the file.
    chmodSync(join(input.flockctlHome, "AGENTS.md"), 0o644);
    if (process.getuid && process.getuid() === 0) {
      // Running as root — read succeeded; assert both layers present.
      expect(out.layers.map((l) => l.layer)).toEqual(["user", "project-public"]);
    } else {
      expect(out.layers.map((l) => l.layer)).toEqual(["project-public"]);
    }
  });

  it("symlink_in_layer_file_pointing_to_/etc/passwd_not_followed", () => {
    const input = seedTree({ user: "USER_REAL\n" });
    // Replace project-public with a symlink pointing outside the project root.
    symlinkSync("/etc/passwd", join(input.projectPath!, "AGENTS.md"));
    const out = loadAgentGuidance(input);
    expect(out.layers.map((l) => l.layer)).toEqual(["user"]);
    expect(out.mergedWithHeaders).not.toContain("root:");
  });

  it("handles_symlinks_pointing_outside_root", () => {
    // Create a file outside the workspace root and symlink workspace-public to it.
    const outsideFile = join(tmpBase, "outside.md");
    writeFileSync(outsideFile, "OUTSIDE_SECRET\n", "utf8");
    const input = seedTree({ user: "USER\n" });
    symlinkSync(outsideFile, join(input.workspacePath!, "AGENTS.md"));
    const out = loadAgentGuidance(input);
    expect(out.layers.map((l) => l.layer)).toEqual(["user"]);
    expect(out.mergedWithHeaders).not.toContain("OUTSIDE_SECRET");
  });

  it("rejects_project_symlink_to_workspace_agents_md", () => {
    // Symlink from project-public → workspace-public (one level up). The loader
    // treats workspace and project as separate roots; a symlink from a project
    // file to a workspace file leaks workspace content into the project layer,
    // violating the containment contract.
    const input = seedTree({ user: "USER\n", wsPublic: "WS_PUBLIC\n" });
    symlinkSync(
      join(input.workspacePath!, "AGENTS.md"),
      join(input.projectPath!, "AGENTS.md"),
    );
    const out = loadAgentGuidance(input);
    // project-public layer is rejected (traversal). workspace-public read directly.
    expect(out.layers.map((l) => l.layer)).toEqual([
      "user",
      "workspace-public",
    ]);
  });

  it("returns_empty_merged_when_all_layers_absent", () => {
    const flockctlHome = join(tmpBase, "home");
    mkdirSync(flockctlHome, { recursive: true });
    const out = loadAgentGuidance({
      flockctlHome,
      workspacePath: null,
      projectPath: null,
    });
    expect(out.layers).toEqual([]);
    expect(out.totalBytes).toBe(0);
    expect(out.mergedWithHeaders).toBe("");
  });
});
