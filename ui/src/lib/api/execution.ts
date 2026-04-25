import type {
  ExecutionGraphResponse,
  ProjectExecutionOverviewResponse,
} from "../types";
import { apiFetch } from "./core";

// --- Execution Graph ---

export function fetchExecutionGraph(
  projectId: string,
  milestoneId: string,
): Promise<ExecutionGraphResponse> {
  return apiFetch<ExecutionGraphResponse>(
    `/projects/${projectId}/milestones/${milestoneId}/execution-graph`,
  );
}

export function fetchProjectExecutionOverview(
  projectId: string,
): Promise<ProjectExecutionOverviewResponse> {
  return apiFetch<ProjectExecutionOverviewResponse>(
    `/projects/${projectId}/execution-overview`,
  );
}
