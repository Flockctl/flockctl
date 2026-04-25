import type { PermissionMode } from "./permission";
import type { Project, ProjectTree } from "./project";
import type { MilestoneStatus } from "./plan";

// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  path: string;
  allowed_key_ids: number[] | null;
  // ─── Gitignore toggles (backend migration 0038) ───
  // See `Project.gitignore_*` — identical semantics and defaults.
  gitignore_flockctl: boolean;
  gitignore_todo: boolean;
  gitignore_agents_md: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceConfig {
  permissionMode?: PermissionMode | null;
  disabledSkills?: string[];
  disabledMcpServers?: string[];
}

export interface WorkspaceCreate {
  name: string;
  path?: string;
  description?: string | null;
  repoUrl?: string | null;
  permission_mode?: PermissionMode | null;
  /**
   * IDs of active AI-provider keys this workspace is allowed to use.
   * Required at creation time — must contain at least one active key.
   * See src/routes/_allowed-keys.ts for the exact backend contract.
   */
  allowed_key_ids: number[];
  // ─── Gitignore toggles — optional on create (default false server-side) ───
  gitignore_flockctl?: boolean;
  gitignore_todo?: boolean;
  gitignore_agents_md?: boolean;
}

export interface WorkspaceUpdate {
  name?: string | null;
  description?: string | null;
  /**
   * Updated allow-list. When present, must be a non-empty array of
   * active AI-provider key IDs — the server rejects `null` / `[]` with
   * 422 to prevent the create-time mandatory-keys gate from being
   * circumvented. Omit the field to leave the existing allow-list alone.
   */
  allowed_key_ids?: number[];
  permission_mode?: PermissionMode | null;
  // ─── Gitignore toggles — omitted fields are left unchanged on the server ───
  gitignore_flockctl?: boolean;
  gitignore_todo?: boolean;
  gitignore_agents_md?: boolean;
}

export interface WorkspaceProject {
  id: string;
  workspace_id: string;
  project_id: string;
  added_at: string;
}

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

// --- Workspace Dependency Graph ---

export interface WorkspaceMilestoneNode {
  milestone_id: string;
  title: string;
  project_id: string;
  project_name: string;
  status: MilestoneStatus;
  depends_on: string[];
}

export interface WorkspaceDependencyGraph {
  workspace_id: string;
  nodes: WorkspaceMilestoneNode[];
  waves: string[][];
  errors: string[];
}

// --- Workspace Dashboard ---

export interface WorkspaceProjectSummary {
  project_id: string;
  project_name: string;
  milestone_count: number;
  active_milestone_count: number;
  completed_milestone_count: number;
  total_slices: number;
  active_slices: number;
  completed_slices: number;
  failed_slices: number;
  running_tasks: number;
  queued_tasks: number;
  tree: ProjectTree;
}

export interface WorkspaceDashboard {
  workspace_id: string;
  workspace_name: string;
  project_summaries: WorkspaceProjectSummary[];
  total_projects: number;
  total_milestones: number;
  active_milestones: number;
  total_slices: number;
  active_slices: number;
  completed_slices: number;
  running_tasks: number;
  queued_tasks: number;
  // Cost data (from Phase 0D)
  project_count: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  pending_milestones: number;
  active_milestones_count: number;
  completed_milestones: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_by_project: Array<{ project_id: string; project_name: string; cost_usd: number }>;
  recent_activity: Array<{ type: string; entity_id: number; title: string; timestamp: string }>;
}
