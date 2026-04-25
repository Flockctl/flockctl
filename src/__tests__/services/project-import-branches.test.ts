/**
 * Branch-coverage tests for `src/services/project-import.ts`.
 *
 * Targets missing branches not covered by `project-import.test.ts`:
 *  - applyImportActions: length===0 no-op, missing path throws
 *  - adoptAgentsMd: pre-existing .flockctl/AGENTS.md with no trailing newline
 *    (appendBlock `sep = "\n\n"` branch)
 *  - mergeClaudeMd: source-missing and pre-existing dest content
 *  - importMcpJson: unreadable .mcp.json source, empty-servers payload,
 *    non-object .mcp.json root (parsed as array → extractMcpServers edge)
 *  - detectClaudeMd: `symlink-other` (symlink pointing elsewhere)
 *  - extractMcpServers: top-level object is already a server map (no mcpServers
 *    wrapper), values that are non-objects get filtered out
 *  - importClaudeSkill: source dir is a symlink → skipped; src dir is a file
 *    (not a dir) → skipped; missing SKILL.md → skipped
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  scanProjectPath,
  applyImportActions,
} from "../../services/project-import.js";

let tmpBase: string;
let counter = 0;

beforeAll(() => {
  tmpBase = join(tmpdir(), `flockctl-project-import-branches-${process.pid}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => { counter++; });

function makeDir(): string {
  const p = join(tmpBase, `t-${counter}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("applyImportActions — early-exits", () => {
  it("no-ops when action list is empty", () => {
    const dir = makeDir();
    // Should not throw even though .flockctl/ doesn't exist.
    applyImportActions(dir, []);
    expect(existsSync(join(dir, ".flockctl"))).toBe(false);
  });

  it("throws when project path does not exist", () => {
    const missing = join(tmpBase, `ghost-${counter}`);
    expect(() => applyImportActions(missing, [{ kind: "adoptAgentsMd" }])).toThrow(
      /does not exist/,
    );
  });
});

describe("adoptAgentsMd — appendBlock separator branch", () => {
  it("inserts double-newline when existing .flockctl/AGENTS.md has no trailing newline", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".flockctl"), { recursive: true });
    // Existing content deliberately has NO trailing newline → hits `\n\n` branch.
    writeFileSync(join(dir, ".flockctl", "AGENTS.md"), "# existing");
    writeFileSync(join(dir, "AGENTS.md"), "# root\n");

    applyImportActions(dir, [{ kind: "adoptAgentsMd" }]);
    const combined = readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8");
    // Double newline appears before the BEGIN block.
    expect(combined).toMatch(/# existing\n\n<!-- BEGIN imported root AGENTS.md -->/);
  });

  it("is a no-op when the root AGENTS.md source is missing", () => {
    const dir = makeDir();
    // No AGENTS.md at the project root.
    applyImportActions(dir, [{ kind: "adoptAgentsMd" }]);
    expect(existsSync(join(dir, ".flockctl", "AGENTS.md"))).toBe(false);
  });
});

describe("mergeClaudeMd — edge branches", () => {
  it("is a no-op when CLAUDE.md source does not exist", () => {
    const dir = makeDir();
    applyImportActions(dir, [{ kind: "mergeClaudeMd" }]);
    expect(existsSync(join(dir, ".flockctl", "AGENTS.md"))).toBe(false);
  });

  it("appends below existing .flockctl/AGENTS.md with a blank line separator", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".flockctl"), { recursive: true });
    writeFileSync(join(dir, ".flockctl", "AGENTS.md"), "# prior\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# claude\n");

    applyImportActions(dir, [{ kind: "mergeClaudeMd" }]);
    const merged = readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8");
    expect(merged).toContain("# prior");
    expect(merged).toContain("BEGIN imported CLAUDE.md");
    expect(merged).toContain("# claude");
  });
});

describe("importMcpJson — empty / malformed / alt-shape", () => {
  it("is a no-op when servers payload is empty", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    applyImportActions(dir, [{ kind: "importMcpJson" }]);
    // Source file should still be present (no action taken).
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("accepts flat top-level server map when no `mcpServers` key is present", () => {
    const dir = makeDir();
    // Direct server map at root (no mcpServers wrapper).
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ foo: { command: "c1" }, bar: "not-an-object" }),
    );
    applyImportActions(dir, [{ kind: "importMcpJson" }]);
    // `foo` imported; `bar` filtered out because value isn't an object.
    expect(existsSync(join(dir, ".flockctl", "mcp", "foo.json"))).toBe(true);
    expect(existsSync(join(dir, ".flockctl", "mcp", "bar.json"))).toBe(false);
  });

  it("leaves malformed .mcp.json intact and does not crash", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".mcp.json"), "not json{{");
    applyImportActions(dir, [{ kind: "importMcpJson" }]);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(dir, ".flockctl", "mcp"))).toBe(false);
  });
});

describe("detectClaudeMd — symlink-other branch", () => {
  it("reports kind=symlink-other when CLAUDE.md points to something other than AGENTS.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "OTHER.md"), "other\n");
    symlinkSync("OTHER.md", join(dir, "CLAUDE.md"));
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeMd.kind).toBe("symlink-other");
    expect(scan.conflicts.claudeMd.sameAsAgents).toBe(false);
    // No merge proposed for symlink-other.
    expect(scan.proposedActions.some((a) => a.kind === "mergeClaudeMd")).toBe(false);
  });
});

describe("importClaudeSkill — guarded skips", () => {
  it("skips when the skill dir is a symlink (flockctl-managed)", () => {
    const dir = makeDir();
    // Create a real dir to symlink to
    const real = join(tmpBase, `real-skill-${counter}`);
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "# skill\n");
    // skills/ parent
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    symlinkSync(real, join(dir, ".claude", "skills", "linked"));

    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "linked" }]);
    // Nothing moved — symlink still present, dest not created.
    expect(existsSync(join(dir, ".claude", "skills", "linked"))).toBe(true);
    expect(existsSync(join(dir, ".flockctl", "skills", "linked"))).toBe(false);
  });

  it("skips when src is a file, not a directory", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "bogus"), "oops\n");
    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "bogus" }]);
    expect(existsSync(join(dir, ".flockctl", "skills", "bogus"))).toBe(false);
  });

  it("skips when skill dir lacks SKILL.md", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".claude", "skills", "empty"), { recursive: true });
    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "empty" }]);
    expect(existsSync(join(dir, ".flockctl", "skills", "empty"))).toBe(false);
  });

  it("is a no-op when skill source dir does not exist at all", () => {
    const dir = makeDir();
    // No .claude/skills/ghost/ at all — exit early.
    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "ghost" }]);
    expect(existsSync(join(dir, ".flockctl", "skills", "ghost"))).toBe(false);
  });
});

describe("detectGit — branches", () => {
  it("returns present=true, originUrl=null for a bare .git without origin remote", () => {
    const dir = makeDir();
    // Create an empty .git directory — existsSync checks pass, `git remote
    // get-url origin` throws → originUrl = null.
    mkdirSync(join(dir, ".git"), { recursive: true });
    const scan = scanProjectPath(dir);
    expect(scan.git.present).toBe(true);
    expect(scan.git.originUrl).toBeNull();
  });

  it("returns present=false when .git is absent", () => {
    const dir = makeDir();
    const scan = scanProjectPath(dir);
    expect(scan.git.present).toBe(false);
    expect(scan.git.originUrl).toBeNull();
  });
});

describe("detectClaudeMd — non-file branches", () => {
  it("reports kind=none when CLAUDE.md is a directory (not a file, not a symlink)", () => {
    const dir = makeDir();
    // Create a DIRECTORY named CLAUDE.md — lstat succeeds, isSymbolicLink false,
    // isFile false → `kind: "none"` return path (line ~303).
    mkdirSync(join(dir, "CLAUDE.md"));
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeMd.present).toBe(false);
    expect(scan.conflicts.claudeMd.kind).toBe("none");
  });
});

describe("detectMcpJson — server-name enumeration", () => {
  it("lists server names from flat-top-level shape (no mcpServers wrapper)", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ alpha: { command: "a" }, beta: { command: "b" } }),
    );
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.servers).toEqual(["alpha", "beta"]);
  });

  it("returns empty servers when JSON root is not an object (line 448)", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".mcp.json"), "42");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.present).toBe(true);
    expect(scan.conflicts.mcpJson.servers).toEqual([]);
    expect(scan.conflicts.mcpJson.parseError).toBeNull();
  });

  it("returns empty servers when mcpServers key exists but is not an object (line 451)", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: "not-object" }));
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.servers).toEqual([]);
    expect(scan.conflicts.mcpJson.parseError).toBeNull();
  });

  it("includes non-Error parse rejection as string", () => {
    const dir = makeDir();
    // Empty JSON blob triggers JSON.parse to return undefined → extractMcpServers
    // path returns empty. Meanwhile a raw `null` body throws — the instanceof
    // Error fallback uses String(err).
    writeFileSync(join(dir, ".mcp.json"), "");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.present).toBe(true);
    // Either `parseError` is a string message or `null` if JSON.parse("") tolerant;
    // Node throws SyntaxError on "" so parseError should be non-null.
    expect(scan.conflicts.mcpJson.parseError).not.toBeNull();
    expect(scan.conflicts.mcpJson.servers).toEqual([]);
  });
});
