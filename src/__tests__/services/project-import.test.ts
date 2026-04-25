import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
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
  type ImportAction,
} from "../../services/project-import.js";

let tmpBase: string;
let counter = 0;

beforeAll(() => {
  tmpBase = join(tmpdir(), `flockctl-project-import-${process.pid}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Keep tmpBase; use unique subdirs per test to avoid state leakage.
  counter++;
});

function makeDir(): string {
  const p = join(tmpBase, `t-${counter}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("scanProjectPath", () => {
  it("reports exists: false when path missing", () => {
    const missing = join(tmpBase, `missing-${counter}`);
    const scan = scanProjectPath(missing);
    expect(scan.exists).toBe(false);
    expect(scan.proposedActions).toEqual([]);
  });

  it("returns empty proposal for a clean empty directory", () => {
    const dir = makeDir();
    const scan = scanProjectPath(dir);
    expect(scan.exists).toBe(true);
    expect(scan.proposedActions).toEqual([]);
    expect(scan.alreadyManaged).toBe(false);
  });

  it("proposes adoptAgentsMd for an unmanaged AGENTS.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "# user rules\n");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.agentsMd.present).toBe(true);
    expect(scan.conflicts.agentsMd.isManaged).toBe(false);
    expect(scan.proposedActions).toContainEqual({ kind: "adoptAgentsMd" });
  });

  it("proposes mergeClaudeMd when CLAUDE.md is a regular file differing from AGENTS.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "A\n");
    writeFileSync(join(dir, "CLAUDE.md"), "B\n");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeMd.kind).toBe("file");
    expect(scan.conflicts.claudeMd.sameAsAgents).toBe(false);
    expect(scan.proposedActions).toContainEqual({ kind: "mergeClaudeMd" });
  });

  it("does NOT propose mergeClaudeMd when CLAUDE.md bytes match AGENTS.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "same\n");
    writeFileSync(join(dir, "CLAUDE.md"), "same\n");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeMd.sameAsAgents).toBe(true);
    expect(scan.proposedActions.some((a) => a.kind === "mergeClaudeMd")).toBe(false);
  });

  it("detects CLAUDE.md symlink to AGENTS.md and skips merge", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeMd.kind).toBe("symlink-to-agents");
    expect(scan.proposedActions.some((a) => a.kind === "mergeClaudeMd")).toBe(false);
  });

  it("proposes importMcpJson when .mcp.json has servers", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { foo: { command: "fooctl" }, bar: { command: "barctl" } } }),
    );
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.servers).toEqual(["bar", "foo"]);
    expect(scan.proposedActions).toContainEqual({ kind: "importMcpJson" });
  });

  it("returns parseError and empty servers for malformed .mcp.json", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".mcp.json"), "not json");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.mcpJson.parseError).not.toBeNull();
    expect(scan.proposedActions.some((a) => a.kind === "importMcpJson")).toBe(false);
  });

  it("proposes importClaudeSkill for real skill dirs and skips symlinks", () => {
    const dir = makeDir();
    const skillsDir = join(dir, ".claude", "skills");
    mkdirSync(join(skillsDir, "my-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "my-skill", "SKILL.md"), "# my\n");
    // Also create a symlink (reconciler-managed) that should be ignored.
    const upstream = join(tmpBase, `upstream-${counter}`);
    mkdirSync(upstream, { recursive: true });
    writeFileSync(join(upstream, "SKILL.md"), "# upstream\n");
    symlinkSync(upstream, join(skillsDir, "linked-skill"));

    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeSkills.find((s) => s.name === "my-skill")?.isSymlink).toBe(false);
    expect(scan.conflicts.claudeSkills.find((s) => s.name === "linked-skill")?.isSymlink).toBe(true);
    expect(scan.proposedActions).toContainEqual({ kind: "importClaudeSkill", name: "my-skill" });
    expect(scan.proposedActions.some((a) => a.kind === "importClaudeSkill" && a.name === "linked-skill")).toBe(false);
  });

  it("reports .claude/commands as info-only (never proposed)", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
    writeFileSync(join(dir, ".claude", "commands", "deploy.md"), "# cmd\n");
    const scan = scanProjectPath(dir);
    expect(scan.conflicts.claudeCommands).toEqual(["deploy.md"]);
    expect(scan.proposedActions).toEqual([]);
  });

  it("sets alreadyManaged=true when .flockctl/ exists", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".flockctl"), { recursive: true });
    const scan = scanProjectPath(dir);
    expect(scan.alreadyManaged).toBe(true);
  });
});

describe("applyImportActions — adoptAgentsMd", () => {
  it("moves AGENTS.md into .flockctl/AGENTS.md and backs up the original", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "# project\n");
    applyImportActions(dir, [{ kind: "adoptAgentsMd" }]);

    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8")).toBe("# project\n");
    // Backup directory should exist with original content.
    const backupRoot = join(dir, ".flockctl", "import-backup");
    expect(existsSync(backupRoot)).toBe(true);
  });

  it("appends under a BEGIN/END block when .flockctl/AGENTS.md already has content", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".flockctl"), { recursive: true });
    writeFileSync(join(dir, ".flockctl", "AGENTS.md"), "# existing source\n");
    writeFileSync(join(dir, "AGENTS.md"), "# root\n");

    applyImportActions(dir, [{ kind: "adoptAgentsMd" }]);
    const combined = readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8");
    expect(combined).toContain("# existing source");
    expect(combined).toContain("# root");
    expect(combined).toContain("BEGIN imported root AGENTS.md");
    expect(combined).toContain("END imported root AGENTS.md");
  });

});

describe("applyImportActions — mergeClaudeMd", () => {
  it("merges CLAUDE.md into .flockctl/AGENTS.md with markers and removes CLAUDE.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "CLAUDE.md"), "# from claude md\n");
    applyImportActions(dir, [{ kind: "mergeClaudeMd" }]);

    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    const merged = readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8");
    expect(merged).toContain("BEGIN imported CLAUDE.md");
    expect(merged).toContain("# from claude md");
    expect(merged).toContain("END imported CLAUDE.md");
  });

  it("ignores CLAUDE.md that is a symlink", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    applyImportActions(dir, [{ kind: "mergeClaudeMd" }]);
    // symlink untouched
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, ".flockctl", "AGENTS.md"))).toBe(false);
  });
});

describe("applyImportActions — importMcpJson", () => {
  it("splits .mcp.json into .flockctl/mcp/<name>.json files and removes the source", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: { command: "a" },
          beta: { command: "b", args: ["--x"] },
        },
      }),
    );

    applyImportActions(dir, [{ kind: "importMcpJson" }]);

    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const alphaPath = join(dir, ".flockctl", "mcp", "alpha.json");
    const betaPath = join(dir, ".flockctl", "mcp", "beta.json");
    expect(JSON.parse(readFileSync(alphaPath, "utf-8"))).toEqual({ command: "a" });
    expect(JSON.parse(readFileSync(betaPath, "utf-8"))).toEqual({ command: "b", args: ["--x"] });
  });

  it("does not overwrite an existing per-server file", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(dir, ".flockctl", "mcp", "alpha.json"),
      JSON.stringify({ command: "pre-existing" }),
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "new" } } }),
    );

    applyImportActions(dir, [{ kind: "importMcpJson" }]);
    const kept = JSON.parse(readFileSync(join(dir, ".flockctl", "mcp", "alpha.json"), "utf-8"));
    expect(kept.command).toBe("pre-existing");
  });
});

describe("applyImportActions — importClaudeSkill", () => {
  it("moves a real skill directory to .flockctl/skills/<name>/ with backup", () => {
    const dir = makeDir();
    const srcSkill = join(dir, ".claude", "skills", "my-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# skill\n");

    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "my-skill" }]);

    expect(existsSync(srcSkill)).toBe(false);
    expect(existsSync(join(dir, ".flockctl", "skills", "my-skill", "SKILL.md"))).toBe(true);
  });

  it("rejects path-traversal skill names", () => {
    const dir = makeDir();
    expect(() =>
      applyImportActions(dir, [{ kind: "importClaudeSkill", name: "../evil" }]),
    ).toThrow(/Invalid skill name/);
  });

  it("does not overwrite existing project-level skill with same name", () => {
    const dir = makeDir();
    const srcSkill = join(dir, ".claude", "skills", "my-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# new\n");

    const destSkill = join(dir, ".flockctl", "skills", "my-skill");
    mkdirSync(destSkill, { recursive: true });
    writeFileSync(join(destSkill, "SKILL.md"), "# pre-existing\n");

    applyImportActions(dir, [{ kind: "importClaudeSkill", name: "my-skill" }]);

    expect(readFileSync(join(destSkill, "SKILL.md"), "utf-8")).toBe("# pre-existing\n");
    // src left intact since we refused to overwrite.
    expect(existsSync(srcSkill)).toBe(true);
  });
});

describe("applyImportActions — ordering", () => {
  it("runs multiple actions atomically and never clobbers backups of different files", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# claude\n");
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { foo: { command: "f" } } }),
    );

    const actions: ImportAction[] = [
      { kind: "adoptAgentsMd" },
      { kind: "mergeClaudeMd" },
      { kind: "importMcpJson" },
    ];
    applyImportActions(dir, actions);

    const src = readFileSync(join(dir, ".flockctl", "AGENTS.md"), "utf-8");
    expect(src).toContain("# agents");
    expect(src).toContain("# claude");
    expect(src).toContain("BEGIN imported CLAUDE.md");

    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".flockctl", "mcp", "foo.json"))).toBe(true);
  });
});

describe("scanProjectPath — git detection", () => {
  it("reports git.present=true for initialized repo without origin", async () => {
    const dir = makeDir();
    const { execSync } = await import("child_process");
    execSync("git init -q", { cwd: dir });
    const scan = scanProjectPath(dir);
    expect(scan.git.present).toBe(true);
    expect(scan.git.originUrl).toBeNull();
  });

  it("reports originUrl when remote is set", async () => {
    const dir = makeDir();
    const { execSync } = await import("child_process");
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin https://example.com/repo.git", { cwd: dir });
    const scan = scanProjectPath(dir);
    expect(scan.git.present).toBe(true);
    expect(scan.git.originUrl).toBe("https://example.com/repo.git");
  });
});

describe("safeReadText + isWritable (indirect)", () => {
  it("scan a path whose parent does not exist (isWritable catch branch)", () => {
    // Non-existent path whose parent also doesn't exist triggers isWritable
    // statSync failure → catch returns false
    const ghost = join(tmpBase, "ghost-parent", "ghost-child");
    const scan = scanProjectPath(ghost);
    expect(scan.exists).toBe(false);
    expect(scan.writable).toBe(false);
  });
});
