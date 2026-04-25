import type { Skill, DisableEntry } from "../types";
import { apiFetch } from "./core";

// --- Skills ---

/** Shape returned by POST /skills/{global|workspace|project} on success. */
export type SkillSaveResponse = {
  name: string;
  level: "global" | "workspace" | "project";
  saved: true;
};

/** Shape returned by DELETE /skills/* on success. */
export type SkillDeleteResponse = { deleted: true };

export function fetchGlobalSkills(): Promise<Skill[]> {
  return apiFetch("/skills/global");
}

export function fetchWorkspaceSkills(workspaceId: string): Promise<Skill[]> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills`);
}

export function fetchProjectSkills(workspaceId: string, projectId: string): Promise<Skill[]> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills`);
}

export function createGlobalSkill(
  data: { name: string; content: string },
): Promise<SkillSaveResponse> {
  return apiFetch("/skills/global", { method: "POST", body: JSON.stringify(data) });
}

export function createWorkspaceSkill(
  workspaceId: string,
  data: { name: string; content: string },
): Promise<SkillSaveResponse> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills`, { method: "POST", body: JSON.stringify(data) });
}

export function createProjectSkill(
  workspaceId: string,
  projectId: string,
  data: { name: string; content: string },
): Promise<SkillSaveResponse> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteWorkspaceSkill(
  workspaceId: string,
  name: string,
): Promise<SkillDeleteResponse> {
  return apiFetch(`/skills/workspaces/${workspaceId}/skills/${name}`, { method: "DELETE" });
}

export function deleteProjectSkill(
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<SkillDeleteResponse> {
  return apiFetch(`/skills/workspaces/${workspaceId}/projects/${projectId}/skills/${name}`, { method: "DELETE" });
}

// --- Skill disable lists ---

export function fetchWorkspaceDisabledSkills(workspaceId: string): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`);
}

export function disableWorkspaceSkill(workspaceId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableWorkspaceSkill(workspaceId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/workspaces/${workspaceId}/disabled`, { method: "DELETE", body: JSON.stringify(entry) });
}

export function fetchProjectDisabledSkills(projectId: string): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`);
}

export function disableProjectSkill(projectId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableProjectSkill(projectId: string, entry: DisableEntry): Promise<{ disabled_skills: DisableEntry[] }> {
  return apiFetch(`/skills/projects/${projectId}/disabled`, { method: "DELETE", body: JSON.stringify(entry) });
}
