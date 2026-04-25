import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchTemplates,
  fetchTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  type TemplateFilter,
  type TemplateRef,
} from "../api";
import type {
  PaginatedResponse,
  TaskTemplate,
  TaskTemplateCreate,
} from "../types";
import { queryKeys } from "./core";

// --- Template hooks ---

export function useTemplates(
  offset = 0,
  limit = 50,
  filter: TemplateFilter = {},
  options?: Partial<UseQueryOptions<PaginatedResponse<TaskTemplate>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.templates, { offset, limit, ...filter }],
    queryFn: () => fetchTemplates(offset, limit, filter),
    ...options,
  });
}

export function useTemplate(
  ref: TemplateRef | null,
  options?: Partial<UseQueryOptions<TaskTemplate>>,
) {
  return useQuery({
    queryKey: ref
      ? [...queryKeys.templates, "one", ref.scope, ref.workspaceId ?? "", ref.projectId ?? "", ref.name]
      : [...queryKeys.templates, "one", "disabled"],
    queryFn: () => fetchTemplate(ref!),
    enabled: !!ref,
    ...options,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TaskTemplateCreate) => createTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ref,
      data,
    }: {
      ref: TemplateRef;
      data: Partial<Omit<TaskTemplateCreate, "name" | "scope" | "workspace_id" | "project_id">>;
    }) => updateTemplate(ref, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ref: TemplateRef) => deleteTemplate(ref),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates });
    },
  });
}
