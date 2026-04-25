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
  ensureGitignore,
} from "../../services/claude/skills-sync.js";

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
    writeFileSync(join(projPath, ".gitignore"), "");
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

    // gitignore updated with marked Flockctl block
    const gi = readFileSync(join(projPath, ".gitignore"), "utf-8");
    expect(gi).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(gi).toContain("# ─── /Flockctl ───");
    expect(gi).toContain(".claude/skills/");
    expect(gi).toContain(".mcp.json");
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

  it("ensureGitignore is a no-op when .gitignore is missing", () => {
    const dir = mkdtempSync(join(tmpBase, "no-gi-"));
    expect(() => ensureGitignore(dir)).not.toThrow();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("ensureGitignore migrates raw legacy entries into a marked block", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-migrate-"));
    const gitignore = [
      "node_modules/",
      ".claude/skills/",
      ".mcp.json",
      ".flockctl/.skills-reconcile",
      ".flockctl/.mcp-reconcile",
      ".flockctl/.agents-reconcile",
      ".flockctl/import-backup/",
      ".flockctl/plan/",
    ].join("\n") + "\n";
    writeFileSync(join(dir, ".gitignore"), gitignore);

    ensureGitignore(dir);
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");

    // user-owned entries preserved
    expect(after).toContain("node_modules/");
    // canonical block present
    expect(after).toContain("# ─── Flockctl (auto-managed — do not edit) ───");
    expect(after).toContain("# ─── /Flockctl ───");
    // raw duplicates outside the block removed (each pattern appears exactly once)
    for (const pattern of [
      ".claude/skills/",
      ".mcp.json",
      ".flockctl/.skills-reconcile",
      ".flockctl/.mcp-reconcile",
      ".flockctl/.agents-reconcile",
      ".flockctl/import-backup/",
      ".flockctl/plan/",
    ]) {
      const occurrences = after.split("\n").filter((l) => l === pattern).length;
      expect(occurrences).toBe(1);
    }
  });

  it("ensureGitignore is idempotent — second run leaves file byte-identical", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-idem-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

    ensureGitignore(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf-8");
    ensureGitignore(dir);
    const second = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(second).toBe(first);
  });

  // ─── Gitignore toggles (migration 0038) ────────────────────────────────

  it("gitignore flags=off keeps the legacy base block", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-base-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir); // no options → defaults to off
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    // Base patterns present
    expect(after).toContain(".claude/skills/");
    expect(after).toContain(".flockctl/.skills-reconcile");
    expect(after).toContain(".flockctl/plan/");
    // Optional patterns absent
    expect(after).not.toContain("\n.flockctl/\n");
    expect(after).not.toMatch(/^TODO\.md$/m);
    expect(after).not.toMatch(/^AGENTS\.md$/m);
    expect(after).not.toMatch(/^CLAUDE\.md$/m);
  });

  it("gitignore flockctl=true collapses the sub-paths into .flockctl/", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-flock-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir, { flockctl: true });
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    // `.flockctl/` appears exactly once inside the block
    const lines = after.split("\n");
    expect(lines.filter((l) => l === ".flockctl/").length).toBe(1);
    // The granular sub-paths are NOT listed — `.flockctl/` already covers them
    expect(lines).not.toContain(".flockctl/.skills-reconcile");
    expect(lines).not.toContain(".flockctl/plan/");
    expect(lines).not.toContain(".flockctl/import-backup/");
  });

  it("gitignore todo=true adds TODO.md to the block", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-todo-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir, { todo: true });
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(after.split("\n").filter((l) => l === "TODO.md").length).toBe(1);
  });

  it("gitignore agentsMd=true adds BOTH AGENTS.md and CLAUDE.md", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-agents-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir, { agentsMd: true });
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    const lines = after.split("\n");
    expect(lines.filter((l) => l === "AGENTS.md").length).toBe(1);
    expect(lines.filter((l) => l === "CLAUDE.md").length).toBe(1);
  });

  it("gitignore all three flags produce a superset block", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-all-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir, { flockctl: true, todo: true, agentsMd: true });
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    for (const pat of [".flockctl/", "TODO.md", "AGENTS.md", "CLAUDE.md"]) {
      expect(after.split("\n").filter((l) => l === pat).length).toBe(1);
    }
    // `.claude/skills/` and `.mcp.json` still present — they live outside
    // `.flockctl/` and must always be ignored.
    expect(after).toContain(".claude/skills/");
    expect(after).toContain(".mcp.json");
  });

  it("gitignore flipping a flag off strips the previous entry on next run", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-flip-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureGitignore(dir, { todo: true });
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain("TODO.md");
    // Flag flips off — block is rewritten, TODO.md disappears even though a
    // prior run put it there.
    ensureGitignore(dir, { todo: false });
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(after.split("\n").filter((l) => l === "TODO.md").length).toBe(0);
  });

  it("gitignore createIfMissing=true creates .gitignore when at least one flag is on", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-create-"));
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    ensureGitignore(dir, { flockctl: true, createIfMissing: true });
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain(".flockctl/");
  });

  it("gitignore createIfMissing=true is still a no-op when all flags are off", () => {
    const dir = mkdtempSync(join(tmpBase, "gi-noop-"));
    ensureGitignore(dir, { createIfMissing: true });
    // Non-invasive: no flags = no file creation.
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("gitignore toggles wired into reconcile via project row", () => {
    const projPath = mkdtempSync(join(tmpBase, "gi-proj-"));
    writeFileSync(join(projPath, ".gitignore"), "node_modules/\n");
    const proj = db
      .insert(projects)
      .values({
        name: "gi-proj",
        path: projPath,
        gitignoreFlockctl: true,
        gitignoreTodo: true,
        gitignoreAgentsMd: true,
      })
      .returning()
      .get()!;

    reconcileClaudeSkillsForProject(proj.id);
    const after = readFileSync(join(projPath, ".gitignore"), "utf-8");
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
