import type { PermissionMode } from "./permission";

// --- Enums (const objects — TS 6 erasableSyntaxOnly forbids enum keyword) ---

export const TaskStatus = {
  queued: "queued",
  running: "running",
  /**
   * Suspend state: task emitted an AskUserQuestion and is blocked awaiting a
   * human answer. Backend transitions: running → waiting_for_input → running
   * (on answer) | cancelled | timed_out. UI renders a "needs answer" badge.
   *
   * Added to the enum to fix a UI/backend desync — previously the runtime
   * value flowed through but TypeScript had no entry for it, so type-aware
   * branches (status badges, kanban filters) silently fell through to the
   * "unknown" arm.
   */
  waiting_for_input: "waiting_for_input",
  pending_approval: "pending_approval",
  /** Parked due to a provider rate-limit / usage-limit. Will auto-resume at
   *  `resume_at` via the daemon's rate-limit scheduler. The UI renders a
   *  countdown badge in this state. */
  rate_limited: "rate_limited",
  done: "done",
  failed: "failed",
  /**
   * User-initiated abort (DELETE /tasks/:id) or the cancellation arm of a
   * `waiting_for_input` task. Terminal — only `cancelled → queued` is allowed
   * (rerun) per `TASK_STATUS_TRANSITIONS`.
   *
   * Same desync fix as `waiting_for_input`: the runtime value was already
   * flowing in payloads (`task_status` WebSocket frames, `tasks` list rows)
   * but the enum didn't expose it, so type-aware UI code lacked a stable
   * symbol to reference.
   */
  cancelled: "cancelled",
  timed_out: "timed_out",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// --- Task ---

/** Minimal task reference used for rerun-chain siblings on GET /tasks/:id. */
export interface TaskChainChild {
  id: string;
  status: TaskStatus;
  label: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string | null;
  prompt_file: string | null;
  agent: string | null;
  model: string | null;
  /**
   * Model that was actually used by the AI provider during execution, taken
   * from the most recent `usage_records` row for this task. NULL when the
   * task has not produced a usage record yet (queued / failed before first
   * turn / provider doesn't report usage). Use this in preference to
   * `model` when surfacing what really ran.
   */
  actual_model_used: string | null;
  /**
   * Total USD cost for this task, summed across every `usage_records` row
   * tied to it. The API computes `COALESCE(SUM(total_cost_usd), 0)` so this
   * is always a number — `0` for tasks that never produced usage (queued,
   * failed before first turn, providers that don't report usage). Use this
   * for the COST column in finished tasks; `liveMetrics.total_cost_usd`
   * is only populated while a worker is actively streaming.
   */
  cost_usd?: number;
  timeout_seconds: number;
  project_id: string | null;
  assigned_key_id: number | null;
  assigned_key_label: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  working_dir: string | null;
  created_at: string;
  updated_at: string;
  liveMetrics?: TaskMetrics;
  git_commit_before: string | null;
  git_commit_after: string | null;
  git_diff_summary: string | null;
  requires_approval: boolean;
  approval_status: string | null;
  approved_at: string | null;
  approval_note: string | null;
  permission_mode: PermissionMode | null;
  /** Parent task id when this task was produced by a rerun (manual or auto-retry). */
  parent_task_id: string | null;
  /** Reruns spawned from this task. Only populated by `GET /tasks/:id`. */
  children?: TaskChainChild[];
  /**
   * Unix-epoch milliseconds when the rate-limit scheduler will wake this task
   * back up. Populated only while `status === 'rate_limited'`; null otherwise.
   * The countdown badge subtracts this from `Date.now()` once per second.
   */
  resume_at?: number | null;
  /**
   * Isolation mode requested at task creation time. `'worktree'` means
   * the executor materialises a per-task git worktree under
   * `<project>/.flockctl/worktrees/task-<id>/` before launching the
   * agent. NULL = legacy shared-cwd behaviour. See migration 0060.
   */
  isolation?: "worktree" | null;
  /**
   * Absolute path to the per-task git worktree, populated by the
   * executor once the worktree has been materialised. NULL until then,
   * NULL again after a clean cleanup; non-NULL while the worktree is
   * still on disk (clean cleanup happens on success terminals; dirty
   * worktrees survive for operator review).
   */
  worktree_path?: string | null;
  /**
   * Branch name created with the worktree (`flockctl/task-<id>`).
   * NULL iff `worktree_path` is NULL.
   */
  worktree_branch?: string | null;
}

export interface TaskFilters {
  status?: TaskStatus;
  agent?: string;
  created_after?: string;
  created_before?: string;
  project_id?: string;
  /**
   * Include failed/timed_out rows whose rerun chain already landed on a
   * successful terminal state. Backend default is `false` (hidden) — the
   * list-view toggle flips this to `true` when operators want to audit the
   * full history.
   */
  include_superseded?: boolean;
}

export interface TaskCreate {
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  working_dir?: string | null;
  env_vars?: Record<string, string> | null;
  project_id?: string | null;
  timeout_seconds?: number;
  assigned_key_id?: number | null;
  permission_mode?: PermissionMode | null;
  /**
   * Opt-in isolation mode. Currently only `'worktree'` is supported —
   * see migration 0060. Omit / null = legacy shared-cwd behaviour.
   */
  isolation?: "worktree" | null;
}

export interface TaskUpdate {
  permission_mode?: PermissionMode | null;
}

export interface TaskLog {
  id: string;
  task_id: string;
  content: string;
  stream_type: string;
  timestamp: string;
}

export interface TaskMetrics {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: number;
  turns: number;
  duration_ms: number;
}

// --- Task Stats ---

export interface TaskStats {
  total: number;
  queued: number;
  /**
   * @deprecated Always 0 — the backend's `GET /tasks/stats` initialises
   * this key for backward compatibility (the FSM never produces an
   * `assigned` row), so the field is kept on the wire-format type to
   * match the API response, but no UI code branches on it. New code
   * MUST NOT read `stats.assigned`.
   */
  assigned: number;
  running: number;
  /**
   * Tasks blocked on AskUserQuestion. Mirrors `TaskStatus.waiting_for_input`.
   * Backend reports the count under this key when at least one task is in
   * the suspend state; absent (i.e. `undefined`) when none are. Kept
   * optional so older API responses (pre-status-FSM) don't break the type.
   */
  waiting_for_input?: number;
  pending_approval?: number;
  rate_limited?: number;
  completed: number;
  done: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  /** Failed tasks that have *any* rerun child (manual or auto-retry). */
  failed_rerun: number;
  /** Failed tasks without any rerun child — still broken. */
  failed_not_rerun: number;
  /** Failed/timed_out whose rerun chain reached a `done`/`completed` state. */
  superseded_failures: number;
  /** Successful (`done`/`completed`) tasks that are themselves a rerun — the build-after-rerun metric. */
  build_after_rerun: number;
  avg_duration_seconds: number | null;
}

// --- TaskTemplate ---
// Templates are file-backed (see `src/services/templates.ts` on the backend):
//   ~/flockctl/templates/<name>.json              — global
//   <workspace>/.flockctl/templates/<name>.json   — workspace
//   <project>/.flockctl/templates/<name>.json     — project
// Identity is (scope, name) + optional workspace_id/project_id; there is no
// numeric id. `assigned_key_id` has moved onto `Schedule` — one template can
// be reused with different AI keys per schedule.

export type TemplateScope = "global" | "workspace" | "project";

export interface TaskTemplate {
  name: string;
  scope: TemplateScope;
  workspace_id?: string | null;
  project_id?: string | null;
  description: string | null;
  agent: string | null;
  model: string | null;
  prompt: string | null;
  working_dir: string | null;
  env_vars: Record<string, string> | null;
  timeout_seconds: number | null;
  label_selector: string | null;
  image: string | null;
  /**
   * Default isolation mode applied to every task spawned from this
   * template (manual or scheduled). Persisted in the template JSON
   * file under `<scope>/.flockctl/templates/<name>.json`. Currently
   * only `'worktree'` is supported. NULL = legacy behaviour.
   */
  isolation?: "worktree" | null;
  source_path: string;
  created_at: string;
  updated_at: string;
}

export interface TaskTemplateCreate {
  name: string;
  scope: TemplateScope;
  /** Required when scope = 'workspace'. */
  workspace_id?: string | null;
  /** Required when scope = 'project'. */
  project_id?: string | null;
  description?: string | null;
  agent?: string | null;
  model?: string | null;
  prompt?: string | null;
  working_dir?: string | null;
  env_vars?: Record<string, string> | null;
  timeout_seconds?: number | null;
  label_selector?: string | null;
  image?: string | null;
  /** Opt-in default isolation for tasks spawned from this template. */
  isolation?: "worktree" | null;
}

/** Composite client-side key used for React `key` and cache entries. */
export function templateKey(t: { scope: TemplateScope; name: string; workspace_id?: string | null; project_id?: string | null }): string {
  return `${t.scope}:${t.workspace_id ?? ""}:${t.project_id ?? ""}:${t.name}`;
}
