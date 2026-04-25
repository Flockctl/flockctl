import type {
  PaginatedResponse,
  TaskTemplate,
  TaskTemplateCreate,
  TemplateScope,
} from "../types";
import { apiFetch } from "./core";

export interface TemplateFilter {
  scope?: TemplateScope;
  workspaceId?: string;
  projectId?: string;
}

export interface TemplateRef {
  scope: TemplateScope;
  name: string;
  workspaceId?: string | null;
  projectId?: string | null;
}

function scopeQuery(filter: TemplateFilter): string {
  const parts: string[] = [];
  if (filter.scope) parts.push(`scope=${encodeURIComponent(filter.scope)}`);
  if (filter.workspaceId) parts.push(`workspace_id=${encodeURIComponent(filter.workspaceId)}`);
  if (filter.projectId) parts.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  return parts.join("&");
}

function refQuery(ref: Pick<TemplateRef, "workspaceId" | "projectId">): string {
  const parts: string[] = [];
  if (ref.workspaceId) parts.push(`workspace_id=${encodeURIComponent(ref.workspaceId)}`);
  if (ref.projectId) parts.push(`project_id=${encodeURIComponent(ref.projectId)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function fetchTemplates(
  offset = 0,
  limit = 50,
  filter: TemplateFilter = {},
): Promise<PaginatedResponse<TaskTemplate>> {
  const base = `/templates?offset=${offset}&limit=${limit}`;
  const extra = scopeQuery(filter);
  return apiFetch(extra ? `${base}&${extra}` : base);
}

export function fetchTemplate(ref: TemplateRef): Promise<TaskTemplate> {
  return apiFetch(
    `/templates/${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.name)}${refQuery(ref)}`,
  );
}

export function createTemplate(
  data: TaskTemplateCreate,
): Promise<TaskTemplate> {
  return apiFetch("/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTemplate(
  ref: TemplateRef,
  data: Partial<Omit<TaskTemplateCreate, "name" | "scope" | "workspace_id" | "project_id">>,
): Promise<TaskTemplate> {
  return apiFetch(
    `/templates/${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.name)}${refQuery(ref)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
}

export function deleteTemplate(ref: TemplateRef): Promise<void> {
  return apiFetch(
    `/templates/${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.name)}${refQuery(ref)}`,
    { method: "DELETE" },
  );
}
