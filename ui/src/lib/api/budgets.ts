import { apiFetch } from "./core";

// --- Budget Limits ---

export interface BudgetSummaryItem {
  id: number;
  scope: string;
  scope_id: number | null;
  period: string;
  limit_usd: number;
  spent_usd: number;
  percent_used: number;
  action: string;
}

export function fetchBudgets(): Promise<BudgetSummaryItem[]> {
  return apiFetch("/usage/budgets");
}

/** Row returned by POST /usage/budgets (mirrors the Drizzle `budgetLimits` row). */
export interface BudgetLimitRow {
  id: number;
  scope: string;
  scopeId: number | null;
  period: string;
  limitUsd: number;
  action: string;
  createdAt: string;
  updatedAt: string | null;
  isActive?: boolean;
}

export function createBudget(data: {
  scope: string;
  scope_id?: number | null;
  period: string;
  limit_usd: number;
  action?: string;
}): Promise<BudgetLimitRow> {
  return apiFetch("/usage/budgets", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateBudget(id: number, data: {
  limit_usd?: number;
  action?: string;
  is_active?: boolean;
}): Promise<{ ok: boolean }> {
  return apiFetch(`/usage/budgets/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteBudget(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/usage/budgets/${id}`, { method: "DELETE" });
}
