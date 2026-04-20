import type { Context } from "hono";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export function paginationParams(c: Context): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 20)));
  return { page, perPage, offset: (page - 1) * perPage };
}
