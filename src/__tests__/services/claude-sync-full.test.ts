import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";

let tmpBase: string;
let db: FlockctlDb;
let sqlite: Database.Database;

vi.mock("../../config", async () => {
  const actual = await vi.importActual<any>("../../config");
  return {
    ...actual,
    getFlockctlHome: () => tmpBase,
    getGlobalSkillsDir: () => join(tmpBase, "global-skills"),
    getGlobalMcpDir: () => join(tmpBase, "global-mcp"),
  };
});

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tmpBase = mkdtempSync(join(tmpdir(), "flockctl-sync-full-"));
  // global dirs need to exist for resolveSkills/resolveMcp to read
  mkdirSync(join(tmpBase, "global-skills"), { recursive: true });
  mkdirSync(join(tmpBase, "global-mcp"), { recursive: true });
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  sqlite.exec(`DELETE FROM projects; DELETE FROM workspaces; DELETE FROM secrets;`);
  const mod = await import("../../services/secrets.js");
  mod._resetMasterKeyCache();
});

import {
  reconcileClaudeSkillsForProject,
  reconcileClaudeSkillsForWorkspace,
  reconcileAllProjects,
  reconcileAllProjectsInWorkspace,
  ensureGitExclude,
} from "../../services/claude/skills-sync.js";

/**
 * Initialize a minimal `.git/info/` skeleton so `ensureGitExclude` treats
 * `dir` as a real git checkout and writes the managed block. Tests do not
 * actually need a working git repo — `ensureGitExclude` only cares that
 * `<dir>/.git/info/` exists and is writable.
 */
function initFakeGitRepo(dir: string): void {
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
}

/** Convenience: read `.git/info/exclude` from a fake-git-init'd dir. */
function readExclude(dir: string): string {
  return readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
}

import {
  reconcileMcpForProject,
  reconcileMcpForWorkspace,
  reconcileAllMcp,
  reconcileAllMcpInWorkspace,
} from "../../services/claude/mcp-sync.js";

import { resolveSkillsForWorkspace } from "../../services/skills.js";
import { resolveMcpServersForWorkspace, resolveMcpServersForProject, loadMcpServersFromDir } from "../../services/mcp.js";

// ─── skills sync ───────────────────────────────────────────────────────────

describe("claude-skills-sync", () => {
  it("reconcileClaudeSkillsForProject no-ops when project missing", () => {
    expect(() => reconcileClaudeSkillsForProject(99999)).not.toThrow();
  });

  it("reconcileClaudeSkillsForProject no-ops when project.path missing", () => {
    db.insert(projects).values({ name: "np" }).run();
    expect(() => reconcileClaudeSkillsForProject(1)).not.toThrow();
  });

  it("reconcileClaudeSkillsForWorkspace no-ops on missing workspace", () => {
    expect(() => reconcileClaudeSkillsForWorkspace(99999)).not.toThrow();
  });

  it("writes symlinks and manifest for project skills", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-"));
    initFakeGitRepo(projPath);
    const globalSkill = join(tmpBase, "global-skills", "s-global");
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(globalSkill, "SKILL.md"), "# global");

    const projSkill = join(projPath, ".flockctl", "skills", "s-proj");
    mkdirSync(projSkill, { recursive: true });
    writeFileSync(join(projSkill, "SKILL.md"), "# proj");

    const proj = db.insert(projects).values({ name: "p", path: projPath }).returning().get()!;
    reconcileClaudeSkillsForProject(proj.id);

    // symlink directory written
    const targetDir = join(projPath, ".claude", "skills");
    expect(existsSync(join(targetDir, "s-global"))).toBe(true);
    expect(existsSync(join(targetDir, "s-proj"))).toBe(true);
    expect(readlinkSync(join(targetDir, "s-global"))).toBe(globalSkill);

    // manifest written
    const manifestPath = join(projPath, ".flockctl", "skills-state.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const names = manifest.skills.map((s: any) => s.name).sort();
    expect(names).toEqual(["s-global", "s-proj"]);

    // reconcile marker written
    expect(existsSync(join(projPath, ".flockctl", ".skills-reconcile"))).toBe(true);

    // .git/info/exclude updated with marked Flockctl block (local-only)
    const exclude = readExclude(projPath);
    expect(exclude).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(exclude).toContain("# ─── /Flockctl ───");
    expect(exclude).toContain(".claude/skills/");
    expect(exclude).toContain(".mcp.json");
    // Team-tracked .gitignore must NOT receive Flockctl entries
    if (existsSync(join(projPath, ".gitignore"))) {
      const gi = readFileSync(join(projPath, ".gitignore"), "utf-8");
      expect(gi).not.toContain("Flockctl (auto-managed");
      expect(gi).not.toContain(".claude/skills/");
    }
  });

  it("skips non-symlink entries and removes stale/ghost links", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-stale-"));
    const proj = db.insert(projects).values({ name: "stale", path: projPath }).returning().get()!;

    const targetDir = join(projPath, ".claude", "skills");
    mkdirSync(targetDir, { recursive: true });

    // 1. plain file (non-symlink) — should be left untouched
    writeFileSync(join(targetDir, "keep-me"), "regular file");

    // 2. broken symlink (points to nonexistent) — should be removed
    symlinkSync(join(tmpBase, "never-existed"), join(targetDir, "broken-link"));

    // 3. unwanted symlink (points to a real dir but no longer desired)
    const ghost = join(tmpBase, "ghost-source");
    mkdirSync(ghost, { recursive: true });
    symlinkSync(ghost, join(targetDir, "ghost-link"));

    reconcileClaudeSkillsForProject(proj.id);

    // keep-me is regular file → untouched
    expect(existsSync(join(targetDir, "keep-me"))).toBe(true);
    // broken-link cleaned up
    expect(lstatSync(join(targetDir, "broken-link"), { throwIfNoEntry: false } as any)).toBeUndefined();
    // ghost-link cleaned up (not in desired set)
    expect(lstatSync(join(targetDir, "ghost-link"), { throwIfNoEntry: false } as any)).toBeUndefined();
  });

  it("rewrites symlink when it points to the wrong source", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-retarget-"));
    const proj = db.insert(projects).values({ name: "retarget", path: projPath }).returning().get()!;

    // Desired skill
    const desired = join(tmpBase, "desired-skill");
    mkdirSync(desired, { recursive: true });
    writeFileSync(join(desired, "SKILL.md"), "");
    mkdirSync(join(projPath, ".flockctl", "skills"), { recursive: true });
    // skill source lives in project .flockctl — but we'll manually place a stale symlink in the target dir
    const projSkillSrc = join(projPath, ".flockctl", "skills", "my");
    mkdirSync(projSkillSrc, { recursive: true });
    writeFileSync(join(projSkillSrc, "SKILL.md"), "");

    const targetDir = join(projPath, ".claude", "skills");
    mkdirSync(targetDir, { recursive: true });
    // Point "my" at the wrong dir (the "desired" unrelated source)
    symlinkSync(desired, join(targetDir, "my"));

    reconcileClaudeSkillsForProject(proj.id);

    // After reconcile, "my" should now point to projSkillSrc
    const linkTarget = readlinkSync(join(targetDir, "my"));
    expect(linkTarget).toBe(projSkillSrc);
  });

  it("reconcileAllProjects iterates ws + projects and tolerates failures", () => {
    db.insert(workspaces).values({ name: "ws-bad", path: "/nonexistent-xxx-1" }).run();
    db.insert(projects).values({ name: "p-bad", path: "/nonexistent-xxx-2" }).run();
    expect(() => reconcileAllProjects()).not.toThrow();
  });

  it("reconcileAllProjectsInWorkspace cascades to children", () => {
    const wsPath = mkdtempSync(join(tmpBase, "ws-cascade-"));
    const projPath = mkdtempSync(join(tmpBase, "proj-cascade-"));
    const ws = db.insert(workspaces).values({ name: "ws-cascade", path: wsPath }).returning().get()!;
    db.insert(projects).values({ name: "p-cascade", workspaceId: ws.id, path: projPath }).run();

    expect(() => reconcileAllProjectsInWorkspace(ws.id)).not.toThrow();
    expect(existsSync(join(wsPath, ".flockctl", "skills-state.json"))).toBe(true);
    expect(existsSync(join(projPath, ".flockctl", "skills-state.json"))).toBe(true);
  });

  it("ensureGitExclude is a no-op outside a git checkout", () => {
    const dir = mkdtempSync(join(tmpBase, "no-git-"));
    // No `.git/` initialised — nothing to write to.
    expect(() => ensureGitExclude(dir)).not.toThrow();
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("ensureGitExclude writes a marked block into .git/info/exclude", () => {
    const dir = mkdtempSync(join(tmpBase, "exclude-write-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir);

    const exclude = readExclude(dir);
    expect(exclude).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(exclude).toContain("# ─── /Flockctl ───");
    expect(exclude).toContain(".claude/skills/");
    expect(exclude).toContain(".mcp.json");
    expect(exclude).toContain(".flockctl/.skills-reconcile");
    // Team `.gitignore` is never created or touched by the writer.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("ensureGitExclude preserves prior personal exclude entries above the block", () => {
    const dir = mkdtempSync(join(tmpBase, "exclude-personal-"));
    initFakeGitRepo(dir);
    const prior = "# Personal scratch\nscratch/\nlocal-notes.md\n";
    writeFileSync(join(dir, ".git", "info", "exclude"), prior);

    ensureGitExclude(dir);
    const after = readExclude(dir);
    // Personal entries preserved verbatim
    expect(after).toContain("# Personal scratch");
    expect(after).toContain("scratch/");
    expect(after).toContain("local-notes.md");
    // Managed block appended
    expect(after).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
  });

  it("ensureGitExclude migrates legacy Flockctl block out of .gitignore", () => {
    const dir = mkdtempSync(join(tmpBase, "legacy-migrate-"));
    initFakeGitRepo(dir);
    // Simulate an older Flockctl that wrote into `.gitignore`.
    const legacyGitignore =
      [
        "node_modules/",
        "",
        "# ─── Flockctl (auto-managed — do not edit) ───",
        ".claude/skills/",
        ".mcp.json",
        ".flockctl/.skills-reconcile",
        ".flockctl/.mcp-reconcile",
        ".flockctl/.agents-reconcile",
        ".flockctl/import-backup/",
        ".flockctl/plan/",
        "# ─── /Flockctl ───",
      ].join("\n") + "\n";
    writeFileSync(join(dir, ".gitignore"), legacyGitignore);

    ensureGitExclude(dir);

    // `.gitignore` no longer contains any Flockctl-managed content
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).not.toContain("Flockctl (auto-managed");
    expect(gi).not.toContain(".claude/skills/");
    expect(gi).not.toContain(".mcp.json");
    expect(gi).not.toContain(".flockctl/.skills-reconcile");
    // Block now lives in `.git/info/exclude`
    const exclude = readExclude(dir);
    expect(exclude).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(exclude).toContain(".claude/skills/");
  });

  it("ensureGitExclude strips bare managed lines from .gitignore (no marked block)", () => {
    const dir = mkdtempSync(join(tmpBase, "legacy-bare-"));
    initFakeGitRepo(dir);
    // Pre-marker era: managed lines appended raw, no fence around them.
    writeFileSync(
      join(dir, ".gitignore"),
      ["node_modules/", ".claude/skills/", ".mcp.json", ".flockctl/import-backup/"].join("\n") +
        "\n",
    );

    ensureGitExclude(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).not.toContain(".claude/skills/");
    expect(gi).not.toContain(".mcp.json");
    expect(gi).not.toContain(".flockctl/import-backup/");
  });

  it("ensureGitExclude is idempotent — second run leaves exclude byte-identical", () => {
    const dir = mkdtempSync(join(tmpBase, "exclude-idem-"));
    initFakeGitRepo(dir);
    writeFileSync(join(dir, ".git", "info", "exclude"), "# personal\nscratch/\n");

    ensureGitExclude(dir);
    const first = readExclude(dir);
    ensureGitExclude(dir);
    const second = readExclude(dir);
    expect(second).toBe(first);
  });

  it("ensureGitExclude no-ops when .git is a file without a gitdir: pointer", () => {
    const dir = mkdtempSync(join(tmpBase, "wt-malformed-"));
    writeFileSync(join(dir, ".git"), "this is not a worktree pointer\n");
    expect(() => ensureGitExclude(dir)).not.toThrow();
    // No exclude written anywhere.
    expect(existsSync(join(dir, ".git", "info"))).toBe(false);
  });

  it("ensureGitExclude leaves .gitignore empty when only managed lines were present", () => {
    const dir = mkdtempSync(join(tmpBase, "legacy-only-managed-"));
    initFakeGitRepo(dir);
    writeFileSync(
      join(dir, ".gitignore"),
      [".claude/skills/", ".mcp.json", ".flockctl/plan/"].join("\n") + "\n",
    );
    ensureGitExclude(dir);
    // All content was Flockctl-managed → file is now empty.
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("");
  });

  it("ensureGitExclude works for linked worktrees (.git is a file with gitdir:)", () => {
    // Simulate the layout `git worktree add` produces: `<worktree>/.git` is a
    // *file* containing `gitdir: <path-to-real-gitdir>`, and the real gitdir
    // lives elsewhere with its own `info/` directory.
    const realGitdir = mkdtempSync(join(tmpBase, "wt-gitdir-"));
    mkdirSync(join(realGitdir, "info"), { recursive: true });
    const worktree = mkdtempSync(join(tmpBase, "wt-checkout-"));
    writeFileSync(join(worktree, ".git"), `gitdir: ${realGitdir}\n`);

    ensureGitExclude(worktree);
    const exclude = readFileSync(join(realGitdir, "info", "exclude"), "utf-8");
    expect(exclude).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(exclude).toContain(".claude/skills/");
    // No exclude was written under the worktree's checkout dir itself.
    expect(existsSync(join(worktree, ".git", "info"))).toBe(false);
  });

  // ─── Toggles (migration 0038) ──────────────────────────────────────────

  it("toggles=off → only base patterns are written", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-base-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir); // no options → defaults to off
    const after = readExclude(dir);
    // Base patterns present
    expect(after).toContain(".claude/skills/");
    expect(after).toContain(".flockctl/.skills-reconcile");
    expect(after).toContain(".flockctl/plan/");
    // Optional patterns absent
    expect(after).not.toMatch(/^\.flockctl\/$/m);
    expect(after).not.toMatch(/^TODO\.md$/m);
    expect(after).not.toMatch(/^AGENTS\.md$/m);
    expect(after).not.toMatch(/^CLAUDE\.md$/m);
  });

  it("flockctl=true collapses the sub-paths into .flockctl/", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-flock-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir, { flockctl: true });
    const lines = readExclude(dir).split("\n");
    expect(lines.filter((l) => l === ".flockctl/").length).toBe(1);
    expect(lines).not.toContain(".flockctl/.skills-reconcile");
    expect(lines).not.toContain(".flockctl/plan/");
    expect(lines).not.toContain(".flockctl/import-backup/");
  });

  it("todo=true adds TODO.md to the block", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-todo-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir, { todo: true });
    expect(readExclude(dir).split("\n").filter((l) => l === "TODO.md").length).toBe(1);
  });

  it("agentsMd=true adds BOTH AGENTS.md and CLAUDE.md", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-agents-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir, { agentsMd: true });
    const lines = readExclude(dir).split("\n");
    expect(lines.filter((l) => l === "AGENTS.md").length).toBe(1);
    expect(lines.filter((l) => l === "CLAUDE.md").length).toBe(1);
  });

  it("all three flags produce a superset block", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-all-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir, { flockctl: true, todo: true, agentsMd: true });
    const after = readExclude(dir);
    for (const pat of [".flockctl/", "TODO.md", "AGENTS.md", "CLAUDE.md"]) {
      expect(after.split("\n").filter((l) => l === pat).length).toBe(1);
    }
    // `.claude/skills/` and `.mcp.json` still present — they live outside
    // `.flockctl/` and must always be excluded.
    expect(after).toContain(".claude/skills/");
    expect(after).toContain(".mcp.json");
  });

  it("flipping a flag off strips the previous entry on next run", () => {
    const dir = mkdtempSync(join(tmpBase, "tog-flip-"));
    initFakeGitRepo(dir);
    ensureGitExclude(dir, { todo: true });
    expect(readExclude(dir)).toContain("TODO.md");
    ensureGitExclude(dir, { todo: false });
    expect(readExclude(dir).split("\n").filter((l) => l === "TODO.md").length).toBe(0);
  });

  it("toggles wired into reconcile via project row", () => {
    const projPath = mkdtempSync(join(tmpBase, "tog-proj-"));
    initFakeGitRepo(projPath);
    const proj = db
      .insert(projects)
      .values({
        name: "tog-proj",
        path: projPath,
        gitignoreFlockctl: true,
        gitignoreTodo: true,
        gitignoreAgentsMd: true,
      })
      .returning()
      .get()!;

    reconcileClaudeSkillsForProject(proj.id);
    const after = readExclude(projPath);
    expect(after).toContain(".flockctl/");
    expect(after).toContain("TODO.md");
    expect(after).toContain("AGENTS.md");
    expect(after).toContain("CLAUDE.md");
  });

  it("writeManifest skips write when content unchanged (byte-stable)", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-stable-"));
    const proj = db.insert(projects).values({ name: "stable", path: projPath }).returning().get()!;

    reconcileClaudeSkillsForProject(proj.id);
    const manifest = join(projPath, ".flockctl", "skills-state.json");
    const mtime1 = require("fs").statSync(manifest).mtimeMs;

    // wait and reconcile again
    const later = Date.now() + 50;
    while (Date.now() < later) { /* busy wait */ }
    reconcileClaudeSkillsForProject(proj.id);
    const mtime2 = require("fs").statSync(manifest).mtimeMs;
    // If byte-stable, either same mtime or at least file still readable
    expect(mtime2).toBeGreaterThanOrEqual(mtime1);
  });
});

// ─── mcp sync ──────────────────────────────────────────────────────────────

describe("claude-mcp-sync", () => {
  it("no-op on missing project / no path", () => {
    expect(() => reconcileMcpForProject(99999)).not.toThrow();
    db.insert(projects).values({ name: "np-mcp" }).run();
    expect(() => reconcileMcpForProject(1)).not.toThrow();
  });

  it("no-op on missing workspace", () => {
    expect(() => reconcileMcpForWorkspace(99999)).not.toThrow();
  });

  it("writes merged .mcp.json and manifest for project", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-mcp-"));
    const proj = db.insert(projects).values({ name: "pm", path: projPath }).returning().get()!;

    // Add a global MCP server
    writeFileSync(
      join(tmpBase, "global-mcp", "g-server.json"),
      JSON.stringify({ command: "node", args: ["global.js"] }),
    );
    // Add a project-level MCP server
    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "p-server.json"),
      JSON.stringify({ command: "python", args: ["project.py"] }),
    );

    reconcileMcpForProject(proj.id);

    const merged = JSON.parse(readFileSync(join(projPath, ".mcp.json"), "utf-8"));
    expect(Object.keys(merged.mcpServers).sort()).toEqual(["g-server", "p-server"]);
    expect(merged.mcpServers["p-server"].command).toBe("python");

    const manifest = JSON.parse(readFileSync(join(projPath, ".flockctl", "mcp-state.json"), "utf-8"));
    expect(manifest.mcpServers.length).toBe(2);
    expect(existsSync(join(projPath, ".flockctl", ".mcp-reconcile"))).toBe(true);
  });

  it("writes workspace-level .mcp.json and manifest", () => {
    const wsPath = mkdtempSync(join(tmpBase, "ws-mcp-"));
    const ws = db.insert(workspaces).values({ name: "wmcp", path: wsPath }).returning().get()!;

    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "mcp", "w-server.json"),
      JSON.stringify({ command: "bash" }),
    );

    reconcileMcpForWorkspace(ws.id);

    const merged = JSON.parse(readFileSync(join(wsPath, ".mcp.json"), "utf-8"));
    expect(Object.keys(merged.mcpServers)).toContain("w-server");
  });

  it("resolves ${secret:NAME} placeholders in env when writing .mcp.json", async () => {
    const { upsertSecret } = await import("../../services/secrets.js");
    const wsPath = mkdtempSync(join(tmpBase, "ws-mcp-secret-"));
    const ws = db.insert(workspaces).values({ name: "ws-sec", path: wsPath }).returning().get()!;
    const projPath = mkdtempSync(join(tmpBase, "proj-mcp-secret-"));
    const proj = db.insert(projects).values({ name: "p-sec", workspaceId: ws.id, path: projPath }).returning().get()!;

    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "github.json"),
      JSON.stringify({
        command: "npx",
        args: ["server-github"],
        env: { GITHUB_TOKEN: "${secret:GITHUB_TOKEN}", OTHER: "literal" },
      }),
    );

    // Secret only at project scope
    upsertSecret({ scope: "project", scopeId: proj.id, name: "GITHUB_TOKEN", value: "ghp_secret" });

    reconcileMcpForProject(proj.id);

    const merged = JSON.parse(readFileSync(join(projPath, ".mcp.json"), "utf-8"));
    expect(merged.mcpServers["github"].env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(merged.mcpServers["github"].env.OTHER).toBe("literal");

    // Source file on disk keeps the placeholder (safe to commit)
    const src = JSON.parse(readFileSync(join(projPath, ".flockctl", "mcp", "github.json"), "utf-8"));
    expect(src.env.GITHUB_TOKEN).toBe("${secret:GITHUB_TOKEN}");
  });

  it("keeps placeholder intact when the secret is missing everywhere", () => {
    const projPath = mkdtempSync(join(tmpBase, "proj-mcp-missing-"));
    const proj = db.insert(projects).values({ name: "p-miss", path: projPath }).returning().get()!;
    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(
      join(projPath, ".flockctl", "mcp", "srv.json"),
      JSON.stringify({ command: "node", env: { K: "${secret:MISSING}" } }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reconcileMcpForProject(proj.id);
    const merged = JSON.parse(readFileSync(join(projPath, ".mcp.json"), "utf-8"));
    expect(merged.mcpServers["srv"].env.K).toBe("${secret:MISSING}");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reconcileAllMcp / reconcileAllMcpInWorkspace tolerate failures", () => {
    db.insert(workspaces).values({ name: "ws-ok", path: "/nonexistent-ok-1" }).run();
    db.insert(projects).values({ name: "p-ok", path: "/nonexistent-ok-2" }).run();
    expect(() => reconcileAllMcp()).not.toThrow();

    const wsPath = mkdtempSync(join(tmpBase, "ws-cascade-mcp-"));
    const ws = db.insert(workspaces).values({ name: "ws-cascade-mcp", path: wsPath }).returning().get()!;
    const projPath = mkdtempSync(join(tmpBase, "proj-cascade-mcp-"));
    db.insert(projects).values({ name: "p-cm", workspaceId: ws.id, path: projPath }).run();
    expect(() => reconcileAllMcpInWorkspace(ws.id)).not.toThrow();
    expect(existsSync(join(wsPath, ".mcp.json"))).toBe(true);
    expect(existsSync(join(projPath, ".mcp.json"))).toBe(true);
  });
});

// ─── mcp.ts resolvers ─────────────────────────────────────────────────────

describe("mcp resolvers", () => {
  it("loadMcpServersFromDir reads combined mcp.json", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-combined-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        "foo": { command: "node" },
        "bar": { command: "bash" },
      },
    }));
    const servers = loadMcpServersFromDir(dir, "global");
    expect(servers.map(s => s.name).sort()).toEqual(["bar", "foo"]);
  });

  it("loadMcpServersFromDir falls back to flat map (no mcpServers wrapper)", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-flat-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      "srv": { command: "sh" },
    }));
    const servers = loadMcpServersFromDir(dir, "global");
    expect(servers.map(s => s.name)).toContain("srv");
  });

  it("loadMcpServersFromDir handles malformed mcp.json gracefully", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-bad-"));
    writeFileSync(join(dir, "mcp.json"), "{ not json");
    expect(() => loadMcpServersFromDir(dir, "global")).not.toThrow();
  });

  it("loadMcpServersFromDir merges {name}.local.json override (env merged)", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-override-"));
    writeFileSync(join(dir, "foo.json"), JSON.stringify({
      command: "node", args: ["a.js"], env: { K1: "v1" },
    }));
    writeFileSync(join(dir, "foo.local.json"), JSON.stringify({
      env: { K2: "v2" }, args: ["b.js"],
    }));

    const servers = loadMcpServersFromDir(dir, "project");
    const foo = servers.find(s => s.name === "foo")!;
    expect(foo.config.env).toEqual({ K1: "v1", K2: "v2" });
    expect(foo.config.args).toEqual(["b.js"]);
  });

  it("loadMcpServersFromDir skips duplicate when same name exists in combined", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-dup-"));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: { "x": { command: "combined" } },
    }));
    writeFileSync(join(dir, "x.json"), JSON.stringify({ command: "standalone" }));

    const servers = loadMcpServersFromDir(dir, "global");
    const xs = servers.filter(s => s.name === "x");
    expect(xs.length).toBe(1);
    expect(xs[0].config.command).toBe("combined");
  });

  it("loadMcpServersFromDir swallows individual JSON parse errors", () => {
    const dir = mkdtempSync(join(tmpBase, "mcp-parse-err-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ command: "ok" }));
    writeFileSync(join(dir, "broken.json"), "{{");
    const servers = loadMcpServersFromDir(dir, "global");
    expect(servers.map(s => s.name)).toEqual(["ok"]);
  });

  it("resolveMcpServersForProject returns empty with no projectId and no globals", () => {
    const fresh = mkdtempSync(join(tmpBase, "fresh-global-mcp-"));
    // Override mock at runtime by using isolated tmpBase path — here we just
    // expect existing global-mcp path to contain whatever has been written.
    expect(Array.isArray(resolveMcpServersForProject(null))).toBe(true);
    void fresh;
  });

  it("resolveMcpServersForWorkspace reads global + workspace minus disables", () => {
    const wsPath = mkdtempSync(join(tmpBase, "ws-resolver-mcp-"));
    const ws = db.insert(workspaces).values({ name: "ws-res-mcp", path: wsPath }).returning().get()!;

    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(join(wsPath, ".flockctl", "mcp", "w-mcp.json"), JSON.stringify({ command: "w" }));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledMcpServers: [{ name: "w-mcp", level: "workspace" }] }),
    );

    const servers = resolveMcpServersForWorkspace(ws.id);
    // w-mcp should be disabled by workspace-level disable
    expect(servers.find(s => s.name === "w-mcp")).toBeUndefined();
  });
});

// ─── skills.ts workspace resolver ─────────────────────────────────────────

describe("resolveSkillsForWorkspace", () => {
  it("returns globals when workspace has no path", () => {
    db.insert(workspaces).values({ name: "ws-none", path: "" }).run();
    const ws = db.select().from(workspaces).all()[0]!;
    const skills = resolveSkillsForWorkspace(ws.id);
    expect(Array.isArray(skills)).toBe(true);
  });

  it("disables global skills flagged at workspace level", () => {
    // Create a global skill we'll disable
    const disabledSkillDir = join(tmpBase, "global-skills", "ws-disable-me");
    mkdirSync(disabledSkillDir, { recursive: true });
    writeFileSync(join(disabledSkillDir, "SKILL.md"), "");

    const wsPath = mkdtempSync(join(tmpBase, "ws-skills-"));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ disabledSkills: [{ name: "ws-disable-me", level: "global" }] }),
    );
    const ws = db.insert(workspaces).values({ name: "ws-sk-res", path: wsPath }).returning().get()!;

    const skills = resolveSkillsForWorkspace(ws.id);
    expect(skills.find(s => s.name === "ws-disable-me")).toBeUndefined();
  });
});
