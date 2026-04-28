// ─── agents-io — unit tests ───
//
// Pins the per-layer AGENTS.md I/O contract:
//   • writeAtomic skips the rename when bytes already match (mtime preserved)
//   • fileMtimeMs returns null for missing paths and a number for existing ones
//   • empty-string content deletes the file (idempotent — ENOENT swallowed)
//   • read* helpers return "" for missing files
//   • describeFile reports {present: false} for missing, {present: true} otherwise
//   • PayloadTooLargeError fires when content exceeds AGENTS_MD_MAX_BYTES

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AGENTS_MD_MAX_BYTES,
  PayloadTooLargeError,
  fileMtimeMs,
  readAllProjectLayers,
  readAllWorkspaceLayers,
  readProjectLayer,
  readWorkspaceLayer,
  writeProjectLayer,
  writeWorkspaceLayer,
} from "../../services/claude/agents-io.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agents-io-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("agents-io", () => {
  it("read*Layer returns empty string when AGENTS.md is absent", () => {
    expect(readProjectLayer(dir)).toBe("");
    expect(readWorkspaceLayer(dir)).toBe("");
  });

  it("readAllProjectLayers reports present=false when missing", () => {
    const layers = readAllProjectLayers(dir);
    expect(layers["project-public"].present).toBe(false);
    expect(layers["project-public"].bytes).toBe(0);
    expect(layers["project-public"].content).toBe("");
  });

  it("readAllWorkspaceLayers reports present=true when file exists", () => {
    writeWorkspaceLayer(dir, "hello world\n");
    const layers = readAllWorkspaceLayers(dir);
    expect(layers["workspace-public"].present).toBe(true);
    expect(layers["workspace-public"].bytes).toBeGreaterThan(0);
    expect(layers["workspace-public"].content).toBe("hello world\n");
  });

  it("writeProjectLayer round-trips content through the AGENTS.md file", () => {
    writeProjectLayer(dir, "project guidance\n");
    expect(readProjectLayer(dir)).toBe("project guidance\n");
  });

  it("writeWorkspaceLayer round-trips content through the AGENTS.md file", () => {
    writeWorkspaceLayer(dir, "workspace guidance\n");
    expect(readWorkspaceLayer(dir)).toBe("workspace guidance\n");
  });

  // Hits the writeAtomic mtime-preservation short-circuit (line ~154-155):
  // when the existing file already contains the exact same bytes, the
  // function returns BEFORE touching the .tmp/rename path, so mtime stays
  // the same. This is the single condition that wasn't reached by any
  // route-level test.
  it("writeAtomic preserves mtime when bytes are unchanged (no-op write)", async () => {
    writeProjectLayer(dir, "stable content\n");
    const path = join(dir, "AGENTS.md");
    const mtime1 = statSync(path).mtimeMs;

    // Sleep a touch so a real rename would visibly bump mtime.
    await new Promise((r) => setTimeout(r, 15));

    writeProjectLayer(dir, "stable content\n"); // same bytes — must skip
    const mtime2 = statSync(path).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("writeAtomic rewrites when content changes", async () => {
    writeProjectLayer(dir, "v1\n");
    const path = join(dir, "AGENTS.md");
    const mtime1 = statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));

    writeProjectLayer(dir, "v2\n");
    const mtime2 = statSync(path).mtimeMs;
    expect(mtime2).toBeGreaterThanOrEqual(mtime1);
    expect(readProjectLayer(dir)).toBe("v2\n");
  });

  it("empty-string content deletes the file (idempotent)", () => {
    const path = join(dir, "AGENTS.md");
    writeProjectLayer(dir, "x\n");
    expect(existsSync(path)).toBe(true);

    writeProjectLayer(dir, "");
    expect(existsSync(path)).toBe(false);

    // A second empty-write must not throw — ENOENT is swallowed.
    expect(() => writeProjectLayer(dir, "")).not.toThrow();
  });

  it("PayloadTooLargeError fires when content exceeds AGENTS_MD_MAX_BYTES", () => {
    const tooBig = "x".repeat(AGENTS_MD_MAX_BYTES + 1);
    expect(() => writeProjectLayer(dir, tooBig)).toThrow(PayloadTooLargeError);
    expect(() => writeWorkspaceLayer(dir, tooBig)).toThrow(PayloadTooLargeError);
  });

  // Hits both branches of fileMtimeMs (lines 167-170): existing file →
  // number; missing file → null.
  it("fileMtimeMs returns number for existing path and null for missing path", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "x", "utf-8");
    expect(typeof fileMtimeMs(path)).toBe("number");

    const missing = join(dir, "does-not-exist.md");
    expect(fileMtimeMs(missing)).toBeNull();
  });
});
