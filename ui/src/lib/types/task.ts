import type { PermissionMode } from "./permission";

// --- Enums (const objects — TS 6 erasableSyntaxOnly forbids enum keyword) ---

export const TaskStatus = {
  queued: "queued",
  assigned: "assigned",
  running: "running",
  pending_approval: "pending_approval",
  done: "done",
  failed: "failed",
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
  assigned: number;
  running: number;
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
}

/** Composite client-side key used for React `key` and cache entries. */
export function templateKey(t: { scope: TemplateScope; name: string; workspace_id?: string | null; project_id?: string | null }): string {
  return `${t.scope}:${t.workspace_id ?? ""}:${t.project_id ?? ""}:${t.name}`;
}
