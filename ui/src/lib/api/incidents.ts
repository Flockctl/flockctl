import type { PaginatedResponse } from "../types";
import { apiFetch } from "./core";

// --- Incidents ---
// Post-mortem / knowledge-base records. See src/routes/incidents.ts for the
// full CRUD surface. Here we expose just what the chat UI needs: extract a
// draft from a chat transcript, create a new incident, and fetch the distinct
// set of tags used (typeahead source).

export interface IncidentDraft {
  title: string;
  symptom: string;
  root_cause: string;
  resolution: string;
  tags: string[];
}

export interface IncidentResponse {
  id: string;
  title: string;
  symptom: string | null;
  root_cause: string | null;
  resolution: string | null;
  tags: string[] | null;
  project_id: string | null;
  created_by_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExtractIncidentResponse {
  draft: IncidentDraft;
  project_id: string | null;
}

/**
 * Kick off the LLM-backed "extract post-mortem fields" pass on a chat. Pass a
 * subset of `messageIds` to restrict the transcript the extractor sees.
 * Always resolves — the backend returns an empty draft rather than an error
 * when extraction fails or no API keys are configured.
 */
export function extractIncidentFromChat(
  chatId: string,
  data?: { messageIds?: number[]; skipExtract?: boolean },
): Promise<ExtractIncidentResponse> {
  return apiFetch<ExtractIncidentResponse>(`/chats/${chatId}/extract-incident`, {
    method: "POST",
    body: JSON.stringify(data ?? {}),
  });
}

export function createIncident(data: {
  title: string;
  symptom?: string | null;
  rootCause?: string | null;
  resolution?: string | null;
  tags?: string[];
  projectId?: number | null;
  createdByChatId?: number | null;
}): Promise<IncidentResponse> {
  return apiFetch<IncidentResponse>("/incidents", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function fetchIncidentTags(projectId?: string): Promise<{ tags: string[] }> {
  const qs = new URLSearchParams();
  if (projectId) qs.set("projectId", projectId);
  const suffix = qs.toString();
  return apiFetch<{ tags: string[] }>(`/incidents/tags${suffix ? `?${suffix}` : ""}`);
}

export function fetchIncident(id: string): Promise<IncidentResponse> {
  return apiFetch<IncidentResponse>(`/incidents/${id}`);
}

export function fetchIncidents(
  page = 1,
  perPage = 50,
): Promise<PaginatedResponse<IncidentResponse>> {
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  return apiFetch<PaginatedResponse<IncidentResponse>>(`/incidents?${qs.toString()}`);
}

export function updateIncident(
  id: string,
  data: {
    title?: string;
    symptom?: string | null;
    rootCause?: string | null;
    resolution?: string | null;
    tags?: string[];
    projectId?: number | null;
    createdByChatId?: number | null;
  },
): Promise<IncidentResponse> {
  return apiFetch<IncidentResponse>(`/incidents/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteIncident(id: string): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/incidents/${id}`, { method: "DELETE" });
}
