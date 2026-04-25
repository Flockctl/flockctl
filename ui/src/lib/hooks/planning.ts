import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  createMilestone,
  deleteMilestone,
  updateMilestone,
  createSlice,
  deleteSlice,
  updateSlice,
  createPlanTask,
  deletePlanTask,
  updatePlanTask,
  activateSlice,
  startAutoExecute,
  stopAutoExecute,
  generatePlan,
  fetchGeneratePlanStatus,
} from "../api";
import type {
  MilestoneCreate,
  MilestoneUpdate,
  PlanSliceCreate,
  PlanSliceUpdate,
  PlanTaskCreate,
  PlanTaskUpdate,
  ActivateRequest,
  AutoExecuteRequest,
  GeneratePlanRequest,
  GeneratePlanStatus,
} from "../types";
import { queryKeys } from "./core";

export function useCreateMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MilestoneCreate) => createMilestone(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useGeneratePlan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: GeneratePlanRequest) => generatePlan(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.generatePlanStatus(projectId),
      });
    },
  });
}

export function useGeneratePlanStatus(
  projectId: string,
  options?: Partial<UseQueryOptions<GeneratePlanStatus>>,
) {
  return useQuery<GeneratePlanStatus>({
    queryKey: queryKeys.generatePlanStatus(projectId),
    queryFn: () => fetchGeneratePlanStatus(projectId),
    refetchInterval: (query) =>
      query.state.data?.generating ? 3_000 : 15_000,
    ...options,
  });
}

export function useDeleteMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) =>
      deleteMilestone(projectId, milestoneId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdateMilestone(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data: MilestoneUpdate;
    }) => updateMilestone(projectId, milestoneId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useCreateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data: PlanSliceCreate;
    }) => createSlice(projectId, milestoneId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useDeleteSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
    }: {
      milestoneId: string;
      sliceId: string;
    }) => deleteSlice(projectId, milestoneId, sliceId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data: PlanSliceUpdate;
    }) => updateSlice(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useCreatePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data: PlanTaskCreate;
    }) => createPlanTask(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useDeletePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      taskId,
    }: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
    }) => deletePlanTask(projectId, milestoneId, sliceId, taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useUpdatePlanTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      taskId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      taskId: string;
      data: PlanTaskUpdate;
    }) => updatePlanTask(projectId, milestoneId, sliceId, taskId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useActivateSlice(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      sliceId,
      data,
    }: {
      milestoneId: string;
      sliceId: string;
      data?: ActivateRequest;
    }) => activateSlice(projectId, milestoneId, sliceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}

export function useStartAutoExecute(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      milestoneId,
      data,
    }: {
      milestoneId: string;
      data?: AutoExecuteRequest;
    }) => startAutoExecute(projectId, milestoneId, data),
    onSuccess: (_result, { milestoneId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
      });
    },
  });
}

export function useStopAutoExecute(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) =>
      stopAutoExecute(projectId, milestoneId),
    onSuccess: (_result, milestoneId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
      });
    },
  });
}
