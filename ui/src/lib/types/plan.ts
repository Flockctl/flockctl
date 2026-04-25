// --- Planning hierarchy enums ---

export const MilestoneStatus = {
  pending: "pending",
  planning: "planning",
  active: "active",
  completed: "completed",
} as const;
export type MilestoneStatus =
  (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export const SliceStatus = {
  pending: "pending",
  planning: "planning",
  active: "active",
  verifying: "verifying",
  merging: "merging",
  completed: "completed",
  skipped: "skipped",
  failed: "failed",
} as const;
export type SliceStatus = (typeof SliceStatus)[keyof typeof SliceStatus];

export const PlanTaskStatus = {
  pending: "pending",
  active: "active",
  completed: "completed",
  failed: "failed",
} as const;
export type PlanTaskStatus =
  (typeof PlanTaskStatus)[keyof typeof PlanTaskStatus];

// --- Milestone ---

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  vision: string | null;
  success_criteria: string[] | null;
  depends_on: string[] | null;
  order_index: number;
  key_risks?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MilestoneCreate {
  title: string;
  description?: string | null;
  vision?: string | null;
  success_criteria?: string[] | null;
  depends_on?: string[] | null;
  order_index?: number;
}

export interface MilestoneUpdate {
  title?: string | null;
  description?: string | null;
  status?: MilestoneStatus | null;
  vision?: string | null;
  success_criteria?: string[] | null;
  depends_on?: string[] | null;
  order_index?: number | null;
}

// --- PlanSlice ---

export interface PlanSlice {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  status: SliceStatus;
  risk: string;
  depends: string[] | null;
  demo: string | null;
  goal: string | null;
  success_criteria: string | null;
  proof_level?: string | null;
  threat_surface?: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface PlanSliceCreate {
  title: string;
  description?: string | null;
  risk?: string;
  depends?: string[] | null;
  demo?: string | null;
  goal?: string | null;
  success_criteria?: string | null;
  order_index?: number;
}

export interface PlanSliceUpdate {
  title?: string | null;
  description?: string | null;
  status?: SliceStatus | null;
  risk?: string | null;
  depends?: string[] | null;
  demo?: string | null;
  goal?: string | null;
  success_criteria?: string | null;
  order_index?: number | null;
}

// --- PlanTask ---

export interface PlanTask {
  id: string;
  slice_id: string;
  title: string;
  description: string | null;
  model: string | null;
  status: PlanTaskStatus;
  estimate: string | null;
  files: string[] | null;
  verify: string | null;
  inputs: string[] | null;
  expected_output: string[] | null;
  task_id: string | null;
  order_index: number;
  output: string | null;
  summary: Record<string, unknown> | null;
  verification_passed: boolean | null;
  verification_output: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanTaskCreate {
  title: string;
  description?: string | null;
  model?: string | null;
  estimate?: string | null;
  files?: string[] | null;
  verify?: string | null;
  inputs?: string[] | null;
  expected_output?: string[] | null;
  task_id?: string | null;
  order_index?: number;
}

export interface PlanTaskUpdate {
  title?: string | null;
  description?: string | null;
  model?: string | null;
  status?: PlanTaskStatus | null;
  estimate?: string | null;
  files?: string[] | null;
  verify?: string | null;
  inputs?: string[] | null;
  expected_output?: string[] | null;
  task_id?: string | null;
  order_index?: number | null;
  output?: string | null;
  summary?: Record<string, unknown> | null;
  verification_passed?: boolean | null;
  verification_output?: string | null;
}

// --- Planning tree responses ---

export interface PlanSliceTree extends PlanSlice {
  tasks: PlanTask[];
}

export interface MilestoneTree extends Milestone {
  slices: PlanSliceTree[];
}

// --- Activation / Auto-execution ---

export interface ActivateRequest {
  agent?: string | null;
}

export interface ActivateResponse {
  slice_id: string;
  status: string;
  dispatched: number;
  queued: number;
}

export interface AutoExecuteRequest {
  agent?: string | null;
}

export interface AutoExecuteResponse {
  status: string;
  milestone_id: string;
  current_slice_ids: string[];
}

export interface AutoExecuteStatusResponse {
  status: string;
  milestone_id: string;
  current_slice_ids: string[];
  started_at: string | null;
  completed_slices: number;
  total_slices: number;
}

// --- Execution Graph ---

export interface ExecutionWave {
  wave_index: number;
  slice_ids: string[];
  slices: PlanSlice[];
}

export interface ExecutionGraphResponse {
  milestone_id: string;
  waves: ExecutionWave[];
  critical_path: string[];
  errors: string[];
  parallelism_factor: number;
  slice_workers: Record<string, string[]>;
}

// --- Plan generation ---

export interface GeneratePlanRequest {
  prompt: string;
  mode: "quick" | "deep";
  /** Optional — when omitted the daemon picks by priority + project/workspace allow-list. */
  aiProviderKeyId?: number | null;
  /** Optional model override — when omitted the task falls back to the project/global default. */
  model?: string | null;
}

export interface GeneratePlanResponse {
  task_id: string;
}

export interface GeneratePlanStatus {
  generating: boolean;
  task_id?: number;
  status?: string;
  mode?: "quick" | "deep" | null;
  started_at?: string | null;
  created_at?: string | null;
}
