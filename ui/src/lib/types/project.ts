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

// --- Git Status (GET /projects/:id/git-status) ---

/**
 * Single porcelain entry from `git status` — see `runGitStatus` in
 * `src/services/git-operations.ts`. `index` and `worktree` are the two
 * single-character status codes from `git status --porcelain=v1`'s `XY`
 * pair; the UI renders them as the small leading badge in the Commit
 * dialog's stage-selection list.
 */
export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
}

export type GitStatusReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface GitStatusSuccess {
  ok: true;
  branch?: string;
  detached?: boolean;
  entries: GitStatusEntry[];
  reason: "ok";
}

export interface GitStatusFailure {
  ok: false;
  reason: GitStatusReason;
  message?: string;
}

export type GitStatusResult = GitStatusSuccess | GitStatusFailure;

// --- Git Commit (POST /projects/:id/git-commit) ---

/**
 * Reason codes for `git commit`. Mirrors the server-side `GitCommitReason`
 * union in `src/services/git-operations.ts`. The success path always sets
 * `reason: "ok"`; failure-path values let the UI key copy by failure mode.
 *
 * - `ok`             — commit landed; SHA + file count are populated.
 * - `empty_message`  — commit message was empty / whitespace-only.
 * - `detached_head`  — committing here would create an orphan commit.
 * - `unknown_path`   — a `paths` entry was not in `git status`.
 * - `empty_index`    — nothing to commit after staging.
 * - `auth_failed`    — git rejected credentials.
 * - `timeout`        — wall-clock budget exceeded.
 * - `not_a_repo`     — path exists but has no `.git/`.
 * - `path_missing`   — the project's path is gone from disk.
 * - `unknown`        — anything else; raw stderr is preserved verbatim.
 */
export type GitCommitReason =
  | "ok"
  | "empty_message"
  | "detached_head"
  | "unknown_path"
  | "empty_index"
  | "auth_failed"
  | "timeout"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface GitCommitSuccess {
  ok: true;
  sha: string;
  files_committed: number;
  reason: "ok";
}

export interface GitCommitFailure {
  ok: false;
  reason: GitCommitReason;
  message?: string;
  stderr?: string;
}

export type GitCommitResult = GitCommitSuccess | GitCommitFailure;

/**
 * Request body for `POST /projects/:id/git-commit`. Mirrors the
 * server-side `gitCommitBodySchema` (`src/routes/projects.ts`):
 * message is required (1-4096 bytes); paths are optional (≤ 500 entries,
 * omit for `git add -A`).
 */
export interface GitCommitBody {
  message: string;
  paths?: string[];
}

// --- Git Push (POST /projects/:id/git-push) ---

/**
 * Reason codes for `git push`. Mirrors the server-side `GitPushReason`
 * union in `src/services/git-operations.ts`.
 *
 * - `ok`                       — push completed (see `updated` to tell
 *                                if the remote ref moved).
 * - `auth_failed`              — credentials rejected (SSH key / HTTPS).
 * - `rejected_non_fast_forward`— remote has commits we don't; needs pull
 *                                or `force: true`.
 * - `no_upstream`              — branch has no `@{u}` and `setUpstream`
 *                                was false.
 * - `detached_head`            — no branch to push.
 * - `protected_branch`         — refused to force-push to main/master.
 * - `timeout`                  — wall-clock budget exceeded.
 * - `not_a_repo`               — path exists but has no `.git/`.
 * - `path_missing`             — the project's path is gone from disk.
 * - `unknown`                  — anything else; raw stderr preserved.
 */
export type GitPushReason =
  | "ok"
  | "auth_failed"
  | "rejected_non_fast_forward"
  | "no_upstream"
  | "detached_head"
  | "protected_branch"
  | "timeout"
  | "not_a_repo"
  | "path_missing"
  | "unknown";

export interface GitPushSuccess {
  ok: true;
  branch: string;
  remote: string;
  /**
   * `true` when the push moved the remote ref; `false` when the remote
   * was already up to date (`Everything up-to-date`).
   */
  updated: boolean;
  reason: "ok";
}

export interface GitPushFailure {
  ok: false;
  /** Resolved when pre-flight got far enough to read it; absent otherwise. */
  branch?: string;
  remote?: string;
  reason: GitPushReason;
  message?: string;
  stderr?: string;
}

export type GitPushResult = GitPushSuccess | GitPushFailure;

/**
 * Request body for `POST /projects/:id/git-push`. Mirrors the
 * server-side `gitPushBodySchema` (`src/routes/projects.ts`) — `.strict()`
 * on the backend rejects unknown fields, so do NOT add new keys here
 * without updating the route schema in lock-step.
 *
 * All fields optional — empty body means `{ remote: 'origin',
 * setUpstream: false, force: false }`. `force: true` translates to
 * `--force-with-lease` server-side (NEVER raw `--force`) and is refused
 * outright on protected branches (main / master).
 */
export interface GitPushBody {
  remote?: string;
  set_upstream?: boolean;
  force?: boolean;
}

// --- Git Log (GET /projects/:id/git-log, GET /workspaces/:id/git-log) ---

/**
 * Reason codes for `git log`. Mirrors the server-side `GitLogReason` union
 * in `src/services/git-operations.ts`.
 *
 * - `ok`            — happy path; `commits` populated (may be empty for an
 *                     empty repo).
 * - `bad_revision`  — caller-supplied cursor / branch is malformed or refers
 *                     to a non-existent ref.
 * - `not_a_repo`    — path exists but has no `.git/`.
 * - `path_missing`  — the entity's path is gone from disk.
 * - `timeout`       — wall-clock budget exceeded.
 * - `unknown`       — anything else; raw stderr preserved verbatim.
 */
export type GitLogReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "timeout"
  | "unknown";

/**
 * Single commit row. Mirrors `GitLogCommit` in
 * `src/services/git-operations.ts`. After `apiFetch`'s camelCase →
 * snake_case key conversion the server's `shortSha` lands as `short_sha`,
 * so the field names on the wire and in this interface match.
 */
export interface GitLogCommit {
  /** Full 40-char commit SHA (lowercase hex). */
  sha: string;
  /** First 7 chars of {@link sha}, pre-computed by the server. */
  short_sha: string;
  /** Author name (`%an`). */
  author: string;
  /** Author email (`%ae`). */
  email: string;
  /** Author timestamp as unix-epoch seconds (`%at`). */
  ts: number;
  /** Subject line (first line of the commit message; `%s`). */
  subject: string;
  /** Parent SHAs (empty for the root commit; ≥2 for a merge). */
  parents: string[];
}

export interface GitLogSuccess {
  ok: true;
  commits: GitLogCommit[];
  /** Next page's starting SHA, or `null` when nothing remains to walk. */
  next_cursor: string | null;
  reason: "ok";
}

export interface GitLogFailure {
  ok: false;
  reason: GitLogReason;
  message?: string;
  stderr?: string;
}

export type GitLogResult = GitLogSuccess | GitLogFailure;

/**
 * Single page of commit history. The hook layer maps this 1:1 from a
 * {@link GitLogSuccess} response — failures throw out of the query.
 */
export interface GitLogPage {
  commits: GitLogCommit[];
  next_cursor: string | null;
}

// --- git-show ------------------------------------------------------------
//
// Mirrors the response shape of `GET /:scope/:id/git-show?sha=<sha>`,
// backed by `runGitShow` in `src/services/git-operations.ts`. After
// `apiFetch`'s camelCase → snake_case key conversion the server's
// `oldPath` lands as `old_path`.

export type GitShowReason =
  | "ok"
  | "not_a_repo"
  | "path_missing"
  | "bad_revision"
  | "timeout"
  | "unknown";

/**
 * Single file row in a commit's diff index. Status enum mirrors the
 * `--name-status` codes — `M`/`A`/`D`/`R`/`C` plus the rare type-change
 * (`T`) / unmerged (`U`) variants. `added` / `removed` are zero for
 * binary files (where git emits `-` `-` in `--numstat`).
 */
export interface GitShowFile {
  /** New path. For renames / copies, the destination side. */
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U";
  added: number;
  removed: number;
  /** Old path on a rename / copy; absent otherwise. */
  old_path?: string;
}

export interface GitShowCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Author timestamp as unix-epoch seconds (`%at`). */
  ts: number;
  /** Subject line (`%s`). One line. */
  message: string;
}

export interface GitShowSuccess {
  ok: true;
  commit: GitShowCommit;
  files: GitShowFile[];
  reason: "ok";
}

export interface GitShowFailure {
  ok: false;
  reason: GitShowReason;
  message?: string;
  stderr?: string;
}

export type GitShowResult = GitShowSuccess | GitShowFailure;

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
    /**
     * @deprecated Always 0 — backend FSM never produces an `assigned` row,
     * but `GET /projects/:id/stats` initialises this bucket for backward
     * compatibility with older clients. The TaskStatus enum no longer
     * lists `assigned`, so this field is purely wire-format glue.
     */
    assigned: number;
    running: number;
    /** Suspend state — task is blocked on AskUserQuestion. Mirrors
     *  `TaskStatus.waiting_for_input`. Optional for back-compat with API
     *  responses that omit zero-count buckets. */
    waiting_for_input?: number;
    pending_approval?: number;
    rate_limited?: number;
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
