/**
 * Pure prompt-building & prompt-injection helpers for `AgentSession`.
 *
 * Owns: the autonomous-agent system prompt template, plus every "inject a
 * section into the prompt" transform (past incidents, state machines,
 * workspace projects, layered AGENTS.md guidance). Extracted so `session.ts`
 * stays focused on loop/state machinery — these functions read nothing from
 * the AgentSession instance beyond the options passed in, which keeps them
 * unit-testable in isolation and makes the data flow into the system prompt
 * traceable in one file instead of scattered through a 1000-line class.
 */
import { getFlockctlHome } from "../../config/index.js";
import { searchIncidents, type IncidentSearchResult } from "../incidents/service.js";
import {
  matchRegistryForFiles,
  formatRegistryMatches,
  type RegistryLike,
} from "../state-machines/sm-registry.js";
import { loadAgentGuidance } from "./agent-guidance-loader.js";
import { extractPromptText, formatIncidentsSection } from "./helpers.js";
import type { MessageContent } from "./types.js";

/** Max incidents surfaced to the model via the system prompt. Keeps the
 *  retrieval cheap and the prompt compact even on long past-incident tables. */
export const INCIDENT_INJECTION_LIMIT = 5;

export interface WorkspaceContext {
  name: string;
  path: string;
  projects: Array<{ name: string; path: string | null; description?: string | null }>;
}

/**
 * Build the autonomous-agent ("task path") system prompt. Captures the
 * full-permissions-inside-workspace contract that task sessions run under when
 * the caller doesn't pass an explicit `systemPromptOverride`.
 */
export function buildAutonomousSystemPrompt(
  workingDir: string | undefined,
  codebaseContext: string | undefined,
): string {
  const parts: string[] = [];
  const workDir = workingDir ?? getFlockctlHome();

  parts.push(`You are an autonomous software engineering agent with FULL permissions inside the project workspace.

WORKSPACE: ${workDir}
You operate EXCLUSIVELY within this directory. All file paths are relative to it.

PERMISSIONS — you have FULL access to:
- Read any file (Read tool)
- Write/create any file (Write tool)
- Edit any file in place (Edit tool)
- Run ANY shell command — npm, git, make, curl, etc. (Bash tool)
- Search code with regex (Grep tool)
- Find files by glob pattern (Glob tool)
- List directory contents (ListDir tool)

EXECUTION RULES:
1. ACT, don't describe. Never say "you should do X" — DO IT with your tools.
2. Never ask for permission. You already have unrestricted access within the workspace.
3. Never suggest manual steps. If something needs doing, do it yourself.
4. Chain actions: read → understand → edit → verify. Always verify changes (run tests, build, lint).
5. If a command fails, read the error, diagnose, and fix it. Retry with a corrected approach.
6. Install dependencies freely (npm install, pip install, etc.).
7. Create, delete, rename files and directories as needed.
8. Run git commands freely (commit, branch, diff, log, etc.).
9. Be concise in text output. Report what you DID, not what should be done.

SECURITY BOUNDARY:
- You MUST NOT access files or directories outside ${workDir}.
- All file operations are sandboxed to the workspace. Attempts to escape will be blocked.
- Do not write secrets, tokens, or credentials into files.

FLOCKCTL SKILL DIRECTORIES (NOT ~/.claude/):
- Global skills: ~/flockctl/skills/<skill-name>/SKILL.md
- Workspace skills: <workspace-path>/.flockctl/skills/<skill-name>/SKILL.md
- Project skills: <project-path>/.flockctl/skills/<skill-name>/SKILL.md
When creating or managing skills, ALWAYS use these Flockctl paths. NEVER use ~/.claude/skills/.

FLOCKCTL MCP DIRECTORIES:
- Global MCP configs: ~/flockctl/mcp/<server-name>.json
- Workspace MCP configs: <workspace-path>/.flockctl/mcp/<server-name>.json
- Project MCP configs: <project-path>/.flockctl/mcp/<server-name>.json
The project's .mcp.json is auto-managed by the reconciler — do NOT edit it directly. Create or modify MCP configs in .flockctl/mcp/ instead.`);

  if (codebaseContext) {
    parts.push(`<codebase_context>\n${codebaseContext}\n</codebase_context>`);
  }

  return parts.join("\n\n");
}

/**
 * Retrieve past incidents relevant to the session's user prompt + codebase
 * context and append them as a compact "Past incidents" block. Swallows DB
 * errors (common in narrow unit tests) and logs a structured line so
 * retrieval hit-rate stays observable without derailing a real session.
 */
export function injectIncidents(
  systemPrompt: string,
  prompt: MessageContent,
  codebaseContext: string | undefined,
  projectId: number | null | undefined,
  logPrefix: string,
): string {
  const queryParts: string[] = [];
  // Flatten block-array prompts into plain text for the FTS query —
  // incident retrieval keys off user prose, not image bytes. The search
  // index never sees the base64 image payload either way.
  const promptText = extractPromptText(prompt);
  if (promptText) queryParts.push(promptText);
  if (codebaseContext) queryParts.push(codebaseContext);
  const query = queryParts.join("\n");
  if (!query.trim()) return systemPrompt;

  let matches: IncidentSearchResult[] = [];
  try {
    const start = Date.now();
    matches = searchIncidents(query, {
      projectId: projectId ?? null,
      limit: INCIDENT_INJECTION_LIMIT,
    });
    const elapsed = Date.now() - start;
    // Log every injection — count=0 tells us retrieval ran, no matches.
    // Surfaces both the hit rate and any FTS5 performance regression
    // (spec calls for p95 < 50ms).
    console.log(
      `[agent-session] incidents.injected count=${matches.length} ref=${logPrefix} ms=${elapsed}`,
    );
  } catch (err) {
    // DB not initialized (common in narrow unit tests) or FTS table
    // missing — neither should derail a real session.
    console.warn(
      `[agent-session] incidents.injected count=0 ref=${logPrefix} error=${(err as Error).message}`,
    );
    return systemPrompt;
  }

  if (matches.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n${formatIncidentsSection(matches)}`;
}

/**
 * Cross-reference `touchedFiles` against `smRegistry` and append a
 * `<state_machines>` block listing every entity whose `filePatterns`
 * matches at least one touched path. No-op when either input is
 * missing/empty. Pure string transform — no DB, no async.
 */
export function injectStateMachines(
  systemPrompt: string,
  touchedFiles: string[] | undefined,
  smRegistry: RegistryLike | undefined,
  logPrefix: string,
): string {
  if (!touchedFiles || touchedFiles.length === 0) return systemPrompt;
  if (!smRegistry) return systemPrompt;
  const matches = matchRegistryForFiles(touchedFiles, smRegistry);
  if (matches.length === 0) {
    console.log(`[agent-session] sm.injected count=0 ref=${logPrefix}`);
    return systemPrompt;
  }
  const section = formatRegistryMatches(matches);
  console.log(
    `[agent-session] sm.injected count=${matches.length} ref=${logPrefix} entities=${matches
      .map((m) => m.entity)
      .join(",")}`,
  );
  return `${systemPrompt}\n\n${section}`;
}

/**
 * Append a `<workspace_projects>` block listing the projects that belong to
 * the session's parent workspace, if any. Pure string transform; runs on both
 * the built task prompt and a chat's `systemPromptOverride`. When the override
 * already contains a `<workspace_projects` tag we skip to avoid piling two
 * identical blocks on top of each other — covers the chat path where
 * `resolveChatSystemPrompt` → `buildWorkspaceSystemPrompt` already rendered a
 * plain-text variant (different shape, still redundant to re-inject).
 */
export function injectWorkspaceProjects(
  systemPrompt: string,
  workspaceContext: WorkspaceContext | undefined,
): string {
  if (!workspaceContext) return systemPrompt;
  if (systemPrompt.includes("<workspace_projects")) return systemPrompt;

  const ws = workspaceContext;
  const withPath = ws.projects.filter((p) => p.path);
  const lines: string[] = [];
  lines.push(`<workspace_projects workspace="${ws.name}" path="${ws.path}">`);
  if (withPath.length > 0) {
    lines.push(
      `This workspace is a named collection of ${withPath.length} project(s). Each project is a self-contained directory — you MUST treat these project paths as the authoritative scope for any file operation:`,
    );
    for (const p of withPath) {
      const desc = p.description ? ` — ${p.description}` : "";
      lines.push(`- ${p.name} (${p.path})${desc}`);
    }
    lines.push(
      "Rules for operating across this workspace:",
      "1. Before reading, searching, or editing files, decide which project the user's request belongs to and operate inside that project's path.",
      "2. Do NOT run Grep/Glob/ListDir against the workspace root when the request concerns one project — scope to that project's path instead.",
      "3. Only cross project boundaries when the request explicitly spans multiple projects.",
      "4. Files and directories inside the workspace root that do not belong to any listed project are NOT part of this workspace — ignore them unless the user points at them directly.",
    );
  } else {
    lines.push(
      "This workspace currently has no projects with known paths. Ask the user which subdirectory owns the request before making broad changes.",
    );
  }
  lines.push("</workspace_projects>");
  return `${systemPrompt}\n\n${lines.join("\n")}`;
}

/**
 * Append merged layered AGENTS.md guidance (user → workspace → project) to
 * the system prompt. Closes the gap where the Claude Agent SDK, unlike the
 * interactive `claude` CLI, does not pick up AGENTS.md / CLAUDE.md from disk
 * on its own.
 *
 * The explicit equality guards keep the loader from reading the same
 * `<flockctlHome>/AGENTS.md` as both `user` and `project-public` when a
 * session runs inside flockctl home itself (e.g. bootstrap/task sessions
 * without a project scope).
 *
 * Fail-open: if the loader throws (I/O error, programmer bug), log and return
 * the unmodified prompt. Chats must not be blocked by a guidance-read failure.
 */
export async function injectAgentGuidance(
  systemPrompt: string,
  workingDir: string | undefined,
  workspacePath: string | undefined | null,
  logPrefix: string,
): Promise<string> {
  try {
    const flockctlHome = getFlockctlHome();
    const wsPath = workspacePath ?? null;
    const projPath = workingDir ?? null;
    const { mergedWithHeaders, layers, truncatedLayers } = await loadAgentGuidance({
      flockctlHome,
      workspacePath: wsPath && wsPath !== flockctlHome ? wsPath : null,
      projectPath:
        projPath && projPath !== flockctlHome && projPath !== wsPath
          ? projPath
          : null,
    });
    console.log(
      `[agent-session] guidance.injected layers=${layers.length} ref=${logPrefix} total_bytes=${layers.reduce((s, l) => s + l.bytes, 0)}${truncatedLayers.length > 0 ? ` truncated=${truncatedLayers.join(",")}` : ""}`,
    );
    if (!mergedWithHeaders) return systemPrompt;
    return `${systemPrompt}\n\n${mergedWithHeaders}`;
  } catch (err) {
    /* v8 ignore next 3 — defensive: loader is pure/sync, only a programmer
       bug can surface here; keep the chat running on the unmodified prompt. */
    console.warn(
      `[agent-session] guidance.injected count=0 ref=${logPrefix} error=${(err as Error).message}`,
    );
    return systemPrompt;
  }
}
