import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportAction =
  | { kind: "adoptAgentsMd" }
  | { kind: "mergeClaudeMd" }
  | { kind: "importMcpJson" }
  | { kind: "importClaudeSkill"; name: string };

export type ClaudeMdKind =
  | "none"
  | "file"
  | "symlink-to-agents"
  | "symlink-other";

export interface ProjectScan {
  path: string;
  exists: boolean;
  writable: boolean;
  git: { present: boolean; originUrl: string | null };
  alreadyManaged: boolean;
  conflicts: {
    agentsMd: { present: boolean; bytes: number; isManaged: boolean };
    claudeMd: { present: boolean; kind: ClaudeMdKind; bytes: number; sameAsAgents: boolean };
    mcpJson: { present: boolean; servers: string[]; parseError: string | null };
    claudeSkills: Array<{ name: string; isSymlink: boolean }>;
    claudeAgents: string[];
    claudeCommands: string[];
    flockctlAgentsPresent: boolean;
  };
  proposedActions: ImportAction[];
}

export interface ApplyImportOptions {
  backupTimestamp?: string;
}

// ---------------------------------------------------------------------------
// Scan: pure read-only detection of what an import would touch.
// ---------------------------------------------------------------------------

export function scanProjectPath(projectPath: string): ProjectScan {
  const exists = existsSync(projectPath);
  const writable = exists ? isWritable(projectPath) : isWritable(parentDir(projectPath));
  const git = detectGit(projectPath);
  const alreadyManaged = exists && existsSync(join(projectPath, ".flockctl"));

  const conflicts: ProjectScan["conflicts"] = {
    agentsMd: detectAgentsMd(projectPath),
    claudeMd: detectClaudeMd(projectPath),
    mcpJson: detectMcpJson(projectPath),
    claudeSkills: detectClaudeSkills(projectPath),
    claudeAgents: detectClaudeEntries(projectPath, "agents", /\.md$/),
    claudeCommands: detectClaudeEntries(projectPath, "commands", /\.md$/),
    flockctlAgentsPresent: existsSync(join(projectPath, ".flockctl", "AGENTS.md")),
  };

  const proposedActions = deriveProposedActions(conflicts);
  return { path: projectPath, exists, writable, git, alreadyManaged, conflicts, proposedActions };
}

function deriveProposedActions(conflicts: ProjectScan["conflicts"]): ImportAction[] {
  const actions: ImportAction[] = [];

  if (conflicts.agentsMd.present && !conflicts.agentsMd.isManaged) {
    actions.push({ kind: "adoptAgentsMd" });
  }

  // Only merge if CLAUDE.md is a regular file with content that differs from AGENTS.md.
  // A symlink to AGENTS.md is already our desired state; a broken/foreign symlink we leave alone.
  if (
    conflicts.claudeMd.present &&
    conflicts.claudeMd.kind === "file" &&
    !conflicts.claudeMd.sameAsAgents
  ) {
    actions.push({ kind: "mergeClaudeMd" });
  }

  if (conflicts.mcpJson.present && conflicts.mcpJson.servers.length > 0) {
    actions.push({ kind: "importMcpJson" });
  }

  for (const s of conflicts.claudeSkills) {
    if (!s.isSymlink) actions.push({ kind: "importClaudeSkill", name: s.name });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Apply: execute a subset of actions. Caller is responsible for ordering
// (POST /projects passes the exact list the user approved).
// ---------------------------------------------------------------------------

export function applyImportActions(
  projectPath: string,
  actions: ImportAction[],
  opts: ApplyImportOptions = {},
): void {
  if (actions.length === 0) return;
  if (!existsSync(projectPath)) {
    throw new Error(`Cannot import: path does not exist: ${projectPath}`);
  }

  const ts = opts.backupTimestamp ?? makeTimestamp();
  const backupDir = join(projectPath, ".flockctl", "import-backup", ts);

  for (const action of actions) {
    switch (action.kind) {
      case "adoptAgentsMd":
        applyAdoptAgentsMd(projectPath, backupDir);
        break;
      case "mergeClaudeMd":
        applyMergeClaudeMd(projectPath, backupDir);
        break;
      case "importMcpJson":
        applyImportMcpJson(projectPath, backupDir);
        break;
      case "importClaudeSkill":
        applyImportClaudeSkill(projectPath, backupDir, action.name);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-action implementations
// ---------------------------------------------------------------------------

function applyAdoptAgentsMd(projectPath: string, backupDir: string): void {
  const srcPath = join(projectPath, "AGENTS.md");
  if (!existsSync(srcPath)) return;

  const original = safeReadText(srcPath);
  /* v8 ignore next — defensive: existsSync(srcPath) passed above so
   * safeReadText only returns null on a rare read race; not reachable via
   * deterministic tests. */
  if (original === null) return;

  backupFile(srcPath, backupDir, "AGENTS.md");

  const flockctlDir = join(projectPath, ".flockctl");
  mkdirSync(flockctlDir, { recursive: true });
  const destPath = join(flockctlDir, "AGENTS.md");

  // If .flockctl/AGENTS.md already exists with content, append the root source
  // below it under a BEGIN/END block — don't silently overwrite.
  if (existsSync(destPath)) {
    /* v8 ignore next — defensive: existsSync passed, so safeReadText returning
     * null is a read-race edge, not reachable via our tests. */
    const existing = safeReadText(destPath) ?? "";
    const combined = appendBlock(existing, "imported root AGENTS.md", original.trimEnd());
    writeAtomic(destPath, combined);
  } else {
    writeAtomic(destPath, original);
  }

  unlinkSync(srcPath);
}

function applyMergeClaudeMd(projectPath: string, backupDir: string): void {
  const srcPath = join(projectPath, "CLAUDE.md");
  if (!existsSync(srcPath)) return;

  // Safety: only merge regular files. Symlinks are left alone.
  const lst = lstatSync(srcPath);
  if (lst.isSymbolicLink()) return;

  const claudeContent = safeReadText(srcPath);
  /* v8 ignore next — defensive: existsSync passed, read-race edge only. */
  if (claudeContent === null) return;

  backupFile(srcPath, backupDir, "CLAUDE.md");

  const flockctlDir = join(projectPath, ".flockctl");
  mkdirSync(flockctlDir, { recursive: true });
  const destPath = join(flockctlDir, "AGENTS.md");

  /* v8 ignore next — defensive: when existsSync(destPath) is true,
   * safeReadText returning null is a read-race edge, not testable. */
  const existing = existsSync(destPath) ? safeReadText(destPath) ?? "" : "";
  const combined = appendBlock(existing, "imported CLAUDE.md", claudeContent.trimEnd());
  writeAtomic(destPath, combined);

  unlinkSync(srcPath);
}

function applyImportMcpJson(projectPath: string, backupDir: string): void {
  const srcPath = join(projectPath, ".mcp.json");
  if (!existsSync(srcPath)) return;

  let parsed: unknown;
  try {
    /* v8 ignore next — defensive: existsSync passed so safeReadText returning
     * null is a read-race edge; `?? ""` is belt-and-braces. */
    parsed = JSON.parse(safeReadText(srcPath) ?? "");
  } catch {
    // Malformed — skip import, leave file alone with a warning for the user.
    console.warn(`[import] failed to parse .mcp.json at ${srcPath}; leaving intact`);
    return;
  }

  const servers = extractMcpServers(parsed);
  if (Object.keys(servers).length === 0) return;

  backupFile(srcPath, backupDir, ".mcp.json");

  const projectMcpDir = join(projectPath, ".flockctl", "mcp");
  mkdirSync(projectMcpDir, { recursive: true });

  for (const [name, config] of Object.entries(servers)) {
    const filePath = join(projectMcpDir, `${name}.json`);
    // If a per-server file already exists at project level, skip (user/workspace
    // already has it configured — don't clobber their edit).
    if (existsSync(filePath)) continue;
    writeAtomic(filePath, JSON.stringify(config, null, 2) + "\n");
  }

  unlinkSync(srcPath);
}

function applyImportClaudeSkill(projectPath: string, backupDir: string, name: string): void {
  if (!isSafeName(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }

  const srcDir = join(projectPath, ".claude", "skills", name);
  if (!existsSync(srcDir)) return;

  const lst = lstatSync(srcDir);
  if (lst.isSymbolicLink()) return; // flockctl-managed symlink, skip
  if (!lst.isDirectory()) return;
  if (!existsSync(join(srcDir, "SKILL.md"))) return;

  const destRoot = join(projectPath, ".flockctl", "skills");
  mkdirSync(destRoot, { recursive: true });
  const destDir = join(destRoot, name);
  // If a project-level skill with this name already exists, don't overwrite.
  if (existsSync(destDir)) return;

  backupDirSnapshot(srcDir, backupDir, join(".claude/skills", name));

  // Atomic move within same FS; fall back to copy+remove across FS.
  try {
    renameSync(srcDir, destDir);
  } catch {
    cpSync(srcDir, destDir, { recursive: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

function detectAgentsMd(projectPath: string): ProjectScan["conflicts"]["agentsMd"] {
  const p = join(projectPath, "AGENTS.md");
  if (!existsSync(p)) return { present: false, bytes: 0, isManaged: false };
  const text = safeReadText(p);
  /* v8 ignore next — defensive: existsSync(p) passed, read-race edge only. */
  if (text === null) return { present: true, bytes: 0, isManaged: false };
  // `isManaged` is a historical field from the retired reconciler. It's kept
  // in the response shape because the UI types still reference it, but now
  // always reports `false` — there is no longer a managed/derived AGENTS.md.
  return {
    present: true,
    bytes: Buffer.byteLength(text, "utf-8"),
    isManaged: false,
  };
}

function detectClaudeMd(projectPath: string): ProjectScan["conflicts"]["claudeMd"] {
  const p = join(projectPath, "CLAUDE.md");
  let lst;
  try {
    lst = lstatSync(p);
  } catch {
    return { present: false, kind: "none", bytes: 0, sameAsAgents: false };
  }

  if (lst.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(p);
    } catch {
      return { present: true, kind: "symlink-other", bytes: 0, sameAsAgents: false };
    }
    return {
      present: true,
      kind: target === "AGENTS.md" ? "symlink-to-agents" : "symlink-other",
      bytes: 0,
      sameAsAgents: target === "AGENTS.md",
    };
  }

  if (!lst.isFile()) {
    return { present: false, kind: "none", bytes: 0, sameAsAgents: false };
  }

  /* v8 ignore next — defensive: lstat succeeded and isFile() is true, so
   * safeReadText returning null is a read-race edge. */
  const claude = safeReadText(p) ?? "";
  const agents = safeReadText(join(projectPath, "AGENTS.md"));
  return {
    present: true,
    kind: "file",
    bytes: Buffer.byteLength(claude, "utf-8"),
    sameAsAgents: agents !== null && agents === claude,
  };
}

function detectMcpJson(projectPath: string): ProjectScan["conflicts"]["mcpJson"] {
  const p = join(projectPath, ".mcp.json");
  if (!existsSync(p)) return { present: false, servers: [], parseError: null };
  const text = safeReadText(p);
  /* v8 ignore next — defensive: existsSync(p) passed, read-race edge only. */
  if (text === null) return { present: true, servers: [], parseError: "unreadable" };
  try {
    const parsed = JSON.parse(text);
    const servers = extractMcpServers(parsed);
    return { present: true, servers: Object.keys(servers).sort(), parseError: null };
  } catch (err) {
    /* v8 ignore next — defensive: JSON.parse always throws a SyntaxError,
     * so the `String(err)` RHS is unreachable. */
    return { present: true, servers: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

function detectClaudeSkills(projectPath: string): Array<{ name: string; isSymlink: boolean }> {
  const dir = join(projectPath, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; isSymlink: boolean }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      out.push({ name: e.name, isSymlink: true });
      continue;
    }
    if (!lst.isDirectory()) continue;
    if (!existsSync(join(full, "SKILL.md"))) continue;
    out.push({ name: e.name, isSymlink: false });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function detectClaudeEntries(projectPath: string, subdir: string, pattern: RegExp): string[] {
  const dir = join(projectPath, ".claude", subdir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => pattern.test(n))
      .sort();
  } catch {
    return [];
  }
}

function detectGit(projectPath: string): { present: boolean; originUrl: string | null } {
  if (!existsSync(projectPath)) return { present: false, originUrl: null };
  if (!existsSync(join(projectPath, ".git"))) return { present: false, originUrl: null };
  let originUrl: string | null = null;
  try {
    originUrl = execSync("git remote get-url origin", {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim() || null;
  } catch {
    originUrl = null;
  }
  return { present: true, originUrl };
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function safeReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeAtomic(finalPath: string, content: string): void {
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

function backupFile(srcPath: string, backupDir: string, relName: string): void {
  mkdirSync(backupDir, { recursive: true });
  const destPath = join(backupDir, relName);
  mkdirSync(parentDir(destPath), { recursive: true });
  // cpSync handles existing dest by overwriting — backups are keyed by timestamp
  // so collision only happens on repeated applies with the same timestamp.
  cpSync(srcPath, destPath);
}

function backupDirSnapshot(srcDir: string, backupDir: string, relPath: string): void {
  const destPath = join(backupDir, relPath);
  mkdirSync(parentDir(destPath), { recursive: true });
  cpSync(srcDir, destPath, { recursive: true });
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  /* v8 ignore next — defensive: every call site passes an absolute path,
   * so `idx === -1` (no slash at all) is not reachable in practice. */
  return idx === -1 ? "." : p.slice(0, idx);
}

function isWritable(path: string): boolean {
  try {
    // Cheap probe — stat reports permission via mode bits, but those are
    // unreliable for cross-user scenarios. We treat stat-success as good-enough
    // and let the real write surface any error to the user.
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function makeTimestamp(): string {
  // ISO string with ':' replaced so it's safe on every FS.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isSafeName(name: string): boolean {
  // Prevent path traversal in skill names.
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

function extractMcpServers(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const servers = (root.mcpServers ?? root) as unknown;
  if (!servers || typeof servers !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(servers as Record<string, unknown>)) {
    if (v && typeof v === "object") out[k] = v;
  }
  return out;
}

function appendBlock(existing: string, label: string, body: string): string {
  const block = `<!-- BEGIN ${label} -->\n\n${body}\n\n<!-- END ${label} -->\n`;
  if (!existing.trim()) return block;
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}
