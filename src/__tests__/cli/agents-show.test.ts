/**
 * `flockctl agents show` — covers the CLI wiring end-to-end without spawning a
 * child process. We build a fresh `Command` and register the agents group on
 * it, then drive the action with `parseAsync` against a tmpdir fixture. Stdout
 * and stderr are captured by stubbing `process.stdout.write` /
 * `process.stderr.write`, and `process.exit` is stubbed to throw so we can
 * assert on the error paths.
 *
 * For the match tests we compute the expected merged string via a direct call
 * to `loadAgentGuidance` / `loadWorkspaceAgentGuidance` on the same tmpdir, so
 * the assertion is "CLI output equals what the loader would produce" —
 * decoupled from the exact header format, which is owned by the loader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadAgentGuidance,
  loadWorkspaceAgentGuidance,
} from "../../services/agent-session/agent-guidance-loader.js";
import {
  registerAgentsCommand,
  assertKnownFlockctlPath,
  resolveWorkspaceFor,
} from "../../cli-commands/agents.js";

/* -------------------------------------------------------------------------- */
/* Shared fixture scaffolding                                                 */
/* -------------------------------------------------------------------------- */

let rootDir: string;
let flockctlHome: string;

/**
 * A complete fixture: a fake flockctl home (for the user layer), a fake
 * workspace root, and a fake project root nested inside the workspace. Each
 * public layer gets its own AGENTS.md so the loader produces the three public
 * entries.
 */
function buildFullFixture() {
  // Fake flockctl home.
  writeFileSync(join(flockctlHome, "AGENTS.md"), "USER-LAYER content\n", "utf8");

  // Workspace dir. `.flockctl/` marks it as known; AGENTS.md lives in the
  // public root only (private layer has been retired).
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(join(workspaceDir, ".flockctl"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "AGENTS.md"),
    "WORKSPACE-PUBLIC content\n",
    "utf8",
  );

  // Project dir nested *inside* the workspace so resolveWorkspaceFor() finds it.
  const projectDir = join(workspaceDir, "proj");
  mkdirSync(join(projectDir, ".flockctl"), { recursive: true });
  writeFileSync(
    join(projectDir, "AGENTS.md"),
    "PROJECT-PUBLIC content\n",
    "utf8",
  );

  return { workspaceDir, projectDir };
}

/* -------------------------------------------------------------------------- */
/* Harness: run a CLI command and capture its output                          */
/* -------------------------------------------------------------------------- */

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(argv: string[]): Promise<RunResult> {
  const program = new Command();
  program.exitOverride();
  registerAgentsCommand(program);

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    // cast through unknown — process.stdout.write has several overloads
    .mockImplementation(((chunk: unknown): boolean => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as unknown as typeof process.stderr.write);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__exit(${exitCode})`);
    }) as unknown as typeof process.exit);

  try {
    await program.parseAsync(["node", "flockctl", ...argv]);
  } catch (err) {
    // Either our exit stub fired, or commander's exitOverride threw. Either
    // way, we've captured everything we need on the `stdout` / `stderr` /
    // `exitCode` locals — swallow so the test can assert.
    if (!(err instanceof Error && err.message.startsWith("__exit"))) {
      // Re-throw anything unexpected so the test doesn't silently pass.
      if (!(err as { code?: string })?.code?.toString().startsWith("commander")) {
        throw err;
      }
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode };
}

/* -------------------------------------------------------------------------- */
/* beforeEach/afterEach — fresh tmpdir + FLOCKCTL_HOME per test               */
/* -------------------------------------------------------------------------- */

let prevFlockctlHome: string | undefined;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "flockctl-agents-show-"));
  flockctlHome = join(rootDir, "home");
  mkdirSync(flockctlHome, { recursive: true });
  prevFlockctlHome = process.env.FLOCKCTL_HOME;
  process.env.FLOCKCTL_HOME = flockctlHome;
});

afterEach(() => {
  if (prevFlockctlHome === undefined) {
    delete process.env.FLOCKCTL_HOME;
  } else {
    process.env.FLOCKCTL_HOME = prevFlockctlHome;
  }
  try {
    rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* -------------------------------------------------------------------------- */
/* Helper: assertKnownFlockctlPath                                            */
/* -------------------------------------------------------------------------- */

describe("assertKnownFlockctlPath", () => {
  it("accepts a dir that contains a .flockctl/ scaffold", () => {
    const p = join(rootDir, "good");
    mkdirSync(join(p, ".flockctl"), { recursive: true });
    expect(() => assertKnownFlockctlPath(p, "project")).not.toThrow();
    expect(() => assertKnownFlockctlPath(p, "workspace")).not.toThrow();
  });

  it("throws when the path does not exist", () => {
    const p = join(rootDir, "missing");
    expect(() => assertKnownFlockctlPath(p, "project")).toThrow(
      /Path not found/,
    );
  });

  it("throws when the path exists but has no .flockctl/ scaffold", () => {
    const p = join(rootDir, "bare");
    mkdirSync(p, { recursive: true });
    expect(() => assertKnownFlockctlPath(p, "project")).toThrow(
      /missing \.flockctl\//,
    );
  });

  it("throws when the path is a file, not a directory", () => {
    const p = join(rootDir, "file.txt");
    writeFileSync(p, "hi", "utf8");
    expect(() => assertKnownFlockctlPath(p, "project")).toThrow(
      /not a directory/,
    );
  });

  it("throws when .flockctl exists but is a regular file", () => {
    const p = join(rootDir, "weird");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, ".flockctl"), "not a dir", "utf8");
    expect(() => assertKnownFlockctlPath(p, "project")).toThrow(
      /not a directory/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Helper: resolveWorkspaceFor                                                */
/* -------------------------------------------------------------------------- */

describe("resolveWorkspaceFor", () => {
  it("finds the nearest ancestor with a .flockctl/ scaffold", () => {
    const ws = join(rootDir, "ws");
    const proj = join(ws, "proj");
    mkdirSync(join(ws, ".flockctl"), { recursive: true });
    mkdirSync(join(proj, ".flockctl"), { recursive: true });
    expect(resolveWorkspaceFor(proj)).toBe(ws);
  });

  it("returns null for a standalone project with no workspace ancestor", () => {
    const proj = join(rootDir, "standalone");
    mkdirSync(join(proj, ".flockctl"), { recursive: true });
    expect(resolveWorkspaceFor(proj)).toBeNull();
  });

  it("does not return the project's own path as its workspace", () => {
    const proj = join(rootDir, "solo");
    mkdirSync(join(proj, ".flockctl"), { recursive: true });
    expect(resolveWorkspaceFor(proj)).not.toBe(proj);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI: flockctl agents show <path>                                           */
/* -------------------------------------------------------------------------- */

describe("flockctl agents show", () => {
  it("prints the merged guidance for a project path (default mode)", async () => {
    const { projectDir } = buildFullFixture();
    const expected = loadAgentGuidance({
      flockctlHome,
      workspacePath: resolveWorkspaceFor(projectDir),
      projectPath: projectDir,
    }).mergedWithHeaders;

    const { stdout, stderr, exitCode } = await runCli([
      "agents",
      "show",
      projectDir,
    ]);

    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    expect(stdout).toBe(expected);
    // Sanity: all three public layers present in the merged output.
    expect(stdout).toContain("USER-LAYER content");
    expect(stdout).toContain("WORKSPACE-PUBLIC content");
    expect(stdout).toContain("PROJECT-PUBLIC content");
  });

  it("prints the merged guidance for a workspace path when --workspace is set", async () => {
    const { workspaceDir } = buildFullFixture();
    const expected = loadWorkspaceAgentGuidance(
      workspaceDir,
      flockctlHome,
    ).mergedWithHeaders;

    const { stdout, stderr, exitCode } = await runCli([
      "agents",
      "show",
      workspaceDir,
      "--workspace",
    ]);

    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    expect(stdout).toBe(expected);
    // Workspace-scoped view must not include the project layer.
    expect(stdout).not.toContain("PROJECT-PUBLIC content");
  });

  it("--layers prints a JSON summary of per-layer byte sizes", async () => {
    const { projectDir } = buildFullFixture();
    const guidance = loadAgentGuidance({
      flockctlHome,
      workspacePath: resolveWorkspaceFor(projectDir),
      projectPath: projectDir,
    });

    const { stdout, stderr, exitCode } = await runCli([
      "agents",
      "show",
      projectDir,
      "--layers",
    ]);

    expect(exitCode).toBeNull();
    expect(stderr).toBe("");

    const parsed = JSON.parse(stdout);
    expect(parsed.totalBytes).toBe(guidance.totalBytes);
    expect(parsed.truncatedLayers).toEqual(guidance.truncatedLayers);
    expect(parsed.layers).toHaveLength(guidance.layers.length);
    for (let i = 0; i < guidance.layers.length; i++) {
      expect(parsed.layers[i]).toEqual({
        layer: guidance.layers[i].layer,
        path: guidance.layers[i].path,
        bytes: guidance.layers[i].bytes,
        truncated: guidance.layers[i].truncated,
      });
    }
    // Summary must NOT leak the raw content into stdout — only metadata.
    expect(stdout).not.toContain("USER-LAYER content");
    expect(stdout).not.toContain("WORKSPACE-PUBLIC content");
  });

  it("treats a standalone project with no workspace ancestor correctly", async () => {
    const proj = join(rootDir, "standalone");
    mkdirSync(join(proj, ".flockctl"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "SOLO content\n", "utf8");
    writeFileSync(join(flockctlHome, "AGENTS.md"), "USER content\n", "utf8");

    const expected = loadAgentGuidance({
      flockctlHome,
      workspacePath: null,
      projectPath: proj,
    }).mergedWithHeaders;

    const { stdout, exitCode } = await runCli(["agents", "show", proj]);

    expect(exitCode).toBeNull();
    expect(stdout).toBe(expected);
    expect(stdout).toContain("SOLO content");
    expect(stdout).toContain("USER content");
  });

  it("exits 1 with a stderr error when the path is not a known flockctl project", async () => {
    const unknown = join(rootDir, "not-a-project");
    mkdirSync(unknown, { recursive: true });
    // No .flockctl/ scaffold inside.

    const { stdout, stderr, exitCode } = await runCli([
      "agents",
      "show",
      unknown,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/Error:.*not a known flockctl project/i);
  });

  it("exits 1 when --workspace is passed for a non-workspace path", async () => {
    const unknown = join(rootDir, "not-a-ws");
    mkdirSync(unknown, { recursive: true });

    const { stderr, exitCode } = await runCli([
      "agents",
      "show",
      unknown,
      "--workspace",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Error:.*not a known flockctl workspace/i);
  });

  it("produces pipe-friendly output — no ANSI escape sequences", async () => {
    const { projectDir } = buildFullFixture();
    const { stdout } = await runCli(["agents", "show", projectDir]);
    // Match ESC (0x1B) — any ANSI colour sequence would contain this byte.
    expect(stdout).not.toMatch(/\u001b\[/);
  });
});
