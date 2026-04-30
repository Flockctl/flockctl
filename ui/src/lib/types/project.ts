import type { PermissionMode } from "./permission";
import type { MilestoneTree } from "./plan";

// --- Project ---

export interface Project {
  id: string;
  name: string;
  description: string | null;
  path: string | null;
  workspace_id: number | null;
  repo_url: string | null;
  provider_fallback_chain: string[] | null;
  allowed_key_ids: number[] | null;
  // ─── Gitignore toggles (backend migration 0038) ───
  // Opt-in flags controlling what the server writes into the auto-managed
  // block of <project>/.git/info/exclude. API-level defaults applied by
  // POST /projects: (true, true, false) — see DEFAULT_GITIGNORE_TOGGLES.
  gitignore_flockctl: boolean;
  gitignore_todo: boolean;
  gitignore_agents_md: boolean;
  // ─── Project `.claude/skills/` opt-in (backend migration 0045) ───
  // When `true`, `<project>/.claude/skills/<name>/SKILL.md` directories are
  // honoured as locked, non-disableable skill sources. Default `false`.
  use_project_claude_skills: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Config stored in <project>/.flockctl/config.yaml — portable across
 * machines via git. Fetched/updated via /projects/:id/config.
 */
export interface ProjectConfig {
  model?: string | null;
  planningModel?: string | null;
  allowedProviders?: string[] | null;
  baseBranch?: string | null;
  testCommand?: string | null;
  defaultTimeout?: number | null;
  maxConcurrentTasks?: number | null;
  requiresApproval?: boolean | null;
  budgetDailyUsd?: number | null;
  env?: Record<string, string> | null;
  permissionMode?: PermissionMode | null;
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}

export interface ProjectCreate {
  name: string;
  description?: string | null;
  path?: string | null;
  workspace_id?: number | null;
  repo_url?: string | null;
  baseBranch?: string;
  allowedProviders?: string[] | null;
  provider_fallback_chain?: string[] | null;
  model?: string | null;
  permission_mode?: PermissionMode | null;
  importActions?: ImportAction[];
  /**
   * IDs of active AI-provider keys this project is allowed to use.
   * Required at creation time — must contain at least one active key.
   * See src/routes/_allowed-keys.ts for the exact backend contract.
   */
  allowed_key_ids: number[];
  // ─── Gitignore toggles — optional on create. Server applies defaults
  // (true, true, false) when omitted; see DEFAULT_GITIGNORE_TOGGLES. ───
  gitignore_flockctl?: boolean;
  gitignore_todo?: boolean;
  gitignore_agents_md?: boolean;
  // ─── Project `.claude/skills/` opt-in — defaults to false server-side ───
  use_project_claude_skills?: boolean;
}

// --- Project import (scan + adopt existing .claude/AGENTS.md/.mcp.json) ---

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

export interface ProjectUpdate {
  name?: string | null;
  description?: string | null;
  repoUrl?: string | null;
  provider_fallback_chain?: string[] | null;
  /**
   * Updated allow-list. When present, must be a non-empty array of
   * active AI-provider key IDs — the server rejects `null` / `[]` with
   * 422 to prevent the create-time mandatory-keys gate from being
   * circumvented. Omit the field to leave the existing allow-list alone.
   */
  allowed_key_ids?: number[];
  // Config fields (relayed into .flockctl/config.yaml server-side)
  baseBranch?: string | null;
  allowedProviders?: string[] | null;
  model?: string | null;
  planningModel?: string | null;
  testCommand?: string | null;
  maxConcurrentTasks?: number | null;
  budgetDailyUsd?: number | null;
  requiresApproval?: boolean;
  envVars?: Record<string, string> | null;
  permission_mode?: PermissionMode | null;
  // ─── Gitignore toggles — omitted fields are left unchanged on the server ───
  gitignore_flockctl?: boolean;
  gitignore_todo?: boolean;
  gitignore_agents_md?: boolean;
  // ─── Project `.claude/skills/` opt-in — omitted leaves the row unchanged ───
  use_project_claude_skills?: boolean;
}

export interface ProjectTree {
  milestones: MilestoneTree[];
}

// --- Git Pull (POST /projects/:id/git-pull) ---

/**
 * Reason codes for a failed `git pull`. Mirrors the server-side
 * `GitPullReason` union in `src/services/git-operations.ts`. The UI
 * switches on this to choose between toast / modal copy and to decide
 * whether to invalidate the project query cache.
 *
 * - `not_a_git_repo` — the project's path has no `.git/` directory.
 * - `no_upstream`    — current branch has no `@{u}` upstream, or
 *                      the repo is in detached-HEAD state.
 * - `dirty_working_tree` — there are uncommitted changes; we refuse
 *                      to pull rather than risk a surprise merge.
 * - `non_fast_forward`  — local and remote have diverged; `--ff-only`
 *                      refuses to merge. The user has to resolve in a
 *                      terminal (rebase / merge / reset).
 * - `auth_failed`    — SSH key rejected, HTTPS creds missing, or 403.
 * - `network_error`  — DNS / connection refused / timeout.
 * - `unknown`        — anything we didn't recognise; surface raw stderr.
 */
export type GitPullReason =
  | "not_a_git_repo"
  | "no_upstream"
  | "dirty_working_tree"
  | "non_fast_forward"
  | "auth_failed"
  | "network_error"
  | "unknown";

export interface GitPullSuccess {
  ok: true;
  already_up_to_date: boolean;
  before_sha: string;
  after_sha: string;
  branch: string;
  commits_pulled: number;
  files_changed: number;
  summary: string;
}

export interface GitPullFailure {
  ok: false;
  reason: GitPullReason;
  message: string;
  stderr?: string;
}

export type GitPullResult = GitPullSuccess | GitPullFailure;

// --- Project Allowed Keys (resolved with workspace → project inheritance) ---

/**
 * Result of `GET /projects/:id/allowed-keys`. Encodes both the effective
 * allow-list and where it was inherited from so the UI can explain to the
 * user why a key is or isn't available.
 *
 * `allowedKeyIds === null` means no restriction is configured at any level —
 * any active key may be used.
 */
export interface ProjectAllowedKeys {
  allowedKeyIds: number[] | null;
  source: "project" | "workspace" | "none";
}

// --- Project Stats ---

export interface ProjectStats {
  tasks: {
    total: number;
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    done: number;
    failed: number;
    timed_out: number;
    cancelled: number;
  };
  avg_task_duration_seconds: number | null;
  milestones: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  slices: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  usage: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
}

// --- Project Execution Overview ---

export interface OverviewTaskWave {
  waveIndex: number;
  task_ids: string[];
}

export interface OverviewTask {
  id: string;
  slice_id: string;
  title: string;
  status: string;
  depends: string[] | null;
  order_index: number;
  verification_passed: boolean | null;
}

export interface OverviewSlice {
  id: string;
  milestone_id: string;
  title: string;
  status: string;
  risk: string;
  depends: string[] | null;
  goal: string | null;
  order_index: number;
  tasks: OverviewTask[];
  task_waves: OverviewTaskWave[];
}

export interface OverviewWave {
  waveIndex: number;
  slugs: string[];
  slices: OverviewSlice[];
}

export interface OverviewMilestone {
  milestone_id: string;
  title: string;
  status: string;
  waves: OverviewWave[];
  parallelism_factor: number;
  total_slices: number;
  completed_slices: number;
  active_slice_ids: string[];
}

export interface ProjectExecutionOverviewResponse {
  milestones: OverviewMilestone[];
}
