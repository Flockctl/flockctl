import type {
  ProjectTree,
  Milestone,
  MilestoneCreate,
  MilestoneUpdate,
  PlanSlice,
  PlanSliceCreate,
  PlanSliceUpdate,
  PlanTask,
  PlanTaskCreate,
  PlanTaskUpdate,
  ActivateResponse,
  ActivateRequest,
  AutoExecuteResponse,
  AutoExecuteRequest,
  AutoExecuteStatusResponse,
  GeneratePlanRequest,
  GeneratePlanResponse,
  GeneratePlanStatus,
} from "../types";
import { apiFetch } from "./core";

// --- Project Tree ---

export function fetchProjectTree(projectId: string): Promise<ProjectTree> {
  return apiFetch<ProjectTree>(`/projects/${projectId}/tree`);
}

export function generatePlan(
  projectId: string,
  data: GeneratePlanRequest,
): Promise<GeneratePlanResponse> {
  return apiFetch<GeneratePlanResponse>(
    `/projects/${projectId}/generate-plan`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
}

export function fetchGeneratePlanStatus(
  projectId: string,
): Promise<GeneratePlanStatus> {
  return apiFetch<GeneratePlanStatus>(
    `/projects/${projectId}/generate-plan/status`,
  );
}

// --- Milestones ---

export function createMilestone(
  projectId: string,
  data: MilestoneCreate,
): Promise<Milestone> {
  return apiFetch<Milestone>(`/projects/${projectId}/milestones`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteMilestone(
  projectId: string,
  milestoneId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}`,
    { method: "DELETE" },
  );
}

export function updateMilestone(
  projectId: string,
  milestoneId: string,
  data: MilestoneUpdate,
): Promise<Milestone> {
  return apiFetch<Milestone>(
    `/projects/${projectId}/milestones/${milestoneId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Slices ---

export function createSlice(
  projectId: string,
  milestoneId: string,
  data: PlanSliceCreate,
): Promise<PlanSlice> {
  return apiFetch<PlanSlice>(
    `/projects/${projectId}/milestones/${milestoneId}/slices`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function deleteSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}`,
    { method: "DELETE" },
  );
}

export function updateSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data: PlanSliceUpdate,
): Promise<PlanSlice> {
  return apiFetch<PlanSlice>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Plan Tasks ---

export function createPlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data: PlanTaskCreate,
): Promise<PlanTask> {
  return apiFetch<PlanTask>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function deletePlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<void> {
  return apiFetch<void>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks/${taskId}`,
    { method: "DELETE" },
  );
}

export function updatePlanTask(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  data: PlanTaskUpdate,
): Promise<PlanTask> {
  return apiFetch<PlanTask>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/tasks/${taskId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// --- Execution ---

export function activateSlice(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  data?: ActivateRequest,
): Promise<ActivateResponse> {
  return apiFetch<ActivateResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/slices/${sliceId}/activate`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );
}

export function startAutoExecute(
  projectId: string,
  milestoneId: string,
  data?: AutoExecuteRequest,
): Promise<AutoExecuteResponse> {
  return apiFetch<AutoExecuteResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
    { method: "POST", body: JSON.stringify(data ?? {}) },
  );
}

export function stopAutoExecute(
  projectId: string,
  milestoneId: string,
): Promise<AutoExecuteResponse> {
  return apiFetch<AutoExecuteResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
    { method: "DELETE" },
  );
}

export function fetchAutoExecStatus(
  projectId: string,
  milestoneId: string,
): Promise<AutoExecuteStatusResponse> {
  return apiFetch<AutoExecuteStatusResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/auto-execute`,
  );
}

// --- Plan File Content ---

export function fetchPlanFile(
  projectId: string,
  params: { type: string; milestone?: string; slice?: string; task?: string },
): Promise<{ content: string; path: string }> {
  const qs = new URLSearchParams();
  qs.set("type", params.type);
  if (params.milestone) qs.set("milestone", params.milestone);
  if (params.slice) qs.set("slice", params.slice);
  if (params.task) qs.set("task", params.task);
  return apiFetch<{ content: string; path: string }>(
    `/projects/${projectId}/plan-file?${qs.toString()}`,
  );
}

export function updatePlanFile(
  projectId: string,
  data: { type: string; milestone?: string; slice?: string; task?: string; content: string },
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/projects/${projectId}/plan-file`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function fetchMilestoneReadme(
  projectId: string,
  milestoneSlug: string,
): Promise<{ content: string; path: string }> {
  return apiFetch<{ content: string; path: string }>(
    `/projects/${projectId}/milestones/${milestoneSlug}/readme`,
  );
}

// --- Auto-Execute All ---

export function startAutoExecuteAll(
  projectId: string,
): Promise<{ status: string; milestones: string[] }> {
  return apiFetch<{ status: string; milestones: string[] }>(
    `/projects/${projectId}/auto-execute-all`,
    { method: "POST", body: JSON.stringify({}) },
  );
}
