import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "../api";
import { queryKeys } from "./core";

// --- Budget hooks ---

export function useBudgets() {
  return useQuery({
    queryKey: queryKeys.budgets,
    queryFn: fetchBudgets,
  });
}

export function useCreateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { scope: string; scope_id?: number | null; period: string; limit_usd: number; action?: string }) =>
      createBudget(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}

export function useUpdateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { limit_usd?: number; action?: string; is_active?: boolean } }) =>
      updateBudget(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}

export function useDeleteBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteBudget(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets });
    },
  });
}
